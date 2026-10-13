import { describe, expect, it } from "vitest";
import { NUMERIC_RANKS, SUITS, pointsFor, powerFor, ranksMatch, isRed } from "@cambio/shared";
import { genCambioDeck, orderedCambioDeck, shuffle } from "../../src/deck.js";
import { mulberry32 } from "../../src/rng.js";

describe("deck composition", () => {
  const deck = orderedCambioDeck();

  it("is 54 cards: a standard 52 plus two jokers", () => {
    expect(deck).toHaveLength(54);
    expect(deck.filter((c) => c.rank === "joker")).toHaveLength(2);
    expect(deck.filter((c) => c.rank !== "joker")).toHaveLength(52);
  });

  it("holds every rank in every suit exactly once", () => {
    for (const suit of SUITS) {
      for (const rank of NUMERIC_RANKS) {
        const matches = deck.filter((c) => c.suit === suit && c.rank === rank);
        expect(matches, `${suit}${rank}`).toHaveLength(1);
      }
    }
  });

  it("gives every card a unique id", () => {
    expect(new Set(deck.map((c) => c.id)).size).toBe(54);
  });

  it("has no suit on the jokers", () => {
    for (const joker of deck.filter((c) => c.rank === "joker")) {
      expect(joker.suit).toBeNull();
    }
  });
});

describe("scoring values", () => {
  it("scores aces as 1 and pips at face value", () => {
    expect(pointsFor(1, "S")).toBe(1);
    for (const rank of [2, 3, 4, 5, 6, 7, 8, 9, 10] as const) {
      expect(pointsFor(rank, "C")).toBe(rank);
    }
  });

  it("scores jacks and queens as 10", () => {
    expect(pointsFor(11, "S")).toBe(10);
    expect(pointsFor(12, "H")).toBe(10);
  });

  it("splits the kings: black is the worst card, red is the best", () => {
    expect(pointsFor(13, "S")).toBe(13);
    expect(pointsFor(13, "C")).toBe(13);
    expect(pointsFor(13, "H")).toBe(-1);
    expect(pointsFor(13, "D")).toBe(-1);
  });

  it("scores jokers as zero", () => {
    expect(pointsFor("joker", null)).toBe(0);
  });

  it("precomputes points onto every dealt card", () => {
    for (const card of orderedCambioDeck()) {
      expect(card.points).toBe(pointsFor(card.rank, card.suit));
    }
  });

  it("treats hearts and diamonds as red", () => {
    expect(isRed("H")).toBe(true);
    expect(isRed("D")).toBe(true);
    expect(isRed("S")).toBe(false);
    expect(isRed("C")).toBe(false);
    expect(isRed(null)).toBe(false);
  });
});

describe("powers by rank", () => {
  it("maps each power rank to its power", () => {
    expect(powerFor(7)).toBe("peekOwn");
    expect(powerFor(8)).toBe("peekOwn");
    expect(powerFor(9)).toBe("peekOther");
    expect(powerFor(10)).toBe("peekOther");
    expect(powerFor(11)).toBe("blindSwap");
    expect(powerFor(12)).toBe("blindSwap");
    expect(powerFor(13)).toBe("king");
  });

  it("gives no power to low cards or jokers", () => {
    for (const rank of [1, 2, 3, 4, 5, 6] as const) expect(powerFor(rank)).toBeNull();
    expect(powerFor("joker")).toBeNull();
  });

  it("gives both kings the power, regardless of colour", () => {
    expect(powerFor(13)).toBe("king");
  });
});

describe("snap matching", () => {
  it("matches on rank alone, ignoring suit", () => {
    expect(ranksMatch(7, 7)).toBe(true);
    expect(ranksMatch(7, 8)).toBe(false);
  });

  it("lets a joker match another joker", () => {
    expect(ranksMatch("joker", "joker")).toBe(true);
    expect(ranksMatch("joker", 13)).toBe(false);
  });
});

describe("seeded shuffling", () => {
  it("is reproducible from a seed", () => {
    const a = genCambioDeck(mulberry32(42)).map((c) => c.id);
    const b = genCambioDeck(mulberry32(42)).map((c) => c.id);
    expect(a).toEqual(b);
  });

  it("produces different orders for different seeds", () => {
    const a = genCambioDeck(mulberry32(1)).map((c) => c.id);
    const b = genCambioDeck(mulberry32(2)).map((c) => c.id);
    expect(a).not.toEqual(b);
  });

  it("permutes rather than losing or duplicating cards", () => {
    const shuffled = genCambioDeck(mulberry32(7));
    expect(shuffled).toHaveLength(54);
    expect(new Set(shuffled.map((c) => c.id)).size).toBe(54);
  });

  it("leaves the input array untouched", () => {
    const source = [1, 2, 3, 4, 5];
    const copy = [...source];
    shuffle(source, mulberry32(3));
    expect(source).toEqual(copy);
  });
});
