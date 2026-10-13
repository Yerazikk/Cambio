import { NUMERIC_RANKS, SUITS, makeCard, type Card } from "@cambio/shared";
import type { Rng } from "./rng.js";

/** Fisher-Yates. Returns a new array; the input is left untouched. */
export function shuffle<T>(input: readonly T[], rng: Rng): T[] {
  const a = [...input];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const ai = a[i] as T;
    const aj = a[j] as T;
    a[i] = aj;
    a[j] = ai;
  }
  return a;
}

/** An unshuffled 54-card Cambio deck: 52 standard cards plus two jokers. */
export function orderedCambioDeck(): Card[] {
  const cards: Card[] = [];
  for (const suit of SUITS) {
    for (const rank of NUMERIC_RANKS) {
      cards.push(makeCard(rank, suit, `${suit}${rank}`));
    }
  }
  cards.push(makeCard("joker", null, "X0"));
  cards.push(makeCard("joker", null, "X1"));
  return cards;
}

export function genCambioDeck(rng: Rng): Card[] {
  return shuffle(orderedCambioDeck(), rng);
}
