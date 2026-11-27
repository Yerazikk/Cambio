import { describe, expect, it } from "vitest";
import type { SlapOutcome } from "@cambio/shared";
import { reduce, type ReduceCtx } from "../../src/engine/reduce.js";
import type { GameState } from "../../src/engine/state.js";
import { mulberry32 } from "../../src/rng.js";
import { fixture } from "../helpers.js";

const ctx: ReduceCtx = { now: 2_000, rng: mulberry32(9) };

/** The discard top is a five, so any five in a hand is a legal slap target. */
function table(): GameState {
  return fixture({
    hands: { ana: ["S5", "S2", "S3"], bo: ["C5", "C7", "C8"], cy: ["D9", "D10"] },
    discard: ["H5"],
    deck: ["S13", "S12"],
  });
}

function resolve(
  state: GameState,
  slapperId: string,
  targetId: string,
  slot: number,
  marginMs: number | null = 12,
) {
  const result = reduce(state, slapperId, { a: "slapResolve", slapperId, targetId, slot, marginMs }, ctx);
  if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
  const event = result.out.find((o) => o.event.t === "slap.resolved")?.event;
  if (event?.t !== "slap.resolved") throw new Error("no slap.resolved event was emitted");
  return { state: result.state, event, out: result.out };
}

function outcomeOf(state: GameState, slapperId: string, targetId: string, slot: number): SlapOutcome {
  return resolve(state, slapperId, targetId, slot).event.outcome;
}

describe("slapping your own card", () => {
  /*
   * The card goes, and its place stays. A hand that closed up behind a slap
   * would move every card the player had memorised, which is the one thing a
   * memory game must never do to them.
   */
  it("discards it and leaves a hole where it was", () => {
    const { state, event } = resolve(table(), "ana", "ana", 0);

    expect(event.outcome).toBe("ownCardDiscarded");
    expect(state.seats[0]?.hand).toEqual([null, "S2", "S3"]);
    expect(state.discard).toEqual(["H5", "S5"]);
  });

  /** The face goes to the whole table: it is on the pile now, so it is public. */
  it("shows the card it turned over to everyone", () => {
    const { event, out } = resolve(table(), "ana", "ana", 0);

    expect(event.card?.id).toBe("S5");
    expect(out.every((o) => o.to === "all")).toBe(true);
  });

  it("broadcasts the result to everyone, with the margin", () => {
    const { event, out } = resolve(table(), "ana", "ana", 0, 15);

    expect(out.every((o) => o.to === "all")).toBe(true);
    expect(event.slapperId).toBe("ana");
    expect(event.marginMs).toBe(15);
  });

  it("ends the round immediately when it empties your hand", () => {
    const state = fixture({
      hands: { ana: ["S5"], bo: ["C7", "C8"] },
      discard: ["H5"],
      deck: ["S2"],
    });
    const result = resolve(state, "ana", "ana", 0);

    expect(result.state.phase).toBe("finished");
    // A hand of nothing but holes is a hand of no cards.
    expect(result.state.seats[0]?.hand).toEqual([null]);
    expect(result.state.scores?.get("ana")).toBe(0); // nothing left to score against
    expect(result.state.winnerId).toBe("ana");
    expect(result.out.some((o) => o.event.t === "game.over")).toBe(true);
  });
});

describe("slapping someone else's card", () => {
  it("discards their card and leaves you owing them one", () => {
    const { state, event } = resolve(table(), "ana", "bo", 0);

    expect(event.outcome).toBe("otherCardDiscarded");
    expect(state.seats[1]?.hand).toEqual([null, "C7", "C8"]);
    expect(state.discard).toEqual(["H5", "C5"]);
    expect(state.phase).toBe("slapGiveCard");
    // The debt remembers which hole it has to fill.
    expect(state.slapGiveFor).toEqual({ slapperId: "ana", targetId: "bo", slot: 0 });
  });

  /*
   * The card you owe goes into the hole you made, not onto the end of their
   * hand. It is the place it is owed for, and it leaves every other card in
   * that hand where its owner last saw it.
   */
  it("fills the hole it made with the card you choose, and resumes play", () => {
    const slapped = resolve(table(), "ana", "bo", 0).state;
    const result = reduce(slapped, "ana", { a: "slapGive", slot: 1 }, ctx);
    if (!result.ok) throw new Error(result.message);

    expect(result.state.seats[0]?.hand).toEqual(["S5", null, "S3"]);
    expect(result.state.seats[1]?.hand).toEqual(["S2", "C7", "C8"]);
    expect(result.state.slapGiveFor).toBeNull();
    expect(result.state.phase).toBe("awaitingAction");
  });

  it("will not let anyone else pay the debt", () => {
    const slapped = resolve(table(), "ana", "bo", 0).state;
    const result = reduce(slapped, "cy", { a: "slapGive", slot: 0 }, ctx);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("illegalAction");
  });

  it("blocks further play until the debt is paid", () => {
    const slapped = resolve(table(), "ana", "bo", 0).state;
    const result = reduce(slapped, "ana", { a: "drawDeck" }, ctx);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("illegalAction");
  });

  it("returns the table to the phase the slap interrupted", () => {
    // Ana is mid-turn holding a card when the slap lands.
    let state = table();
    const drawn = reduce(state, "ana", { a: "drawDeck" }, ctx);
    if (!drawn.ok) throw new Error(drawn.message);
    state = drawn.state;
    expect(state.phase).toBe("holdingCard");

    const slapped = resolve(state, "cy", "bo", 0).state;
    expect(slapped.phase).toBe("slapGiveCard");

    const paid = reduce(slapped, "cy", { a: "slapGive", slot: 0 }, ctx);
    if (!paid.ok) throw new Error(paid.message);

    // Ana is still holding her card and still owns the turn.
    expect(paid.state.phase).toBe("holdingCard");
    expect(paid.state.held).not.toBeNull();
  });

  it("ends the round when paying the debt empties your hand", () => {
    const state = fixture({
      hands: { ana: ["S2"], bo: ["C5", "C7"] },
      discard: ["H5"],
      deck: ["S3"],
    });
    const slapped = resolve(state, "ana", "bo", 0).state;
    const result = reduce(slapped, "ana", { a: "slapGive", slot: 0 }, ctx);
    if (!result.ok) throw new Error(result.message);

    expect(result.state.seats[0]?.hand).toEqual([null]);
    expect(result.state.phase).toBe("finished");
  });
});

describe("slapping the wrong card", () => {
  it("costs you a penalty card off the deck", () => {
    const { state, event } = resolve(table(), "ana", "ana", 1); // S2 against a five

    expect(event.outcome).toBe("wrongRankPenalty");
    expect(state.seats[0]?.hand).toEqual(["S5", "S2", "S3", "S12"]);
    expect(state.discard).toEqual(["H5"]); // nothing was discarded
  });

  it("gives you the penalty card face down, so you do not even know it", () => {
    const { state } = resolve(table(), "ana", "ana", 1);
    expect(state.knownBy.get("S12")).toBeUndefined();
  });

  it("penalises you for a wrong guess at someone else's card too", () => {
    const { state, event } = resolve(table(), "ana", "bo", 1); // C7 against a five

    expect(event.outcome).toBe("wrongRankPenalty");
    expect(state.seats[1]?.hand).toEqual(["C5", "C7", "C8"]); // Bo is untouched
    expect(state.seats[0]?.hand).toHaveLength(4); // Ana took the card
  });

  it("matches on rank alone, ignoring suit", () => {
    // C5 is a different suit from the H5 on the discard, and still a legal slap.
    expect(outcomeOf(table(), "bo", "bo", 0)).toBe("ownCardDiscarded");
  });

  it("lets a joker slap a joker but nothing else", () => {
    const jokers = fixture({
      hands: { ana: ["X0", "S2"], bo: ["S13", "C3"] },
      discard: ["X1"],
      deck: ["S4"],
    });
    expect(outcomeOf(jokers, "ana", "ana", 0)).toBe("ownCardDiscarded");
    // A king is not a joker, despite both being "high" cards.
    expect(outcomeOf(jokers, "bo", "bo", 0)).toBe("wrongRankPenalty");
  });
});

describe("slaps that are no longer playable", () => {
  it("voids a slap at a slot that no longer exists", () => {
    // Two slaps can be in flight at once; the second may target a gap the first
    // already created.
    const afterFirst = resolve(table(), "ana", "ana", 0).state;
    const { state, event } = resolve(afterFirst, "cy", "ana", 5);

    expect(event.outcome).toBe("noLongerValid");
    expect(state.seats[2]?.hand).toEqual(["D9", "D10"]);
  });

  it("voids a slap from a player who is no longer seated", () => {
    expect(outcomeOf(table(), "ghost", "ana", 0)).toBe("noLongerValid");
  });

  it("voids a slap against an empty discard pile", () => {
    const empty = fixture({
      hands: { ana: ["S5"], bo: ["C5"] },
      discard: [],
      deck: ["S4"],
    });
    expect(outcomeOf(empty, "ana", "ana", 0)).toBe("noLongerValid");
  });
});

describe("playing a queue of slaps out in order", () => {
  it("touches only the slapper and the target, never anyone else", () => {
    // One slap is one slap: Bo, who also slapped, is not touched by Ana's.
    const { state } = resolve(table(), "ana", "ana", 0);

    expect(state.seats[1]?.hand).toEqual(["C5", "C7", "C8"]);
  });

  it("lets the next slapper have their go after a wrong one", () => {
    // Ana slaps her two against a five and takes a penalty. The discard top is
    // untouched, so Bo's five behind her is still a legal slap.
    const first = resolve(table(), "ana", "ana", 1);
    expect(first.event.outcome).toBe("wrongRankPenalty");
    expect(first.state.discard).toEqual(["H5"]);

    const second = resolve(first.state, "bo", "bo", 0);
    expect(second.event.outcome).toBe("ownCardDiscarded");
    expect(second.state.seats[1]?.hand).toEqual([null, "C7", "C8"]);
    // Ana still carries the card her wrong slap cost her, on the end of her
    // hand: a penalty is a card you have been given, not one you got back.
    expect(second.state.seats[0]?.hand).toEqual(["S5", "S2", "S3", "S12"]);
  });

  it("penalises every wrong slapper in turn when nobody is right", () => {
    let state = table();
    for (const [slapper, slot] of [
      ["ana", 1],
      ["bo", 1],
    ] as const) {
      const played = resolve(state, slapper, slapper, slot);
      expect(played.event.outcome).toBe("wrongRankPenalty");
      state = played.state;
    }

    expect(state.seats[0]?.hand).toHaveLength(4);
    expect(state.seats[1]?.hand).toHaveLength(4);
    expect(state.discard).toEqual(["H5"]);
  });
});
