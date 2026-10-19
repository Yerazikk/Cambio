export const SUITS = ["S", "H", "D", "C"] as const;
export type Suit = (typeof SUITS)[number];

/** 1 = Ace … 11 = Jack, 12 = Queen, 13 = King. Jokers carry "joker" instead. */
export const NUMERIC_RANKS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13] as const;
export type NumericRank = (typeof NUMERIC_RANKS)[number];
export type Rank = NumericRank | "joker";

export type CardId = string;

/**
 * A single physical card. `id` is stable for the life of a round and is what
 * knowledge is keyed on, so a card carries what players know about it as it
 * moves between hands.
 */
export type Card = {
  id: CardId;
  rank: Rank;
  /** null for jokers. */
  suit: Suit | null;
  points: number;
};

export const RED_SUITS: readonly Suit[] = ["H", "D"];

export function isRed(suit: Suit | null): boolean {
  return suit !== null && RED_SUITS.includes(suit);
}

/**
 * Cambio scoring: aces are 1, pips are face value, J/Q are 10, and kings split
 * — black kings are the worst card in the deck at 13, red kings the best at -1.
 * Jokers are 0.
 */
export function pointsFor(rank: Rank, suit: Suit | null): number {
  if (rank === "joker") return 0;
  if (rank === 13) return isRed(suit) ? -1 : 13;
  if (rank === 11 || rank === 12) return 10;
  return rank;
}

export function makeCard(rank: Rank, suit: Suit | null, id: CardId): Card {
  return { id, rank, suit, points: pointsFor(rank, suit) };
}

const RANK_LABELS: Record<number, string> = { 1: "A", 11: "J", 12: "Q", 13: "K" };

export function rankLabel(rank: Rank): string {
  if (rank === "joker") return "JOKER";
  return RANK_LABELS[rank] ?? String(rank);
}

const SUIT_SYMBOLS: Record<Suit, string> = { S: "♠", H: "♥", D: "♦", C: "♣" };

export function suitSymbol(suit: Suit): string {
  return SUIT_SYMBOLS[suit];
}

export function cardLabel(card: Card): string {
  if (card.rank === "joker") return "\u{1F0CF}";
  return `${rankLabel(card.rank)}${card.suit ? suitSymbol(card.suit) : ""}`;
}

/**
 * Snap legality. Two cards match on rank alone — suit is irrelevant, and two
 * jokers match each other.
 */
export function ranksMatch(a: Rank, b: Rank): boolean {
  return a === b;
}

/** Which power a card triggers when discarded straight from the deck. */
export type Power = "peekOwn" | "peekOther" | "freeSwap" | "king";

export function powerFor(rank: Rank): Power | null {
  switch (rank) {
    case 7:
    case 8:
      return "peekOwn";
    case 9:
    case 10:
      return "peekOther";
    // Jacks and queens are the free hand: they move any two cards on the
    // table, which includes two of your own and two of someone else's.
    case 11:
    case 12:
      return "freeSwap";
    case 13:
      return "king";
    default:
      return null;
  }
}
