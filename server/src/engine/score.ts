import type { Card, CardId, PlayerId } from "@cambio/shared";
import type { GameState } from "./state.js";

export function handScore(hand: readonly CardId[], cards: ReadonlyMap<CardId, Card>): number {
  let total = 0;
  for (const id of hand) {
    const card = cards.get(id);
    if (card !== undefined) total += card.points;
  }
  return total;
}

export function rawScores(state: GameState): Map<PlayerId, number> {
  const out = new Map<PlayerId, number>();
  for (const seat of state.seats) out.set(seat.id, handScore(seat.hand, state.cards));
  return out;
}

export type Settlement = {
  scores: Map<PlayerId, number>;
  winnerId: PlayerId;
  /** True when the Cambio caller failed to hold the lowest hand and was penalised. */
  callerPenalised: boolean;
};

/**
 * Settle a finished round.
 *
 * The caller of Cambio wins ties — taking the risk is what earns the tiebreak.
 * If their hand is not lowest they take `cambioPenalty`, and the winner is then
 * the lowest of the adjusted scores, with seat order as a deterministic
 * final tiebreak so the outcome never depends on map iteration order.
 */
export function settle(state: GameState): Settlement {
  const scores = rawScores(state);
  const caller = state.cambioCallerId;

  const lowest = Math.min(...scores.values());

  if (caller !== null) {
    const callerScore = scores.get(caller);
    if (callerScore !== undefined && callerScore <= lowest) {
      return { scores, winnerId: caller, callerPenalised: false };
    }
    if (callerScore !== undefined) {
      scores.set(caller, callerScore + state.rules.cambioPenalty);
    }
  }

  return {
    scores,
    winnerId: lowestBySeatOrder(state, scores),
    callerPenalised: caller !== null,
  };
}

function lowestBySeatOrder(state: GameState, scores: ReadonlyMap<PlayerId, number>): PlayerId {
  let best: PlayerId | null = null;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const seat of state.seats) {
    const score = scores.get(seat.id);
    if (score !== undefined && score < bestScore) {
      bestScore = score;
      best = seat.id;
    }
  }
  if (best === null) throw new Error("cannot settle a round with no seats");
  return best;
}
