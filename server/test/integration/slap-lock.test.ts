import { afterEach, describe, expect, it } from "vitest";
import { harness, settled, startGame, type Harness } from "./harness.js";

let h: Harness;
afterEach(async () => {
  await h?.close();
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** How many cards a player holds, so a penalty can be told from a discard. */
function handSize(h: Harness, code: string, playerId: string): number {
  return h.server.manager.getRoom(code)!.state.seats.find((s) => s.id === playerId)!.hand.length;
}

/**
 * Make exactly one player's first card a legal slap, and nobody else's.
 *
 * The lock rules turn on the difference between a right slap and a wrong one,
 * which a random deal cannot be relied on to produce.
 */
function rigMatch(h: Harness, code: string, playerId: string): void {
  const state = h.server.manager.getRoom(code)!.state;
  const topId = state.discard.at(-1)!;
  const mine = state.cards.get(state.seats.find((s) => s.id === playerId)!.hand[0]!)!;

  state.cards.set(topId, { ...mine, id: topId });
  for (const seat of state.seats) {
    if (seat.id === playerId) continue;
    const id = seat.hand[0]!;
    const card = state.cards.get(id)!;
    if (card.rank === mine.rank) state.cards.set(id, { ...card, rank: mine.rank === 2 ? 3 : 2 });
  }
}

/** Rig the table so that nobody's first card matches the discard top. */
function rigMiss(h: Harness, code: string): void {
  const state = h.server.manager.getRoom(code)!.state;
  const topId = state.discard.at(-1)!;
  state.cards.set(topId, { ...state.cards.get(topId)!, rank: "king", suit: "spades" });
  for (const seat of state.seats) {
    const id = seat.hand[0]!;
    state.cards.set(id, { ...state.cards.get(id)!, rank: 4, suit: "clubs" });
  }
}

describe("a slap stops the table", () => {
  it("holds the game from the moment SLAP is pressed until a card is named", async () => {
    h = await harness({ rules: { turnMs: 30_000 } });
    const { clients } = await h.table(["Ana", "Bo"]);
    const [ana, bo] = clients;
    await startGame(clients);
    const running = await settled(clients);
    expect(running.slapLock).toBeNull();

    // Bo slaps, and the table stops - on every screen, not just Bo's.
    bo!.act({ a: "slapClaim" });
    const stopped = await ana!.waitForState((v) => v.slapLock !== null);
    expect(stopped.slapLock?.holderId).toBe(bo!.playerId);
    expect(stopped.slapLock?.waiting).toEqual([]);
    // The clock on the interrupted turn is held rather than run down.
    expect(stopped.turnEndsAt).toBeNull();

    // Whoever's turn it was cannot play while the table is stopped.
    const turnPlayer = clients.find((c) => c.playerId === running.turnPlayerId)!;
    turnPlayer.act({ a: "drawDeck" });
    const refused = await turnPlayer.next("error");
    expect(refused.message).toMatch(/stopped while a slap/i);

    // Naming the card lets the table go again, and gives the turn its clock back.
    bo!.act({ a: "slap", targetId: bo!.playerId, slot: 0 });
    const freed = await ana!.waitForState((v) => v.slapLock === null);
    expect(freed.turnEndsAt).not.toBeNull();
  });

  it("makes the second slapper wait, then answer, when the first was wrong", async () => {
    h = await harness();
    const { clients, code } = await h.table(["Ana", "Bo"]);
    const [ana, bo] = clients;
    await startGame(clients);
    await settled(clients);
    rigMiss(h, code);

    ana!.act({ a: "slapClaim" });
    await sleep(40);
    bo!.act({ a: "slapClaim" });

    const queued = await bo!.waitForState((v) => v.slapLock?.waiting.length === 1);
    expect(queued.slapLock?.holderId).toBe(ana!.playerId);
    expect(queued.slapLock?.waiting).toEqual([bo!.playerId]);

    // Ana is wrong, so she pays - and the table turns to Bo rather than
    // letting him off.
    const before = handSize(h, code, ana!.playerId);
    ana!.act({ a: "slap", targetId: ana!.playerId, slot: 0 });

    const bosTurnToPick = await bo!.waitForState((v) => v.slapLock?.holderId === bo!.playerId);
    expect(bosTurnToPick.slapLock?.waiting).toEqual([]);
    expect(handSize(h, code, ana!.playerId)).toBe(before + 1);
  });

  it("lets everyone behind a right slap go without picking at all", async () => {
    h = await harness();
    const { clients, code } = await h.table(["Ana", "Bo"]);
    const [ana, bo] = clients;
    await startGame(clients);
    await settled(clients);
    rigMatch(h, code, ana!.playerId);

    ana!.act({ a: "slapClaim" });
    await sleep(40);
    bo!.act({ a: "slapClaim" });
    await bo!.waitForState((v) => v.slapLock?.waiting.length === 1);

    const before = handSize(h, code, bo!.playerId);
    ana!.act({ a: "slap", targetId: ana!.playerId, slot: 0 });

    // The queue stops at the right slap: Bo is told privately and pays nothing.
    const spared = await bo!.waitFor(
      (e): e is Extract<typeof e, { t: "slap.resolved" }> =>
        e.t === "slap.resolved" && e.slapperId === bo!.playerId,
    );
    expect(spared.outcome).toBe("lostRace");
    expect(spared.endedById).toBe(ana!.playerId);
    expect(handSize(h, code, bo!.playerId)).toBe(before);
    await ana!.waitForState((v) => v.slapLock === null);
  });

  it("charges a card to a slapper who never names one", async () => {
    h = await harness({ rules: { slapPickMs: 120 } });
    const { clients, code } = await h.table(["Ana", "Bo"]);
    const [ana] = clients;
    await startGame(clients);
    await settled(clients);

    const before = handSize(h, code, ana!.playerId);
    ana!.act({ a: "slapClaim" });
    await ana!.waitForState((v) => v.slapLock !== null);

    const forfeited = await ana!.next("slap.resolved", 3_000);
    expect(forfeited.outcome).toBe("noPickPenalty");
    expect(handSize(h, code, ana!.playerId)).toBe(before + 1);
    // And the table is running again.
    await ana!.waitForState((v) => v.slapLock === null);
  });

  it("takes a number-key slap as claim and answer in one gesture", async () => {
    h = await harness();
    const { clients } = await h.table(["Ana", "Bo"]);
    const [ana] = clients;
    await startGame(clients);
    await settled(clients);

    // No claim first: the card is named as the slap is made, so the table
    // stops and starts again without ever waiting on anybody.
    ana!.act({ a: "slap", targetId: ana!.playerId, slot: 0 });

    const resolved = await ana!.next("slap.resolved", 3_000);
    expect(resolved.slapperId).toBe(ana!.playerId);
    expect(resolved.outcome).not.toBe("noPickPenalty");
    const after = await ana!.waitForState((v) => v.slapLock === null);
    expect(after.slapLock).toBeNull();
  });

  it("gives one place in the queue however many times a player presses", async () => {
    h = await harness();
    const { clients } = await h.table(["Ana", "Bo"]);
    const [ana, bo] = clients;
    await startGame(clients);
    await settled(clients);

    ana!.act({ a: "slapClaim" });
    await sleep(40);
    bo!.act({ a: "slapClaim" });
    bo!.act({ a: "slapClaim" });
    bo!.act({ a: "slapClaim" });

    const queued = await bo!.waitForState((v) => v.slapLock?.waiting.length === 1);
    expect(queued.slapLock?.waiting).toEqual([bo!.playerId]);
  });
});
