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

/**
 * An unshuffled Cambio deck: 52 standard cards plus two jokers, repeated once
 * per pack. Card ids have to stay unique across the whole table because all
 * knowledge is keyed on them, so every pack past the first tags its ids - the
 * first pack keeps the bare `S7` form the fixtures are written in.
 */
export function orderedCambioDeck(packs = 1): Card[] {
  const cards: Card[] = [];
  for (let pack = 0; pack < packs; pack++) {
    const tag = pack === 0 ? "" : `#${pack + 1}`;
    for (const suit of SUITS) {
      for (const rank of NUMERIC_RANKS) {
        cards.push(makeCard(rank, suit, `${suit}${rank}${tag}`));
      }
    }
    cards.push(makeCard("joker", null, `X0${tag}`));
    cards.push(makeCard("joker", null, `X1${tag}`));
  }
  return cards;
}

export function genCambioDeck(rng: Rng, packs = 1): Card[] {
  return shuffle(orderedCambioDeck(packs), rng);
}
