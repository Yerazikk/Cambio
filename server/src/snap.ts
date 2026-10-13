import type { PlayerId } from "@cambio/shared";

/** One player's attempt, as the server observed it. */
export type SnapClaim = {
  playerId: PlayerId;
  targetId: PlayerId;
  slot: number;
  /** Server clock when the message was read off the socket. */
  arrivalMs: number;
  /** Server-measured one-way latency credited back to this player. */
  oneWayMs: number;
};

export type ScoredClaim = SnapClaim & { effectiveMs: number };

export type SnapRace = {
  winner: ScoredClaim | null;
  /** Everyone who snapped but did not win, late arrivals included. */
  losers: ScoredClaim[];
  /** How far ahead the winner finished, in compensated ms, or null if unopposed. */
  marginMs: number | null;
};

function score(claim: SnapClaim): ScoredClaim {
  return { ...claim, effectiveMs: claim.arrivalMs - claim.oneWayMs };
}

/**
 * Decide a snap race.
 *
 * Players are ranked by when they *acted*, not when their packet landed:
 * subtracting each player's measured one-way latency from its arrival time
 * means a player on a worse connection can still win a close race, which is
 * the whole point of compensating at all.
 *
 * Pure and total: feed it arrivals and latencies and it returns the same
 * ordering every time, which is what makes the race testable without timers.
 */
export function resolveRace(claims: readonly SnapClaim[], windowMs: number): SnapRace {
  if (claims.length === 0) return { winner: null, losers: [], marginMs: null };

  const scored = claims.map(score);
  const firstArrival = Math.min(...scored.map((c) => c.arrivalMs));
  const deadline = firstArrival + windowMs;

  const eligible = scored.filter((c) => c.arrivalMs <= deadline);
  const late = scored.filter((c) => c.arrivalMs > deadline);

  const ranked = [...eligible].sort(compareClaims);
  const [winner, ...rest] = ranked;
  if (winner === undefined) return { winner: null, losers: late, marginMs: null };

  const runnerUp = rest[0];
  return {
    winner,
    losers: [...rest, ...late],
    marginMs: runnerUp === undefined ? null : runnerUp.effectiveMs - winner.effectiveMs,
  };
}

/**
 * Compensated time decides it. Raw arrival and then player id break ties, so
 * the outcome never depends on insertion or map iteration order - two clients
 * replaying the same race always agree on the winner.
 */
function compareClaims(a: ScoredClaim, b: ScoredClaim): number {
  if (a.effectiveMs !== b.effectiveMs) return a.effectiveMs - b.effectiveMs;
  if (a.arrivalMs !== b.arrivalMs) return a.arrivalMs - b.arrivalMs;
  return a.playerId < b.playerId ? -1 : a.playerId > b.playerId ? 1 : 0;
}

/** Injected so tests can drive the window without real time passing. */
export type Scheduler = {
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
};

export const realScheduler: Scheduler = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export type ArbiterOptions = {
  windowMs: number;
  now: () => number;
  scheduler?: Scheduler;
  onResolve: (race: SnapRace) => void;
};

/**
 * Collects snaps for one room and settles them in batches.
 *
 * The first snap opens a short window rather than winning outright; everything
 * that arrives inside it joins the same race. Without the window, the result
 * would be decided purely by network position.
 */
export class SnapArbiter {
  private pending: SnapClaim[] = [];
  private handle: unknown = null;
  private readonly scheduler: Scheduler;

  constructor(private readonly opts: ArbiterOptions) {
    this.scheduler = opts.scheduler ?? realScheduler;
  }

  get isOpen(): boolean {
    return this.handle !== null;
  }

  get pendingCount(): number {
    return this.pending.length;
  }

  /** Record a snap. The first one opens the window; later ones join that race. */
  submit(claim: Omit<SnapClaim, "arrivalMs"> & { arrivalMs?: number }): void {
    const arrivalMs = claim.arrivalMs ?? this.opts.now();
    this.pending.push({ ...claim, arrivalMs });

    if (this.handle === null) {
      this.handle = this.scheduler.setTimeout(() => this.settle(), this.opts.windowMs);
    }
  }

  /** Settle immediately, for tests and for shutting a room down. */
  settle(): void {
    if (this.handle !== null) {
      this.scheduler.clearTimeout(this.handle);
      this.handle = null;
    }
    if (this.pending.length === 0) return;

    const claims = this.pending;
    this.pending = [];
    this.opts.onResolve(resolveRace(claims, this.opts.windowMs));
  }

  /** Drop everything without resolving, e.g. when the round ends mid-race. */
  cancel(): void {
    if (this.handle !== null) {
      this.scheduler.clearTimeout(this.handle);
      this.handle = null;
    }
    this.pending = [];
  }
}
