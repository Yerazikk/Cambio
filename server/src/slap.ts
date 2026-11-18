import type { PlayerId } from "@cambio/shared";

/** One player's attempt, as the server observed it. */
export type SlapClaim = {
  playerId: PlayerId;
  targetId: PlayerId;
  slot: number;
  /** Server clock when the message was read off the socket. */
  arrivalMs: number;
  /** Server-measured one-way latency credited back to this player. */
  oneWayMs: number;
};

export type ScoredClaim = SlapClaim & {
  effectiveMs: number;
  /** How far behind the first slap in the queue this one acted. Zero for the first. */
  behindMs: number;
};

export type SlapRace = {
  /**
   * Everyone who slapped inside the window, in the order their slaps will be
   * played out: earliest compensated action first. A slap is not cancelled by
   * a faster one - it only waits its turn, and gets played if the slaps ahead
   * of it turn out to be wrong.
   */
  order: ScoredClaim[];
  /** Arrived after the window shut, so they take no part in this race at all. */
  late: ScoredClaim[];
  /** How far ahead the first slap finished, in compensated ms, or null if unopposed. */
  marginMs: number | null;
};

function score(claim: SlapClaim): ScoredClaim {
  return { ...claim, effectiveMs: claim.arrivalMs - claim.oneWayMs, behindMs: 0 };
}

/**
 * Order a slap race.
 *
 * Players are ranked by when they *acted*, not when their packet landed:
 * subtracting each player's measured one-way latency from its arrival time
 * means a player on a worse connection can still be first in the queue, which
 * is the whole point of compensating at all.
 *
 * The result is an order, not a single winner. Slapping at the same moment as
 * someone else does not cancel your slap; it puts you behind them, and you are
 * only spared playing it out if the slap ahead of yours was right.
 *
 * Pure and total: feed it arrivals and latencies and it returns the same
 * ordering every time, which is what makes the race testable without timers.
 */
export function resolveRace(claims: readonly SlapClaim[], windowMs: number): SlapRace {
  if (claims.length === 0) return { order: [], late: [], marginMs: null };

  const scored = claims.map(score);
  const firstArrival = Math.min(...scored.map((c) => c.arrivalMs));
  const deadline = firstArrival + windowMs;

  // One slap per player per race. A double-tap is a slip of the finger, and
  // now that every slap in the queue is played out it would otherwise cost
  // the player two penalty cards for one mistake.
  const eligible = firstPerPlayer(scored.filter((c) => c.arrivalMs <= deadline));
  const late = firstPerPlayer(scored.filter((c) => c.arrivalMs > deadline));

  const order = [...eligible].sort(compareClaims);
  const [first, ...rest] = order;
  if (first === undefined) return { order: [], late, marginMs: null };

  for (const claim of rest) claim.behindMs = claim.effectiveMs - first.effectiveMs;

  const runnerUp = rest[0];
  return { order, late, marginMs: runnerUp === undefined ? null : runnerUp.behindMs };
}

/** Keep only each player's earliest claim, by the same ordering the race uses. */
function firstPerPlayer(claims: readonly ScoredClaim[]): ScoredClaim[] {
  const best = new Map<PlayerId, ScoredClaim>();
  for (const claim of claims) {
    const held = best.get(claim.playerId);
    if (held === undefined || compareClaims(claim, held) < 0) best.set(claim.playerId, claim);
  }
  return [...best.values()];
}

/**
 * Compensated time decides it. Raw arrival and then player id break ties, so
 * the order never depends on insertion or map iteration order - two clients
 * replaying the same race always agree on who slapped when.
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
  onResolve: (race: SlapRace) => void;
};

/**
 * Collects slaps for one room and settles them in batches.
 *
 * The first slap opens a short window rather than being played immediately;
 * everything that arrives inside it joins the same race and is ordered against
 * it. Without the window, the order would be decided purely by network
 * position.
 */
export class SlapArbiter {
  private pending: SlapClaim[] = [];
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

  /** Record a slap. The first one opens the window; later ones join that race. */
  submit(claim: Omit<SlapClaim, "arrivalMs"> & { arrivalMs?: number }): void {
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
