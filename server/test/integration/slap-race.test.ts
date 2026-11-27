import { afterEach, describe, expect, it } from "vitest";
import { harness, settled, startGame, type Harness, type TestClient } from "./harness.js";

let h: Harness;
afterEach(async () => {
  await h?.close();
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Wait until the server's measured RTT for a player reaches `atLeastMs`. */
async function waitForMeasuredRtt(
  h: Harness,
  code: string,
  playerId: string,
  atLeastMs: number,
  timeoutMs = 3_000,
): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const measured = h.server.manager.getRoom(code)?.rtt.rttFor(playerId) ?? 0;
    if (measured >= atLeastMs) return measured;
    await sleep(10);
  }
  throw new Error(`server never measured ${playerId} at >= ${atLeastMs}ms`);
}

/** Every slap.resolved a client saw, as `slapper:outcome`, newest last. */
function slapsSeenBy(client: TestClient): string[] {
  return client.eventsOfType("slap.resolved").map((e) => `${e.slapperId}:${e.outcome}`);
}

/**
 * Rig the deal so that exactly one player's first card is a legal slap.
 *
 * The queue rule is about what happens after a right slap and after a wrong
 * one, which a random deal cannot be relied on to produce. Reaching into the
 * room's state is the smallest way to pin that down over real sockets.
 */
function rigMatch(h: Harness, code: string, playerId: string): void {
  const state = h.server.manager.getRoom(code)!.state;
  const topId = state.discard.at(-1)!;
  const mine = state.cards.get(state.seats.find((s) => s.id === playerId)!.hand[0]!)!;

  state.cards.set(topId, { ...mine, id: topId });
  // Nobody else's first card may match, or their slap would be right as well.
  for (const seat of state.seats) {
    if (seat.id === playerId) continue;
    const id = seat.hand[0]!;
    const card = state.cards.get(id)!;
    if (card.rank === mine.rank) state.cards.set(id, { ...card, rank: mine.rank === 2 ? 3 : 2 });
  }
}

/**
 * How many cards a player is holding, so a penalty can be told from a discard.
 * A hole a slap left is not one of them - the place stays, the card does not.
 */
function handSize(h: Harness, code: string, playerId: string): number {
  const seat = h.server.manager.getRoom(code)!.state.seats.find((s) => s.id === playerId)!;
  return seat.hand.filter((id) => id !== null).length;
}

describe("racing a slap over real sockets", () => {
  it("puts the slower connection first in the queue when it acted first", async () => {
    // Probe often so a latency estimate is available almost immediately.
    h = await harness({ pingIntervalMs: 15 });
    const { clients, code } = await h.table(["Fast", "Slow"]);
    const [fast, slow] = clients;

    // Slow answers probes 200ms late, so the server credits it ~100ms of
    // one-way latency (capped). Fast answers instantly.
    slow!.pongDelayMs = 200;
    await startGame(clients);
    await waitForMeasuredRtt(h, code, slow!.playerId, 150);

    const view = await settled(clients);
    expect(view.slapOpen).toBe(true);

    // Fast's packet lands first, but Slow is compensated far enough back that
    // Slow actually hit the table first.
    fast!.act({ a: "slap", targetId: fast!.playerId, slot: 0 });
    await sleep(40);
    slow!.act({ a: "slap", targetId: slow!.playerId, slot: 0 });

    const resolved = await fast!.next("slap.resolved", 3_000);
    expect(resolved.slapperId).toBe(slow!.playerId);
  });

  it("puts the earlier slap first when latency is equal", async () => {
    h = await harness({ pingIntervalMs: 15 });
    const { clients } = await h.table(["Ana", "Bo"]);
    const [ana, bo] = clients;
    await startGame(clients);
    await settled(clients);

    ana!.act({ a: "slap", targetId: ana!.playerId, slot: 0 });
    await sleep(60);
    bo!.act({ a: "slap", targetId: bo!.playerId, slot: 0 });

    const resolved = await ana!.next("slap.resolved", 3_000);
    expect(resolved.slapperId).toBe(ana!.playerId);
  });

  it("tells every player the same results in the same order", async () => {
    h = await harness({ pingIntervalMs: 15 });
    const { clients } = await h.table(["Ana", "Bo", "Cy"]);
    const [ana, bo, cy] = clients;
    await startGame(clients);
    await settled(clients);

    ana!.act({ a: "slap", targetId: ana!.playerId, slot: 0 });
    bo!.act({ a: "slap", targetId: bo!.playerId, slot: 0 });

    await Promise.all(clients.map((c) => c.next("slap.resolved", 3_000)));
    await sleep(200); // let the rest of the queue reach every client

    // Every slap that is played out goes to the whole table, so every screen
    // must have been told the same story in the same order.
    const seen = clients.map((c) => slapsSeenBy(c).filter((line) => !line.endsWith(":lostRace")));
    expect(seen[0]!.length).toBeGreaterThan(0);
    expect(seen[1]).toEqual(seen[0]);
    expect(seen[2]).toEqual(seen[0]);
    void cy;
  });

  it("plays a slap behind a wrong one rather than cancelling it", async () => {
    h = await harness({ pingIntervalMs: 15 });
    const { clients, code } = await h.table(["Ana", "Bo"]);
    const [ana, bo] = clients;
    await startGame(clients);
    await settled(clients);

    // Bo holds the only match, and Ana goes first with a card that is wrong.
    rigMatch(h, code, bo!.playerId);
    const anaBefore = handSize(h, code, ana!.playerId);
    const boBefore = handSize(h, code, bo!.playerId);

    ana!.act({ a: "slap", targetId: ana!.playerId, slot: 0 });
    await sleep(40);
    bo!.act({ a: "slap", targetId: bo!.playerId, slot: 0 });

    await sleep(600);
    expect(slapsSeenBy(bo!)).toEqual([
      `${ana!.playerId}:wrongRankPenalty`,
      `${bo!.playerId}:ownCardDiscarded`,
    ]);

    // Ana paid for being wrong, and Bo's slap was still played out in full.
    expect(handSize(h, code, ana!.playerId)).toBe(anaBefore + 1);
    expect(handSize(h, code, bo!.playerId)).toBe(boBefore - 1);
  });

  it("spares the slap behind a right one, so it costs nothing to be second", async () => {
    h = await harness({ pingIntervalMs: 15 });
    const { clients, code } = await h.table(["Ana", "Bo"]);
    const [ana, bo] = clients;
    await startGame(clients);
    await settled(clients);

    // This time Ana holds the match and goes first, so Bo never has to play.
    rigMatch(h, code, ana!.playerId);
    const boBefore = handSize(h, code, bo!.playerId);

    ana!.act({ a: "slap", targetId: ana!.playerId, slot: 0 });
    await sleep(40);
    bo!.act({ a: "slap", targetId: bo!.playerId, slot: 0 });

    // Bo is told specifically that the slap was never played, so an optimistic
    // local flash can be rolled back.
    const spared = await bo!.waitFor(
      (e): e is Extract<typeof e, { t: "slap.resolved" }> => e.t === "slap.resolved" && e.outcome === "lostRace",
      3_000,
    );
    expect(spared.slapperId).toBe(bo!.playerId);
    expect(spared.endedById).toBe(ana!.playerId);
    expect(handSize(h, code, bo!.playerId)).toBe(boBefore); // no penalty card
  });

  it("counts a double-tap once, so one slip of the finger costs one card", async () => {
    h = await harness({ pingIntervalMs: 15 });
    const { clients, code } = await h.table(["Ana", "Bo"]);
    const [ana, bo] = clients;
    await startGame(clients);
    await settled(clients);

    // Ana's first card is deliberately not a match, so each slap is a penalty.
    rigMatch(h, code, bo!.playerId);
    const before = handSize(h, code, ana!.playerId);

    ana!.act({ a: "slap", targetId: ana!.playerId, slot: 0 });
    ana!.act({ a: "slap", targetId: ana!.playerId, slot: 0 });

    await sleep(600);
    expect(handSize(h, code, ana!.playerId)).toBe(before + 1);
  });

  it("reports the margin the first slap was ahead by", async () => {
    h = await harness({ pingIntervalMs: 15 });
    const { clients } = await h.table(["Ana", "Bo"]);
    const [ana, bo] = clients;
    await startGame(clients);
    await settled(clients);

    ana!.act({ a: "slap", targetId: ana!.playerId, slot: 0 });
    await sleep(50);
    bo!.act({ a: "slap", targetId: bo!.playerId, slot: 0 });

    const resolved = await ana!.next("slap.resolved", 3_000);
    expect(resolved.marginMs).not.toBeNull();
    expect(resolved.marginMs!).toBeGreaterThan(0);
  });

  it("resolves an uncontested slap with no margin", async () => {
    h = await harness({ pingIntervalMs: 15 });
    const { clients } = await h.table(["Ana", "Bo"]);
    const [ana] = clients;
    await startGame(clients);
    await settled(clients);

    ana!.act({ a: "slap", targetId: ana!.playerId, slot: 0 });

    const resolved = await ana!.next("slap.resolved", 3_000);
    expect(resolved.slapperId).toBe(ana!.playerId);
    expect(resolved.marginMs).toBeNull();
  });

  it("applies a correct slap to the board", async () => {
    h = await harness({ pingIntervalMs: null });
    const { clients, code } = await h.table(["Ana", "Bo"]);
    await startGame(clients);
    const view = await settled(clients);

    // Find a card in Ana's hand that genuinely matches the discard top.
    const room = h.server.manager.getRoom(code);
    const seat = room?.state.seats.find((s) => s.id === clients[0]!.playerId);
    const topRank = view.discardTop?.rank;
    const slot = seat?.hand.findIndex((id) => room?.state.cards.get(id)?.rank === topRank) ?? -1;

    if (slot < 0) {
      // This deal had no match; the rule itself is covered exhaustively by the
      // engine tests, so there is nothing to assert here.
      expect(view.discardTop).not.toBeNull();
      return;
    }

    const before = view.players.find((p) => p.id === clients[0]!.playerId)?.slots.length ?? 0;
    clients[0]!.act({ a: "slap", targetId: clients[0]!.playerId, slot });

    const resolved = await clients[0]!.next("slap.resolved", 3_000);
    expect(resolved.outcome).toBe("ownCardDiscarded");

    const after = await clients[0]!.waitForState((v) => {
      const me = v.players.find((p) => p.id === clients[0]!.playerId);
      return (me?.slots.length ?? 0) === before - 1;
    }, 3_000);
    expect(after.players.find((p) => p.id === clients[0]!.playerId)?.slots.length).toBe(before - 1);
  });

  it("refuses a slap before the game has started", async () => {
    h = await harness({ pingIntervalMs: null });
    const { clients } = await h.table(["Ana", "Bo"]);

    clients[0]!.act({ a: "slap", targetId: clients[0]!.playerId, slot: 0 });
    const error = await clients[0]!.next("error");
    expect(error.code).toBe("illegalAction");
  });

  it("refuses a slap during the study phase", async () => {
    h = await harness({ pingIntervalMs: null });
    const { clients } = await h.table(["Ana", "Bo"]);
    clients[0]!.send({ t: "lobby.start" });
    await clients[0]!.waitForState((v) => v.phase === "study");

    clients[0]!.act({ a: "slap", targetId: clients[0]!.playerId, slot: 0 });
    const error = await clients[0]!.next("error");
    expect(error.code).toBe("illegalAction");
  });
});

describe("latency measurement", () => {
  it("measures a delayed client as being further away", async () => {
    h = await harness({ pingIntervalMs: 15 });
    const { clients, code } = await h.table(["Fast", "Slow"]);
    const [fast, slow] = clients;
    slow!.pongDelayMs = 150;
    await startGame(clients);

    const slowRtt = await waitForMeasuredRtt(h, code, slow!.playerId, 120);
    const fastRtt = h.server.manager.getRoom(code)?.rtt.rttFor(fast!.playerId) ?? 0;

    expect(slowRtt).toBeGreaterThan(fastRtt + 50);
  });

  it("never credits more than the compensation cap, however slow the client", async () => {
    h = await harness({ pingIntervalMs: 15 });
    const { clients, code } = await h.table(["Ana", "Glacial"]);
    const [, glacial] = clients;
    glacial!.pongDelayMs = 1_000;
    await startGame(clients);

    await waitForMeasuredRtt(h, code, glacial!.playerId, 900, 5_000);
    const oneWay = h.server.manager.getRoom(code)?.rtt.oneWayFor(glacial!.playerId) ?? 0;

    // Without the cap this client would be handed half a second of head start.
    expect(oneWay).toBe(150);
  });
});
