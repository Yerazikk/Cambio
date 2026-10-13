import { describe, expect, it, vi } from "vitest";
import { RttTracker } from "../src/rtt.js";
import { SnapArbiter, resolveRace, type Scheduler, type SnapClaim } from "../src/snap.js";

/** A claim written the way the race actually sees it: when it landed, and the ping. */
function claim(playerId: string, arrivalMs: number, rttMs: number, slot = 0, targetId = playerId): SnapClaim {
  return { playerId, targetId, slot, arrivalMs, oneWayMs: rttMs / 2 };
}

describe("resolving a race", () => {
  it("lets a later packet win when the player was on a worse connection", () => {
    // The headline case. Bo's snap landed 10ms after Ana's, but Bo is on a 90ms
    // round trip against Ana's 40ms, so Bo actually hit the table first.
    const race = resolveRace(
      [claim("ana", 1000, 40), claim("bo", 1010, 90), claim("cy", 1180, 30)],
      200,
    );

    expect(race.winner?.playerId).toBe("bo");
    expect(race.winner?.effectiveMs).toBe(965);
    expect(race.losers.map((l) => l.playerId)).toEqual(["ana", "cy"]);
    expect(race.marginMs).toBe(15); // ana at 980 against bo at 965
  });

  it("still lets raw speed win when latency is equal", () => {
    const race = resolveRace([claim("ana", 1000, 50), claim("bo", 1010, 50)], 200);

    expect(race.winner?.playerId).toBe("ana");
    expect(race.marginMs).toBe(10);
  });

  it("reports no margin for an unopposed snap", () => {
    const race = resolveRace([claim("ana", 1000, 40)], 200);

    expect(race.winner?.playerId).toBe("ana");
    expect(race.marginMs).toBeNull();
    expect(race.losers).toEqual([]);
  });

  it("returns no winner when nobody snapped", () => {
    expect(resolveRace([], 200)).toEqual({ winner: null, losers: [], marginMs: null });
  });

  describe("the window", () => {
    it("excludes a snap that arrived after the window shut", () => {
      // Cy is compensated all the way back to 900 - earliest of the three - but
      // the packet landed 300ms late, well outside the 200ms window.
      const race = resolveRace(
        [claim("ana", 1000, 40), claim("bo", 1010, 90), claim("cy", 1300, 800)],
        200,
      );

      expect(race.winner?.playerId).toBe("bo");
      expect(race.losers.map((l) => l.playerId)).toContain("cy");
    });

    it("includes a snap landing exactly on the deadline", () => {
      // Bo lands on the last possible millisecond and is credited back to 950,
      // ahead of Ana's 1000, so including the boundary decides the race.
      const race = resolveRace([claim("ana", 1000, 0), claim("bo", 1200, 500)], 200);

      expect(race.winner?.playerId).toBe("bo");
      expect(race.winner?.effectiveMs).toBe(950);
      expect(race.losers.map((l) => l.playerId)).toEqual(["ana"]);
    });

    it("excludes a snap landing one millisecond past the deadline", () => {
      // Identical to the case above but 1ms later: Bo would have won on
      // compensated time, and is dropped purely for missing the window.
      const race = resolveRace([claim("ana", 1000, 0), claim("bo", 1201, 500)], 200);

      expect(race.winner?.playerId).toBe("ana");
      expect(race.losers.map((l) => l.playerId)).toEqual(["bo"]);
      expect(race.marginMs).toBeNull(); // bo was never in the running
    });

    it("measures the window from the first arrival, not from the earliest effective time", () => {
      const race = resolveRace([claim("bo", 1010, 90), claim("ana", 1000, 40)], 200);
      expect(race.winner?.playerId).toBe("bo");
    });
  });

  describe("tie-breaking", () => {
    it("falls back to raw arrival when compensated times are identical", () => {
      // Both land on an effective 980, but Ana's packet arrived first.
      const race = resolveRace([claim("bo", 1020, 80), claim("ana", 1000, 40)], 200);

      expect(race.winner?.playerId).toBe("ana");
      expect(race.marginMs).toBe(0);
    });

    it("falls back to player id when even arrivals are identical, so it is never arbitrary", () => {
      const forward = resolveRace([claim("bo", 1000, 40), claim("ana", 1000, 40)], 200);
      const reversed = resolveRace([claim("ana", 1000, 40), claim("bo", 1000, 40)], 200);

      expect(forward.winner?.playerId).toBe("ana");
      // Submission order must not change the outcome.
      expect(reversed.winner?.playerId).toBe("ana");
    });
  });

  it("keeps each claim's target and slot, since they can differ per player", () => {
    const race = resolveRace(
      [claim("ana", 1000, 40, 2, "bo"), claim("bo", 990, 40, 1, "cy")],
      200,
    );

    expect(race.winner?.playerId).toBe("bo");
    expect(race.winner?.targetId).toBe("cy");
    expect(race.winner?.slot).toBe(1);
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

  it("holds the first snap open instead of resolving it immediately", () => {
    const { scheduler, queued } = fakeScheduler();
    const onResolve = vi.fn();
    const arbiter = new SnapArbiter({ windowMs: 200, now: () => 1000, scheduler, onResolve });

    arbiter.submit({ playerId: "ana", targetId: "ana", slot: 0, oneWayMs: 20 });

    expect(onResolve).not.toHaveBeenCalled();
    expect(arbiter.isOpen).toBe(true);
    expect(queued[0]?.ms).toBe(200);
  });

  it("collects every snap inside the window into a single race", () => {
    const { scheduler, fire } = fakeScheduler();
    const onResolve = vi.fn();
    let clock = 1000;
    const arbiter = new SnapArbiter({ windowMs: 200, now: () => clock, scheduler, onResolve });

    arbiter.submit({ playerId: "ana", targetId: "ana", slot: 0, oneWayMs: 20 });
    clock = 1010;
    arbiter.submit({ playerId: "bo", targetId: "bo", slot: 1, oneWayMs: 45 });
    expect(arbiter.pendingCount).toBe(2);

    fire();

    expect(onResolve).toHaveBeenCalledTimes(1);
    expect(onResolve.mock.calls[0]?.[0].winner.playerId).toBe("bo");
  });

  it("stamps arrival from the server clock, never from the client", () => {
    const { scheduler, fire } = fakeScheduler();
    const onResolve = vi.fn();
    let clock = 5000;
    const arbiter = new SnapArbiter({ windowMs: 200, now: () => clock, scheduler, onResolve });

    arbiter.submit({ playerId: "ana", targetId: "ana", slot: 0, oneWayMs: 20 });
    clock = 5050;
    arbiter.submit({ playerId: "bo", targetId: "bo", slot: 0, oneWayMs: 20 });
    fire();

    const race = onResolve.mock.calls[0]?.[0];
    expect(race.winner.arrivalMs).toBe(5000);
    expect(race.winner.playerId).toBe("ana");
  });

  it("closes the window after resolving, so the next snap starts a fresh race", () => {
    const { scheduler, fire } = fakeScheduler();
    const onResolve = vi.fn();
    const arbiter = new SnapArbiter({ windowMs: 200, now: () => 1000, scheduler, onResolve });

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
    const arbiter = new SnapArbiter({ windowMs: 200, now: () => 1000, scheduler, onResolve });

    arbiter.settle();
    expect(onResolve).not.toHaveBeenCalled();
  });

  it("drops a race on cancel, for a round that ends mid-window", () => {
    const { scheduler, fire } = fakeScheduler();
    const onResolve = vi.fn();
    const arbiter = new SnapArbiter({ windowMs: 200, now: () => 1000, scheduler, onResolve });

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
      const arbiter = new SnapArbiter({ windowMs: 200, now: () => Date.now(), onResolve });

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

  it("caps how far back a snap can be credited", () => {
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
