import { RTT_DEFAULT_MS, RTT_EWMA_ALPHA, RTT_MAX_COMPENSATION_MS, type PlayerId } from "@cambio/shared";

/**
 * Per-player round-trip time, measured by the server itself.
 *
 * The server sends a nonce and times the echo, so the only input to latency
 * compensation is something the server observed. A client cannot claim to be
 * slower than it is to buy itself an earlier effective snap time, because it
 * never reports a clock at all.
 */
export class RttTracker {
  private readonly rtt = new Map<PlayerId, number>();
  private readonly inflight = new Map<number, { playerId: PlayerId; sentAt: number }>();
  private nextNonce = 1;

  constructor(
    private readonly now: () => number,
    private readonly alpha: number = RTT_EWMA_ALPHA,
    private readonly fallbackMs: number = RTT_DEFAULT_MS,
  ) {}

  /** Mint a nonce for a probe to `playerId`. */
  issuePing(playerId: PlayerId): number {
    const nonce = this.nextNonce++;
    this.inflight.set(nonce, { playerId, sentAt: this.now() });
    return nonce;
  }

  /** Record an echo. Unknown or mismatched nonces are ignored, not trusted. */
  recordPong(playerId: PlayerId, nonce: number): void {
    const probe = this.inflight.get(nonce);
    if (!probe || probe.playerId !== playerId) return;
    this.inflight.delete(nonce);

    const sample = Math.max(0, this.now() - probe.sentAt);
    const previous = this.rtt.get(playerId);
    this.rtt.set(playerId, previous === undefined ? sample : previous + this.alpha * (sample - previous));
  }

  /** Smoothed round-trip time, or the fallback for a player not yet measured. */
  rttFor(playerId: PlayerId): number {
    return this.rtt.get(playerId) ?? this.fallbackMs;
  }

  /**
   * How far back to credit a player's snap. Capped so that an unusually bad or
   * misreported-looking RTT cannot be turned into an arbitrarily large head
   * start.
   */
  oneWayFor(playerId: PlayerId): number {
    return Math.min(this.rttFor(playerId) / 2, RTT_MAX_COMPENSATION_MS);
  }

  forget(playerId: PlayerId): void {
    this.rtt.delete(playerId);
    for (const [nonce, probe] of this.inflight) {
      if (probe.playerId === playerId) this.inflight.delete(nonce);
    }
  }

  /** Visible for tests and diagnostics. */
  snapshot(): Record<PlayerId, number> {
    return Object.fromEntries(this.rtt);
  }
}
