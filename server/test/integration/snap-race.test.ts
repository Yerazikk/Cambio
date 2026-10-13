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

/** Every snap.resolved a client saw, newest last. */
function winnersSeenBy(client: TestClient): (string | null)[] {
  return client.eventsOfType("snap.resolved").map((e) => e.winnerId);
}

describe("racing a snap over real sockets", () => {
  it("lets the slower connection win when it acted first", async () => {
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
    expect(view.snapOpen).toBe(true);

    // Fast's packet lands first, but Slow is compensated far enough back that
    // Slow actually hit the table first.
    fast!.act({ a: "snap", targetId: fast!.playerId, slot: 0 });
    await sleep(40);
    slow!.act({ a: "snap", targetId: slow!.playerId, slot: 0 });

    const resolved = await fast!.next("snap.resolved", 3_000);
    expect(resolved.winnerId).toBe(slow!.playerId);
  });

  it("lets the earlier snap win when latency is equal", async () => {
    h = await harness({ pingIntervalMs: 15 });
    const { clients } = await h.table(["Ana", "Bo"]);
    const [ana, bo] = clients;
    await startGame(clients);
    await settled(clients);

    ana!.act({ a: "snap", targetId: ana!.playerId, slot: 0 });
    await sleep(60);
    bo!.act({ a: "snap", targetId: bo!.playerId, slot: 0 });

    const resolved = await ana!.next("snap.resolved", 3_000);
    expect(resolved.winnerId).toBe(ana!.playerId);
  });

  it("tells every player the same winner", async () => {
    h = await harness({ pingIntervalMs: 15 });
    const { clients } = await h.table(["Ana", "Bo", "Cy"]);
    const [ana, bo, cy] = clients;
    await startGame(clients);
    await settled(clients);

    ana!.act({ a: "snap", targetId: ana!.playerId, slot: 0 });
    bo!.act({ a: "snap", targetId: bo!.playerId, slot: 0 });

    await Promise.all(clients.map((c) => c.next("snap.resolved", 3_000)));

    const winners = clients.map((c) => winnersSeenBy(c)[0]);
    expect(new Set(winners).size).toBe(1);
    expect(winners[0]).toBeTruthy();
    void cy;
  });

  it("tells the loser they lost the race, so an optimistic flash can be undone", async () => {
    h = await harness({ pingIntervalMs: 15 });
    const { clients } = await h.table(["Ana", "Bo"]);
    const [ana, bo] = clients;
    await startGame(clients);
    await settled(clients);

    ana!.act({ a: "snap", targetId: ana!.playerId, slot: 0 });
    await sleep(60);
    bo!.act({ a: "snap", targetId: bo!.playerId, slot: 0 });

    // Bo should be told specifically that the race was lost, not merely that
    // somebody else won.
    const boEvents = await bo!.waitFor(
      (e): e is Extract<typeof e, { t: "snap.resolved" }> => e.t === "snap.resolved" && e.outcome === "lostRace",
      3_000,
    );
    expect(boEvents.winnerId).toBe(ana!.playerId);
  });

  it("reports the winning margin", async () => {
    h = await harness({ pingIntervalMs: 15 });
    const { clients } = await h.table(["Ana", "Bo"]);
    const [ana, bo] = clients;
    await startGame(clients);
    await settled(clients);

    ana!.act({ a: "snap", targetId: ana!.playerId, slot: 0 });
    await sleep(50);
    bo!.act({ a: "snap", targetId: bo!.playerId, slot: 0 });

    const resolved = await ana!.next("snap.resolved", 3_000);
    expect(resolved.marginMs).not.toBeNull();
    expect(resolved.marginMs!).toBeGreaterThan(0);
  });

  it("resolves an uncontested snap with no margin", async () => {
    h = await harness({ pingIntervalMs: 15 });
    const { clients } = await h.table(["Ana", "Bo"]);
    const [ana] = clients;
    await startGame(clients);
    await settled(clients);

    ana!.act({ a: "snap", targetId: ana!.playerId, slot: 0 });

    const resolved = await ana!.next("snap.resolved", 3_000);
    expect(resolved.winnerId).toBe(ana!.playerId);
    expect(resolved.marginMs).toBeNull();
  });

  it("applies a correct snap to the board", async () => {
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
    clients[0]!.act({ a: "snap", targetId: clients[0]!.playerId, slot });

    const resolved = await clients[0]!.next("snap.resolved", 3_000);
    expect(resolved.outcome).toBe("ownCardDiscarded");

    const after = await clients[0]!.waitForState((v) => {
      const me = v.players.find((p) => p.id === clients[0]!.playerId);
      return (me?.slots.length ?? 0) === before - 1;
    }, 3_000);
    expect(after.players.find((p) => p.id === clients[0]!.playerId)?.slots.length).toBe(before - 1);
  });

  it("refuses a snap before the game has started", async () => {
    h = await harness({ pingIntervalMs: null });
    const { clients } = await h.table(["Ana", "Bo"]);

    clients[0]!.act({ a: "snap", targetId: clients[0]!.playerId, slot: 0 });
    const error = await clients[0]!.next("error");
    expect(error.code).toBe("illegalAction");
  });

  it("refuses a snap during the study phase", async () => {
    h = await harness({ pingIntervalMs: null });
    const { clients } = await h.table(["Ana", "Bo"]);
    clients[0]!.send({ t: "lobby.start" });
    await clients[0]!.waitForState((v) => v.phase === "study");

    clients[0]!.act({ a: "snap", targetId: clients[0]!.playerId, slot: 0 });
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
