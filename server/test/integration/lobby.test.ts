import { afterEach, describe, expect, it } from "vitest";
import { CARDS_PER_DECK, CARD_BACKS, DEFAULT_BACK, HAND_SIZE, MAX_PLAYERS } from "@cambio/shared";
import { harness, startGame, type Harness } from "./harness.js";

let h: Harness;
afterEach(async () => {
  await h?.close();
});

describe("creating and joining a table", () => {
  it("hands the creator a room code, a player id, and a session token", async () => {
    h = await harness();
    const host = await h.connect();
    host.send({ t: "room.create", name: "Ana" });
    const hello = await host.next("hello");

    expect(hello.code).toMatch(/^[A-Z2-9]{6}$/);
    expect(hello.playerId).toBeTruthy();
    expect(hello.token).toBeTruthy();
  });

  it("uses a code alphabet with no ambiguous characters", async () => {
    h = await harness();
    for (let i = 0; i < 12; i++) {
      const client = await h.connect();
      client.send({ t: "room.create", name: `P${i}` });
      const hello = await client.next("hello");
      // O/0 and I/1 are excluded so a code can be read aloud.
      expect(hello.code).not.toMatch(/[O0I1]/);
    }
  });

  it("shows every player to everyone at the table", async () => {
    h = await harness();
    const { clients } = await h.table(["Ana", "Bo", "Cy"]);

    for (const client of clients) {
      const view = await client.waitForState((v) => v.players.length === 3);
      expect(view.players.map((p) => p.name)).toEqual(["Ana", "Bo", "Cy"]);
      expect(view.phase).toBe("lobby");
    }
  });

  it("makes the creator the host and nobody else", async () => {
    h = await harness();
    const { clients } = await h.table(["Ana", "Bo"]);
    const view = await clients[1]!.waitForState((v) => v.players.length === 2);

    expect(view.players.filter((p) => p.isHost).map((p) => p.name)).toEqual(["Ana"]);
  });

  it("tells each player which seat is theirs", async () => {
    h = await harness();
    const { clients } = await h.table(["Ana", "Bo"]);

    const anaView = await clients[0]!.waitForState((v) => v.players.length === 2);
    const boView = await clients[1]!.waitForState((v) => v.players.length === 2);
    expect(anaView.you).toBe(clients[0]!.playerId);
    expect(boView.you).toBe(clients[1]!.playerId);
    expect(anaView.you).not.toBe(boView.you);
  });

  it("accepts a lowercase room code", async () => {
    h = await harness();
    const { code } = await h.table(["Ana"]);

    const bo = await h.connect();
    bo.send({ t: "room.join", code: code.toLowerCase(), name: "Bo" });
    await bo.next("hello");
    expect(bo.code).toBe(code);
  });

  it("rejects an unknown room code", async () => {
    h = await harness();
    const client = await h.connect();
    client.send({ t: "room.join", code: "ZZZZZZ", name: "Ana" });

    const error = await client.next("error");
    expect(error.code).toBe("roomNotFound");
  });

  it("rejects a duplicate name at the same table", async () => {
    h = await harness();
    const { code } = await h.table(["Ana"]);

    const impostor = await h.connect();
    impostor.send({ t: "room.join", code, name: "ana" });
    const error = await impostor.next("error");
    expect(error.code).toBe("nameTaken");
  });

  it("rejects a join once the table is full", async () => {
    h = await harness();
    const names = Array.from({ length: MAX_PLAYERS }, (_, i) => `P${i}`);
    const { code } = await h.table(names);

    const extra = await h.connect();
    extra.send({ t: "room.join", code, name: "Latecomer" });
    const error = await extra.next("error");
    expect(error.code).toBe("roomFull");
  });

  it("rejects a join once the game has started", async () => {
    h = await harness();
    const { clients, code } = await h.table(["Ana", "Bo"]);
    await startGame(clients);

    const latecomer = await h.connect();
    latecomer.send({ t: "room.join", code, name: "Cy" });
    const error = await latecomer.next("error");
    expect(error.code).toBe("gameAlreadyStarted");
  });

  it("gives one connection exactly one seat", async () => {
    // The old server minted a second player id here and orphaned the first.
    h = await harness();
    const host = await h.connect();
    host.send({ t: "room.create", name: "Ana" });
    await host.next("hello");

    host.send({ t: "room.create", name: "Ana Again" });
    const error = await host.next("error");
    expect(error.code).toBe("illegalAction");

    const view = await host.waitForState(() => true);
    expect(view.players).toHaveLength(1);
  });

  it("answers a malformed message with an error rather than dropping the socket", async () => {
    h = await harness();
    const client = await h.connect();
    client.send({ t: "nonsense" } as never);

    const error = await client.next("error");
    expect(error.code).toBe("malformed");
  });
});

describe("starting the game", () => {
  it("deals every player a hand and seeds the discard pile", async () => {
    h = await harness();
    const { clients } = await h.table(["Ana", "Bo"]);
    clients[0]!.send({ t: "lobby.start" });

    const view = await clients[0]!.waitForState((v) => v.phase === "study");
    expect(view.players.every((p) => p.slots.length === 4)).toBe(true);
    expect(view.discardTop).not.toBeNull(); // a snap is legal from move one
    expect(view.deckCount).toBe(54 - 2 * 4 - 1);
  });

  it("only lets the host start", async () => {
    h = await harness();
    const { clients } = await h.table(["Ana", "Bo"]);
    clients[1]!.send({ t: "lobby.start" });

    const error = await clients[1]!.next("error");
    expect(error.code).toBe("notHost");
  });

  it("refuses to start a one-player table", async () => {
    h = await harness();
    const { clients } = await h.table(["Ana"]);
    clients[0]!.send({ t: "lobby.start" });

    const error = await clients[0]!.next("error");
    expect(error.code).toBe("notEnoughPlayers");
  });

  it("lets each player study the configured number of their own cards", async () => {
    h = await harness();
    const { clients } = await h.table(["Ana", "Bo"]);
    clients[0]!.send({ t: "lobby.start" });
    await clients[0]!.waitForState((v) => v.phase === "study");

    clients[0]!.act({ a: "initialPeek", slot: 2 });
    const first = await clients[0]!.next("card.revealed");
    expect(first.ownerId).toBe(clients[0]!.playerId);

    clients[0]!.act({ a: "initialPeek", slot: 3 });
    await clients[0]!.next("card.revealed");

    clients[0]!.act({ a: "initialPeek", slot: 2 });
    const error = await clients[0]!.next("error");
    expect(error.code).toBe("illegalAction");
  });

  it("plays with one pack unless the host says otherwise", async () => {
    h = await harness();
    const { clients } = await h.table(["Ana", "Bo"]);
    const view = await clients[1]!.waitForState((v) => v.players.length === 2);
    expect(view.decks).toBe(1);
  });

  it("lets the host choose the number of packs, and shows it to everyone", async () => {
    h = await harness();
    const { clients } = await h.table(["Ana", "Bo"]);
    await clients[1]!.waitForState((v) => v.players.length === 2);

    clients[0]!.send({ t: "lobby.decks", decks: 3 });

    for (const client of clients) {
      const view = await client.waitForState((v) => v.decks === 3);
      expect(view.decks).toBe(3);
    }
  });

  it("deals from every chosen pack once the round starts", async () => {
    h = await harness();
    const { clients } = await h.table(["Ana", "Bo"]);
    await clients[1]!.waitForState((v) => v.players.length === 2);

    clients[0]!.send({ t: "lobby.decks", decks: 2 });
    await clients[0]!.waitForState((v) => v.decks === 2);
    clients[0]!.send({ t: "lobby.start" });

    const view = await clients[0]!.waitForState((v) => v.phase === "study");
    // Two packs, less the dealt hands and the card turned up to seed the pile.
    expect(view.deckCount).toBe(2 * CARDS_PER_DECK - 2 * HAND_SIZE - 1);
  });

  it("keeps the chosen pack count for the next round at the same table", async () => {
    h = await harness();
    const { clients } = await h.table(["Ana", "Bo"]);
    await clients[1]!.waitForState((v) => v.players.length === 2);

    clients[0]!.send({ t: "lobby.decks", decks: 2 });
    await clients[0]!.waitForState((v) => v.decks === 2);
    clients[0]!.send({ t: "lobby.start" });

    const view = await clients[0]!.waitForState((v) => v.phase === "study");
    expect(view.decks).toBe(2);
  });

  it("lets nobody but the host change the packs", async () => {
    h = await harness();
    const { clients } = await h.table(["Ana", "Bo"]);
    await clients[1]!.waitForState((v) => v.players.length === 2);

    clients[1]!.send({ t: "lobby.decks", decks: 3 });
    const error = await clients[1]!.next("error");
    expect(error.code).toBe("notHost");
    expect(clients[1]!.latestState()?.decks).toBe(1);
  });

  it("refuses a pack count outside the range on offer", async () => {
    h = await harness();
    const { clients } = await h.table(["Ana", "Bo"]);
    await clients[1]!.waitForState((v) => v.players.length === 2);

    for (const decks of [0, 4, 2.5]) {
      clients[0]!.send({ t: "lobby.decks", decks });
      const error = await clients[0]!.next("error");
      expect(error.code, String(decks)).toBe("malformed");
    }
    expect(clients[0]!.latestState()?.decks).toBe(1);
  });

  it("refuses to change the packs once the round is under way", async () => {
    h = await harness();
    const { clients } = await h.table(["Ana", "Bo"]);
    clients[0]!.send({ t: "lobby.start" });
    await clients[0]!.waitForState((v) => v.phase === "study");

    clients[0]!.send({ t: "lobby.decks", decks: 3 });
    const error = await clients[0]!.next("error");
    expect(error.code).toBe("illegalAction");
    expect(clients[0]!.latestState()?.decks).toBe(1);
  });

  it("starts on the default card back", async () => {
    h = await harness();
    const { clients } = await h.table(["Ana", "Bo"]);
    const view = await clients[1]!.waitForState((v) => v.players.length === 2);
    expect(view.back).toBe(DEFAULT_BACK);
  });

  it("lets the host choose the card back, and deals it to everyone", async () => {
    h = await harness();
    const { clients } = await h.table(["Ana", "Bo"]);
    await clients[1]!.waitForState((v) => v.players.length === 2);

    const wanted = CARD_BACKS[3]!.id;
    clients[0]!.send({ t: "lobby.back", back: wanted });

    for (const client of clients) {
      const view = await client.waitForState((v) => v.back === wanted);
      expect(view.back).toBe(wanted);
    }
  });

  it("keeps the chosen back once the round is under way", async () => {
    h = await harness();
    const { clients } = await h.table(["Ana", "Bo"]);
    await clients[1]!.waitForState((v) => v.players.length === 2);

    const wanted = CARD_BACKS[2]!.id;
    clients[0]!.send({ t: "lobby.back", back: wanted });
    await clients[0]!.waitForState((v) => v.back === wanted);
    clients[0]!.send({ t: "lobby.start" });

    const view = await clients[0]!.waitForState((v) => v.phase === "study");
    expect(view.back).toBe(wanted);
  });

  it("lets the host restyle the cards mid-round - it gives nothing away", async () => {
    h = await harness();
    const { clients } = await h.table(["Ana", "Bo"]);
    clients[0]!.send({ t: "lobby.start" });
    await clients[0]!.waitForState((v) => v.phase === "study");

    const wanted = CARD_BACKS[5]!.id;
    clients[0]!.send({ t: "lobby.back", back: wanted });
    const view = await clients[1]!.waitForState((v) => v.back === wanted);
    expect(view.back).toBe(wanted);
  });

  it("lets nobody but the host change the cards", async () => {
    h = await harness();
    const { clients } = await h.table(["Ana", "Bo"]);
    await clients[1]!.waitForState((v) => v.players.length === 2);

    clients[1]!.send({ t: "lobby.back", back: CARD_BACKS[1]!.id });
    const error = await clients[1]!.next("error");
    expect(error.code).toBe("notHost");
    expect(clients[1]!.latestState()?.back).toBe(DEFAULT_BACK);
  });

  it("refuses a card back that does not exist", async () => {
    h = await harness();
    const { clients } = await h.table(["Ana", "Bo"]);
    await clients[1]!.waitForState((v) => v.players.length === 2);

    clients[0]!.send({ t: "lobby.back", back: "../secrets" });
    const error = await clients[0]!.next("error");
    expect(error.code).toBe("malformed");
    expect(clients[0]!.latestState()?.back).toBe(DEFAULT_BACK);
  });

  it("begins play only once everyone is ready", async () => {
    h = await harness();
    const { clients } = await h.table(["Ana", "Bo"]);
    clients[0]!.send({ t: "lobby.start" });
    await clients[0]!.waitForState((v) => v.phase === "study");

    clients[0]!.act({ a: "readyUp" });
    const stillStudying = await clients[0]!.waitForState(() => true);
    expect(stillStudying.phase).toBe("study");

    clients[1]!.act({ a: "readyUp" });
    const playing = await clients[0]!.waitForState((v) => v.phase === "awaitingAction");
    expect(playing.turnPlayerId).toBe(clients[0]!.playerId);
  });
});

describe("kicking", () => {
  it("removes the player and tells them why", async () => {
    h = await harness();
    const { clients } = await h.table(["Ana", "Bo", "Cy"]);
    const [ana, bo] = clients;

    ana!.send({ t: "lobby.kick", playerId: bo!.playerId });

    const kicked = await bo!.next("kicked");
    expect(kicked.reason).toMatch(/host/i);

    const view = await ana!.waitForState((v) => v.players.length === 2);
    expect(view.players.map((p) => p.name)).toEqual(["Ana", "Cy"]);
  });

  it("stops a kicked player resuming back in with their old token", async () => {
    h = await harness();
    const { clients } = await h.table(["Ana", "Bo"]);
    const [ana, bo] = clients;
    const stolenToken = bo!.token;

    ana!.send({ t: "lobby.kick", playerId: bo!.playerId });
    await bo!.next("kicked");

    const sneaky = await h.connect();
    sneaky.send({ t: "room.resume", token: stolenToken });
    const error = await sneaky.next("error");
    expect(error.code).toBe("sessionInvalid");
  });

  it("only lets the host kick", async () => {
    h = await harness();
    const { clients } = await h.table(["Ana", "Bo", "Cy"]);

    clients[1]!.send({ t: "lobby.kick", playerId: clients[2]!.playerId });
    const error = await clients[1]!.next("error");
    expect(error.code).toBe("notHost");
  });

  it("will not let the host kick themselves", async () => {
    h = await harness();
    const { clients } = await h.table(["Ana", "Bo"]);

    clients[0]!.send({ t: "lobby.kick", playerId: clients[0]!.playerId });
    const error = await clients[0]!.next("error");
    expect(error.code).toBe("illegalAction");
  });

  it("rejects kicking someone who is not at the table", async () => {
    h = await harness();
    const { clients } = await h.table(["Ana", "Bo"]);

    clients[0]!.send({ t: "lobby.kick", playerId: "nobody" });
    const error = await clients[0]!.next("error");
    expect(error.code).toBe("badTarget");
  });
});

describe("leaving", () => {
  it("frees the seat immediately when a player leaves on purpose", async () => {
    h = await harness();
    const { clients } = await h.table(["Ana", "Bo"]);

    clients[1]!.send({ t: "room.leave" });
    const view = await clients[0]!.waitForState((v) => v.players.length === 1);
    expect(view.players.map((p) => p.name)).toEqual(["Ana"]);
  });

  it("promotes a new host when the host leaves, so the table is never stuck", async () => {
    h = await harness();
    const { clients } = await h.table(["Ana", "Bo", "Cy"]);

    clients[0]!.send({ t: "room.leave" });
    const view = await clients[1]!.waitForState((v) => v.players.length === 2);

    expect(view.players.find((p) => p.isHost)?.name).toBe("Bo");
  });

  it("lets the promoted host actually start the game", async () => {
    h = await harness();
    const { clients } = await h.table(["Ana", "Bo", "Cy"]);
    clients[0]!.send({ t: "room.leave" });
    await clients[1]!.waitForState((v) => v.players.length === 2);

    clients[1]!.send({ t: "lobby.start" });
    const view = await clients[1]!.waitForState((v) => v.phase === "study");
    expect(view.phase).toBe("study");
  });

  it("closes the room once the last player leaves", async () => {
    h = await harness();
    const { clients, code } = await h.table(["Ana"]);

    clients[0]!.send({ t: "room.leave" });
    await clients[0]!.waitForState(() => true).catch(() => undefined);

    // Give the server a tick to tear the room down, then confirm it is gone.
    await new Promise((resolve) => setTimeout(resolve, 20));
    const latecomer = await h.connect();
    latecomer.send({ t: "room.join", code, name: "Bo" });
    const error = await latecomer.next("error");
    expect(error.code).toBe("roomNotFound");
  });
});

describe("acting before joining", () => {
  it("rejects a game action from a socket with no seat", async () => {
    h = await harness();
    const client = await h.connect();
    client.act({ a: "drawDeck" });

    const error = await client.next("error");
    expect(error.code).toBe("sessionInvalid");
  });

  it("rejects a start from a socket with no seat", async () => {
    h = await harness();
    const client = await h.connect();
    client.send({ t: "lobby.start" });

    const error = await client.next("error");
    expect(error.code).toBe("sessionInvalid");
  });
});
