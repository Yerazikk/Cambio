import { describe, expect, it, vi } from "vitest";
import { RttTracker } from "../src/rtt.js";
import { SlapArbiter, resolveRace, type Scheduler, type SlapClaim } from "../src/slap.js";

/** A claim written the way the race actually sees it: when it landed, and the ping. */
function claim(playerId: string, arrivalMs: number, rttMs: number, slot = 0, targetId = playerId): SlapClaim {
  return { playerId, targetId, slot, arrivalMs, oneWayMs: rttMs / 2 };
}

describe("ordering a race", () => {
  it("puts a later packet first when the player was on a worse connection", () => {
    // The headline case. Bo's slap landed 10ms after Ana's, but Bo is on a 90ms
    // round trip against Ana's 40ms, so Bo actually hit the table first.
    const race = resolveRace(
      [claim("ana", 1000, 40), claim("bo", 1010, 90), claim("cy", 1180, 30)],
      200,
    );

    expect(race.order.map((c) => c.playerId)).toEqual(["bo", "ana", "cy"]);
    expect(race.order[0]?.effectiveMs).toBe(965);
    expect(race.marginMs).toBe(15); // ana at 980 against bo at 965
  });

  it("keeps every slap in the queue - a faster one does not cancel it", () => {
    // The rule the whole queue exists for: Ana does not lose her slap because
    // Bo was quicker, she only goes after him.
    const race = resolveRace([claim("ana", 1000, 40), claim("bo", 1010, 90)], 200);

    expect(race.order).toHaveLength(2);
    expect(race.order.map((c) => c.playerId)).toEqual(["bo", "ana"]);
    expect(race.late).toEqual([]);
  });

  it("records how far behind the first each later slap was", () => {
    const race = resolveRace(
      [claim("ana", 1000, 40), claim("bo", 1010, 90), claim("cy", 1180, 30)],
      200,
    );

    expect(race.order.map((c) => c.behindMs)).toEqual([0, 15, 200]);
  });

  it("still puts raw speed first when latency is equal", () => {
    const race = resolveRace([claim("ana", 1000, 50), claim("bo", 1010, 50)], 200);

    expect(race.order.map((c) => c.playerId)).toEqual(["ana", "bo"]);
    expect(race.marginMs).toBe(10);
  });

  it("reports no margin for an unopposed slap", () => {
    const race = resolveRace([claim("ana", 1000, 40)], 200);

    expect(race.order.map((c) => c.playerId)).toEqual(["ana"]);
    expect(race.marginMs).toBeNull();
  });

  it("returns an empty queue when nobody slapped", () => {
    expect(resolveRace([], 200)).toEqual({ order: [], late: [], marginMs: null });
  });

  it("counts a double-tap once, so one slip of the finger costs one card", () => {
    const race = resolveRace([claim("ana", 1000, 40), claim("ana", 1020, 40)], 200);

    expect(race.order.map((c) => c.playerId)).toEqual(["ana"]);
    expect(race.order[0]?.arrivalMs).toBe(1000); // the earlier of the two
    expect(race.marginMs).toBeNull();
  });

  describe("the window", () => {
    it("excludes a slap that arrived after the window shut", () => {
      // Cy is compensated all the way back to 900 - earliest of the three - but
      // the packet landed 300ms late, well outside the 200ms window.
      const race = resolveRace(
        [claim("ana", 1000, 40), claim("bo", 1010, 90), claim("cy", 1300, 800)],
        200,
      );

      expect(race.order.map((c) => c.playerId)).toEqual(["bo", "ana"]);
      expect(race.late.map((c) => c.playerId)).toEqual(["cy"]);
    });

    it("includes a slap landing exactly on the deadline", () => {
      // Bo lands on the last possible millisecond and is credited back to 950,
      // ahead of Ana's 1000, so including the boundary decides the order.
      const race = resolveRace([claim("ana", 1000, 0), claim("bo", 1200, 500)], 200);

      expect(race.order.map((c) => c.playerId)).toEqual(["bo", "ana"]);
      expect(race.order[0]?.effectiveMs).toBe(950);
      expect(race.late).toEqual([]);
    });

    it("excludes a slap landing one millisecond past the deadline", () => {
      // Identical to the case above but 1ms later: Bo would have gone first on
      // compensated time, and is dropped purely for missing the window.
      const race = resolveRace([claim("ana", 1000, 0), claim("bo", 1201, 500)], 200);

      expect(race.order.map((c) => c.playerId)).toEqual(["ana"]);
      expect(race.late.map((c) => c.playerId)).toEqual(["bo"]);
      expect(race.marginMs).toBeNull(); // bo was never in the running
    });

    it("measures the window from the first arrival, not from the earliest effective time", () => {
      const race = resolveRace([claim("bo", 1010, 90), claim("ana", 1000, 40)], 200);
      expect(race.order[0]?.playerId).toBe("bo");
    });
  });

  describe("tie-breaking", () => {
    it("falls back to raw arrival when compensated times are identical", () => {
      // Both land on an effective 980, but Ana's packet arrived first.
      const race = resolveRace([claim("bo", 1020, 80), claim("ana", 1000, 40)], 200);

      expect(race.order.map((c) => c.playerId)).toEqual(["ana", "bo"]);
      expect(race.marginMs).toBe(0);
    });

    it("falls back to player id when even arrivals are identical, so it is never arbitrary", () => {
      const forward = resolveRace([claim("bo", 1000, 40), claim("ana", 1000, 40)], 200);
      const reversed = resolveRace([claim("ana", 1000, 40), claim("bo", 1000, 40)], 200);

      // Submission order must not change the order of the queue.
      expect(forward.order.map((c) => c.playerId)).toEqual(["ana", "bo"]);
      expect(reversed.order.map((c) => c.playerId)).toEqual(["ana", "bo"]);
    });
  });

  it("keeps each claim's target and slot, since they can differ per player", () => {
    const race = resolveRace(
      [claim("ana", 1000, 40, 2, "bo"), claim("bo", 990, 40, 1, "cy")],
      200,
    );

    expect(race.order[0]?.playerId).toBe("bo");
    expect(race.order[0]?.targetId).toBe("cy");
    expect(race.order[0]?.slot).toBe(1);
    expect(race.order[1]?.targetId).toBe("bo");
    expect(race.order[1]?.slot).toBe(2);
  });
});

describe("the arbiter window", () => {
  /** A scheduler that only fires when a test says so. */
  function fakeScheduler() {
    const queued: { fn: () => void; ms: number }[] = [];
    const scheduler: Scheduler = {
      setTimeout: (fn, ms) => {
        queued.push({ fn, ms });
        return queued.length - 1;
      },
      clearTimeout: () => {},
    };
    return { scheduler, queued, fire: () => queued.forEach((q) => q.fn()) };
  }

  it("holds the first slap open instead of resolving it immediately", () => {
    const { scheduler, queued } = fakeScheduler();
    const onResolve = vi.fn();
    const arbiter = new SlapArbiter({ windowMs: 200, now: () => 1000, scheduler, onResolve });

    arbiter.submit({ playerId: "ana", targetId: "ana", slot: 0, oneWayMs: 20 });

    expect(onResolve).not.toHaveBeenCalled();
    expect(arbiter.isOpen).toBe(true);
    expect(queued[0]?.ms).toBe(200);
  });

  it("collects every slap inside the window into a single race", () => {
    const { scheduler, fire } = fakeScheduler();
    const onResolve = vi.fn();
    let clock = 1000;
    const arbiter = new SlapArbiter({ windowMs: 200, now: () => clock, scheduler, onResolve });

    arbiter.submit({ playerId: "ana", targetId: "ana", slot: 0, oneWayMs: 20 });
    clock = 1010;
    arbiter.submit({ playerId: "bo", targetId: "bo", slot: 1, oneWayMs: 45 });
    expect(arbiter.pendingCount).toBe(2);

    fire();

    expect(onResolve).toHaveBeenCalledTimes(1);
    expect(onResolve.mock.calls[0]?.[0].order.map((c: { playerId: string }) => c.playerId)).toEqual(["bo", "ana"]);
  });

  it("stamps arrival from the server clock, never from the client", () => {
    const { scheduler, fire } = fakeScheduler();
    const onResolve = vi.fn();
    let clock = 5000;
    const arbiter = new SlapArbiter({ windowMs: 200, now: () => clock, scheduler, onResolve });

    arbiter.submit({ playerId: "ana", targetId: "ana", slot: 0, oneWayMs: 20 });
    clock = 5050;
    arbiter.submit({ playerId: "bo", targetId: "bo", slot: 0, oneWayMs: 20 });
    fire();

    const race = onResolve.mock.calls[0]?.[0];
    expect(race.order[0].arrivalMs).toBe(5000);
    expect(race.order[0].playerId).toBe("ana");
  });

  it("closes the window after resolving, so the next slap starts a fresh race", () => {
    const { scheduler, fire } = fakeScheduler();
    const onResolve = vi.fn();
    const arbiter = new SlapArbiter({ windowMs: 200, now: () => 1000, scheduler, onResolve });

    arbiter.submit({ playerId: "ana", targetId: "ana", slot: 0, oneWayMs: 20 });
    fire();
    expect(arbiter.isOpen).toBe(false);

    arbiter.submit({ playerId: "bo", targetId: "bo", slot: 0, oneWayMs: 20 });
    expect(arbiter.isOpen).toBe(true);
    expect(arbiter.pendingCount).toBe(1);
  });

  it("resolves nothing when the window closes empty", () => {
    const { scheduler } = fakeScheduler();
    const onResolve = vi.fn();
    const arbiter = new SlapArbiter({ windowMs: 200, now: () => 1000, scheduler, onResolve });

    arbiter.settle();
    expect(onResolve).not.toHaveBeenCalled();
  });

  it("drops a race on cancel, for a round that ends mid-window", () => {
    const { scheduler, fire } = fakeScheduler();
    const onResolve = vi.fn();
    const arbiter = new SlapArbiter({ windowMs: 200, now: () => 1000, scheduler, onResolve });

    arbiter.submit({ playerId: "ana", targetId: "ana", slot: 0, oneWayMs: 20 });
    arbiter.cancel();
    fire();

    expect(onResolve).not.toHaveBeenCalled();
    expect(arbiter.pendingCount).toBe(0);
  });

  it("settles on a real timer when none is injected", async () => {
    vi.useFakeTimers();
    try {
      const onResolve = vi.fn();
      const arbiter = new SlapArbiter({ windowMs: 200, now: () => Date.now(), onResolve });

      arbiter.submit({ playerId: "ana", targetId: "ana", slot: 0, oneWayMs: 20 });
      expect(onResolve).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(200);
      expect(onResolve).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("measuring round-trip time", () => {
  function tracker() {
    let clock = 0;
    const rtt = new RttTracker(() => clock, 0.5, 80);
    return { rtt, at: (ms: number) => void (clock = ms) };
  }

  it("falls back to a default for a player who has not answered yet", () => {
    const { rtt } = tracker();
    expect(rtt.rttFor("ana")).toBe(80);
    expect(rtt.oneWayFor("ana")).toBe(40);
  });

  it("times the echo of its own nonce", () => {
    const { rtt, at } = tracker();
    const nonce = rtt.issuePing("ana");
    at(60);
    rtt.recordPong("ana", nonce);

    expect(rtt.rttFor("ana")).toBe(60);
    expect(rtt.oneWayFor("ana")).toBe(30);
  });

  it("smooths successive samples instead of jumping to the latest", () => {
    const { rtt, at } = tracker();
    const first = rtt.issuePing("ana");
    at(100);
    rtt.recordPong("ana", first);
    expect(rtt.rttFor("ana")).toBe(100);

    const second = rtt.issuePing("ana");
    at(120); // a 20ms sample
    rtt.recordPong("ana", second);
    expect(rtt.rttFor("ana")).toBe(60); // 100 + 0.5 * (20 - 100)
  });

  it("ignores a nonce the server never issued", () => {
    const { rtt } = tracker();
    rtt.recordPong("ana", 9999);
    expect(rtt.rttFor("ana")).toBe(80);
  });

  it("ignores a player answering someone else's nonce", () => {
    const { rtt, at } = tracker();
    const forAna = rtt.issuePing("ana");
    at(50);
    rtt.recordPong("bo", forAna);

    expect(rtt.rttFor("bo")).toBe(80); // unchanged
    expect(rtt.rttFor("ana")).toBe(80); // Ana's probe is still outstanding
  });

  it("ignores a replayed nonce, so an echo cannot be used twice", () => {
    const { rtt, at } = tracker();
    const nonce = rtt.issuePing("ana");
    at(40);
    rtt.recordPong("ana", nonce);
    at(400);
    rtt.recordPong("ana", nonce);

    expect(rtt.rttFor("ana")).toBe(40);
  });

  it("caps how far back a slap can be credited", () => {
    const { rtt, at } = tracker();
    const nonce = rtt.issuePing("ana");
    at(2_000); // an absurd 2s round trip
    rtt.recordPong("ana", nonce);

    expect(rtt.rttFor("ana")).toBe(2_000);
    // Without the cap this would hand Ana a full second of head start.
    expect(rtt.oneWayFor("ana")).toBe(150);
  });

  it("forgets a player who left", () => {
    const { rtt, at } = tracker();
    const nonce = rtt.issuePing("ana");
    at(40);
    rtt.recordPong("ana", nonce);
    expect(rtt.rttFor("ana")).toBe(40);

    rtt.forget("ana");
    expect(rtt.rttFor("ana")).toBe(80);
  });
});
