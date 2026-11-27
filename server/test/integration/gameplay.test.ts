import { afterEach, describe, expect, it } from "vitest";
import type { GameView } from "@cambio/shared";
import { harness, settled, settledAfter, startGame, type Harness, type TestClient } from "./harness.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let h: Harness;
afterEach(async () => {
  await h?.close();
});

/** Play the current player's turn with the least eventful legal move. */
async function takeSafeTurn(clients: TestClient[]): Promise<void> {
  // Always decide from a converged view: a stale one names the wrong player.
  const view = await settled(clients);
  if (view.phase === "finished") return;
  if (view.turnPlayerId === null) throw new Error("no turn in progress");

  const actor = clients.find((c) => c.playerId === view.turnPlayerId);
  if (!actor) throw new Error("the current player has no client");

  actor.act({ a: "drawDeck" });
  const holding = await actor.waitForState((v) => v.phase === "holdingCard" || v.phase === "finished");
  if (holding.phase === "finished") return;

  actor.act({ a: "discardDrawn" });
  const after = await actor.waitForState((v) => v.phase !== "holdingCard");

  // A discarded power card has to be resolved before the turn can pass - and
  // at this table it cannot be declined, so the driver plays it out.
  if (after.pendingPower !== null) {
    const others = clients.filter((c) => c.playerId !== actor.playerId);
    const other = others[0]!;
    switch (after.pendingPower) {
      case "peekOwn":
        actor.act({ a: "peekOwn", slot: 0 });
        break;
      case "peekOther":
        actor.act({ a: "peekOther", playerId: other.playerId, slot: 0 });
        break;
      case "freeSwap":
        actor.act({ a: "freeSwap", aId: actor.playerId, aSlot: 0, bId: actor.playerId, bSlot: 1 });
        break;
      case "king":
        actor.act({ a: "peekOther", playerId: other.playerId, slot: 0 });
        await actor.waitForState((v) => v.kingPeeked || v.pendingPower === null);
        actor.act({ a: "freeSwap", aId: actor.playerId, aSlot: 0, bId: actor.playerId, bSlot: 1 });
        break;
    }
    await actor.waitForState((v) => v.pendingPower === null);
  }
}

describe("refreshing the page", () => {
  it("returns the player to their seat with the same identity", async () => {
    h = await harness();
    const { clients } = await h.table(["Ana", "Bo"]);
    const [ana] = clients;
    await startGame(clients);

    const token = ana!.token;
    const playerId = ana!.playerId;
    const before = ana!.latestState();

    ana!.kill(); // a closed tab, with no clean close frame
    const reborn = await h.connect();
    reborn.send({ t: "room.resume", token });
    const hello = await reborn.next("hello");

    expect(hello.playerId).toBe(playerId);
    const after = await reborn.waitForState(() => true);
    expect(after.you).toBe(playerId);
    expect(after.players.map((p) => p.name)).toEqual(before?.players.map((p) => p.name));
  });

  it("restores the board exactly as it was", async () => {
    h = await harness();
    const { clients } = await h.table(["Ana", "Bo"]);
    const [ana, bo] = clients;
    await startGame(clients);
    await takeSafeTurn(clients); // make the state non-trivial

    const before = await bo!.waitForState((v) => v.turnPlayerId === bo!.playerId);
    const token = bo!.token;

    bo!.kill();
    const reborn = await h.connect();
    reborn.send({ t: "room.resume", token });
    await reborn.next("hello");
    const after = await reborn.waitForState(() => true);

    expect(after.phase).toBe(before.phase);
    expect(after.turnPlayerId).toBe(before.turnPlayerId);
    expect(after.deckCount).toBe(before.deckCount);
    expect(after.discardTop?.id).toBe(before.discardTop?.id);
    expect(after.players.map((p) => p.slots.length)).toEqual(before.players.map((p) => p.slots.length));
    void ana;
  });

  it("still hides what it should after a refresh", async () => {
    // A reload must not become a way to see more than you had earned.
    h = await harness();
    const { clients } = await h.table(["Ana", "Bo"]);
    const [ana] = clients;
    await startGame(clients);

    const token = ana!.token;
    ana!.kill();
    const reborn = await h.connect();
    reborn.send({ t: "room.resume", token });
    await reborn.next("hello");
    const view = await reborn.waitForState(() => true);

    for (const player of view.players) {
      for (const slot of player.slots) {
        expect(slot.kind, `${player.name} slot`).not.toBe("up");
      }
    }
  });

  it("marks a dropped player as disconnected to everyone else", async () => {
    h = await harness();
    const { clients } = await h.table(["Ana", "Bo"]);
    const [ana, bo] = clients;
    await startGame(clients);

    ana!.kill();
    const view = await bo!.waitForState((v) => v.players.some((p) => !p.connected));
    expect(view.players.find((p) => p.name === "Ana")?.connected).toBe(false);
  });

  it("marks them connected again once they resume", async () => {
    h = await harness();
    const { clients } = await h.table(["Ana", "Bo"]);
    const [ana, bo] = clients;
    await startGame(clients);

    const token = ana!.token;
    ana!.kill();
    await bo!.waitForState((v) => v.players.some((p) => !p.connected));

    const reborn = await h.connect();
    reborn.send({ t: "room.resume", token });
    await reborn.next("hello");

    const view = await bo!.waitForState((v) => v.players.every((p) => p.connected));
    expect(view.players.every((p) => p.connected)).toBe(true);
  });

  it("rejects a token the server never issued", async () => {
    h = await harness();
    await h.table(["Ana", "Bo"]);

    const stranger = await h.connect();
    stranger.send({ t: "room.resume", token: "not-a-real-token" });
    const error = await stranger.next("error");
    expect(error.code).toBe("sessionInvalid");
  });

  /**
   * A seat in a round is held to the end of it, with no clock on it at all.
   * Losing a game to a flaky connection is the worst thing this can do to
   * somebody, so it does not: the turn order steps over the empty chair and
   * waits.
   */
  it("holds a seat for the whole round, however long the player is gone", async () => {
    h = await harness({ graceMs: { lobby: 60 } });
    const { clients } = await h.table(["Ana", "Bo", "Cy"]);
    const [ana, bo] = clients;
    await startGame(clients);

    ana!.kill();

    const view = await bo!.waitForState((v) => v.players.some((p) => !p.connected), 3_000);
    expect(view.players.map((p) => p.name)).toEqual(["Ana", "Bo", "Cy"]);

    // Well past what used to be the grace period, and the seat is still hers.
    await sleep(300);
    expect(bo!.latestState()?.players.map((p) => p.name)).toEqual(["Ana", "Bo", "Cy"]);
  });

  /**
   * And she can walk back into it with nothing but the code and her name,
   * which is all a player has after clearing their storage or picking up a
   * different device.
   */
  it("lets a dropped player back into their seat by name", async () => {
    h = await harness();
    const { clients, code } = await h.table(["Ana", "Bo"]);
    const [ana, bo] = clients;
    await startGame(clients);

    ana!.kill();
    await bo!.waitForState((v) => v.players.some((p) => !p.connected), 3_000);

    const reborn = await h.connect();
    reborn.send({ t: "room.join", code, name: "Ana" });
    const hello = await reborn.next("hello");

    // The same seat, not a new one beside it.
    const view = await reborn.waitForState((v) => v.players.every((p) => p.connected), 3_000);
    expect(view.players.map((p) => p.name)).toEqual(["Ana", "Bo"]);
    expect(hello.playerId).toBe(ana!.playerId);
  });

  it("refuses to hand over a seat somebody is still sitting in", async () => {
    h = await harness();
    const { clients, code } = await h.table(["Ana", "Bo"]);
    await startGame(clients);

    const impostor = await h.connect();
    impostor.send({ t: "room.join", code, name: "Ana" });
    const error = await impostor.next("error");
    expect(error.code).toBe("nameTaken");
  });

  it("gives up a lobby seat once its grace period expires", async () => {
    h = await harness({ graceMs: { lobby: 60 } });
    const { clients } = await h.table(["Ana", "Bo", "Cy"]);
    const [ana, bo] = clients;

    const token = ana!.token;
    ana!.kill();

    const view = await bo!.waitForState((v) => v.players.length === 2, 3_000);
    expect(view.players.map((p) => p.name)).toEqual(["Bo", "Cy"]);

    // The token dies with the seat, so the old tab cannot reclaim it.
    const tooLate = await h.connect();
    tooLate.send({ t: "room.resume", token });
    const error = await tooLate.next("error");
    expect(error.code).toBe("sessionInvalid");
  });
});

describe("hidden information", () => {
  /**
   * The guarantee the whole view layer exists for: across every byte a player
   * was ever sent, no card face appears that they were not entitled to.
   */
  function assertNothingLeaked(client: TestClient, states: GameView[]): void {
    for (const view of states) {
      if (view.phase === "finished") continue; // everything is revealed at the end
      for (const player of view.players) {
        for (const slot of player.slots) {
          expect(
            slot.kind,
            `${client.playerId} was shown ${player.name}'s card during phase ${view.phase}`,
          ).not.toBe("up");
        }
        /*
         * And the handles a slot is named by must give nothing away either.
         * The real ids spell the card out - `S7` is the seven of spades - so
         * sending them would hand over the table's hands to anyone who
         * opened a console, whatever the faces said.
         */
        for (const slot of player.slots) {
          if (slot.kind !== "gap") expect(slot.id).toMatch(/^c\d+$/);
        }
      }
    }
  }

  it("never sends any player another player's card over a whole round", async () => {
    h = await harness();
    const { clients } = await h.table(["Ana", "Bo", "Cy"]);
    await startGame(clients);

    for (let turn = 0; turn < 6; turn++) {
      const current = await settled(clients);
      if (current.phase === "finished") break;
      await takeSafeTurn(clients);
    }

    for (const client of clients) {
      assertNothingLeaked(client, client.allStates());
    }
  });

  it("never sends a player their own card either, outside a peek", async () => {
    // Not knowing your own hand is the point of Cambio.
    h = await harness();
    const { clients } = await h.table(["Ana", "Bo"]);
    clients[0]!.send({ t: "lobby.start" });
    await clients[0]!.waitForState((v) => v.phase === "study");

    const view = clients[0]!.latestState();
    const me = view?.players.find((p) => p.id === clients[0]!.playerId);
    expect(me?.slots.every((s) => s.kind !== "up")).toBe(true);
  });

  it("sends a studied card only to the player who studied it", async () => {
    h = await harness();
    const { clients } = await h.table(["Ana", "Bo"]);
    const [ana, bo] = clients;
    ana!.send({ t: "lobby.start" });
    await Promise.all(clients.map((c) => c.waitForState((v) => v.phase === "study")));

    ana!.act({ a: "initialPeek", slot: 1 });
    const revealed = await ana!.next("card.revealed");

    expect(revealed.ownerId).toBe(ana!.playerId);
    expect(bo!.eventsOfType("card.revealed")).toHaveLength(0);
  });

  it("shows a drawn card to the drawer alone", async () => {
    h = await harness();
    const { clients } = await h.table(["Ana", "Bo"]);
    const [ana, bo] = clients;
    await startGame(clients);

    ana!.act({ a: "drawDeck" });
    const anaView = await ana!.waitForState((v) => v.phase === "holdingCard");
    const boView = await bo!.waitForState((v) => v.phase === "holdingCard");

    expect(anaView.heldCard).not.toBeNull();
    expect(boView.heldCard).toBeNull();
  });

  it("reveals every hand once the round is over", async () => {
    h = await harness();
    const { clients } = await h.table(["Ana", "Bo"]);
    await startGame(clients);

    const before = (await settled(clients)).version;
    clients[0]!.act({ a: "callCambio" });
    // Wait for the call to actually land, or the next turn targets the caller.
    await settledAfter(clients, before);
    await takeSafeTurn(clients);

    const view = await clients[0]!.waitForState((v) => v.phase === "finished", 3_000);
    for (const player of view.players) {
      expect(player.slots.every((s) => s.kind === "up")).toBe(true);
      expect(player.score).not.toBeNull();
    }
  });
});

describe("playing a round through to the end", () => {
  it("reaches a settled score with a winner everyone agrees on", async () => {
    h = await harness();
    const { clients } = await h.table(["Ana", "Bo", "Cy"]);
    await startGame(clients);

    // A few ordinary turns, then someone calls it.
    for (let turn = 0; turn < 3; turn++) await takeSafeTurn(clients);

    const view = await settled(clients);
    const caller = clients.find((c) => c.playerId === view.turnPlayerId);
    caller!.act({ a: "callCambio" });
    await settledAfter(clients, view.version);

    // Everyone else takes their final turn.
    for (let turn = 0; turn < 3; turn++) {
      const current = await settled(clients);
      if (current.phase === "finished") break;
      await takeSafeTurn(clients);
    }

    const over = await clients[0]!.next("game.over", 4_000);
    expect(over.scores).toHaveLength(3);
    expect(over.winnerId).toBeTruthy();

    // Every client must agree on the result.
    for (const client of clients) {
      const final = await client.waitForState((v) => v.phase === "finished", 3_000);
      expect(final.winnerId).toBe(over.winnerId);
      const scores = final.players.map((p) => p.score);
      expect(scores.every((s) => s !== null)).toBe(true);
    }
  });

  /**
   * Play again goes back to the lobby rather than straight into a deal.
   * Between rounds is when a table changes its mind - another pack, a
   * different back, somebody joining or going - and it is where a player who
   * dropped last round gets picked back up.
   */
  it("takes the table back to the lobby when someone plays again", async () => {
    h = await harness();
    const { clients } = await h.table(["Ana", "Bo"]);
    await startGame(clients);

    const before = (await settled(clients)).version;
    clients[0]!.act({ a: "callCambio" });
    await settledAfter(clients, before);
    await takeSafeTurn(clients);
    await clients[0]!.waitForState((v) => v.phase === "finished", 3_000);

    clients[0]!.send({ t: "lobby.restart" });

    // Same seats, no hands, and last round's scores cleared away.
    const fresh = await clients[0]!.waitForState((v) => v.phase === "lobby", 3_000);
    expect(fresh.players.map((p) => p.name)).toEqual(["Ana", "Bo"]);
    expect(fresh.players.every((p) => p.slots.length === 0)).toBe(true);
    expect(fresh.players.every((p) => p.score === null)).toBe(true);
    expect(fresh.players.every((p) => !p.calledCambio)).toBe(true);
    expect(fresh.winnerId).toBeNull();

    // And the host can deal again from there.
    clients[0]!.send({ t: "lobby.start" });
    const dealt = await clients[0]!.waitForState((v) => v.phase === "study", 3_000);
    expect(dealt.players.every((p) => p.slots.length === 4)).toBe(true);
    for (const player of dealt.players) {
      expect(player.slots.every((s) => s.kind !== "up")).toBe(true);
    }
  });

  /**
   * Anyone may do it, not just the host. The round is over, so there is
   * nothing left to disrupt - and a table whose host has wandered off should
   * not be stuck staring at a scoreboard for ever.
   */
  it("lets a player who is not the host play again", async () => {
    h = await harness();
    const { clients } = await h.table(["Ana", "Bo"]);
    await startGame(clients);

    const before = (await settled(clients)).version;
    clients[0]!.act({ a: "callCambio" });
    await settledAfter(clients, before);
    await takeSafeTurn(clients);
    await clients[1]!.waitForState((v) => v.phase === "finished", 3_000);

    clients[1]!.send({ t: "lobby.restart" });
    const fresh = await clients[1]!.waitForState((v) => v.phase === "lobby", 3_000);
    expect(fresh.players.map((p) => p.name)).toEqual(["Ana", "Bo"]);
  });

  it("refuses to play again mid-round", async () => {
    h = await harness();
    const { clients } = await h.table(["Ana", "Bo"]);
    await startGame(clients);

    clients[0]!.send({ t: "lobby.restart" });
    const error = await clients[0]!.next("error");
    expect(error.code).toBe("illegalAction");
  });

  it("refuses an action from the player whose turn it is not", async () => {
    h = await harness();
    const { clients } = await h.table(["Ana", "Bo"]);
    await startGame(clients);

    clients[1]!.act({ a: "drawDeck" });
    const error = await clients[1]!.next("error");
    expect(error.code).toBe("notYourTurn");
  });

  it("keeps the deck and discard counts consistent for everyone", async () => {
    h = await harness();
    const { clients } = await h.table(["Ana", "Bo"]);
    await startGame(clients);
    await takeSafeTurn(clients);
    await settled(clients);

    const views = clients.map((c) => c.latestState());
    const [first, ...rest] = views;
    for (const view of rest) {
      expect(view.deckCount).toBe(first!.deckCount);
      expect(view.discardCount).toBe(first!.discardCount);
      expect(view.discardTop?.id).toBe(first!.discardTop?.id);
    }
  });
});
