import { describe, expect, it } from "vitest";
import type { SnapOutcome } from "@cambio/shared";
import { reduce, type ReduceCtx } from "../../src/engine/reduce.js";
import type { GameState } from "../../src/engine/state.js";
import { mulberry32 } from "../../src/rng.js";
import { fixture } from "../helpers.js";

const ctx: ReduceCtx = { now: 2_000, rng: mulberry32(9) };

/** The discard top is a five, so any five in a hand is a legal snap target. */
function table(): GameState {
  return fixture({
    hands: { ana: ["S5", "S2", "S3"], bo: ["C5", "C7", "C8"], cy: ["D9", "D10"] },
    discard: ["H5"],
    deck: ["S13", "S12"],
  });
}

function resolve(
  state: GameState,
  winnerId: string | null,
  targetId: string,
  slot: number,
  marginMs: number | null = 12,
) {
  const result = reduce(state, winnerId ?? "ana", { a: "snapResolve", winnerId, targetId, slot, marginMs }, ctx);
  if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
  const event = result.out.find((o) => o.event.t === "snap.resolved")?.event;
  if (event?.t !== "snap.resolved") throw new Error("no snap.resolved event was emitted");
  return { state: result.state, event, out: result.out };
}

function outcomeOf(state: GameState, winnerId: string | null, targetId: string, slot: number): SnapOutcome {
  return resolve(state, winnerId, targetId, slot).event.outcome;
}

describe("snapping your own card", () => {
  it("discards it and shrinks your hand", () => {
    const { state, event } = resolve(table(), "ana", "ana", 0);

    expect(event.outcome).toBe("ownCardDiscarded");
    expect(state.seats[0]?.hand).toEqual(["S2", "S3"]);
    expect(state.discard).toEqual(["H5", "S5"]);
  });

  it("broadcasts the result to everyone, with the winning margin", () => {
    const { event, out } = resolve(table(), "ana", "ana", 0, 15);

    expect(out.every((o) => o.to === "all")).toBe(true);
    expect(event.winnerId).toBe("ana");
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
    expect(result.state.seats[0]?.hand).toEqual([]);
    expect(result.state.scores?.get("ana")).toBe(0); // nothing left to score against
    expect(result.state.winnerId).toBe("ana");
    expect(result.out.some((o) => o.event.t === "game.over")).toBe(true);
  });
});

describe("snapping someone else's card", () => {
  it("discards their card and leaves you owing them one", () => {
    const { state, event } = resolve(table(), "ana", "bo", 0);

    expect(event.outcome).toBe("otherCardDiscarded");
    expect(state.seats[1]?.hand).toEqual(["C7", "C8"]);
    expect(state.discard).toEqual(["H5", "C5"]);
    expect(state.phase).toBe("snapGiveCard");
    expect(state.snapGiveFor).toEqual({ snapperId: "ana", targetId: "bo" });
  });

  it("hands over the card you choose and resumes play", () => {
    const snapped = resolve(table(), "ana", "bo", 0).state;
    const result = reduce(snapped, "ana", { a: "snapGive", slot: 1 }, ctx);
    if (!result.ok) throw new Error(result.message);

    expect(result.state.seats[0]?.hand).toEqual(["S5", "S3"]);
    expect(result.state.seats[1]?.hand).toEqual(["C7", "C8", "S2"]);
    expect(result.state.snapGiveFor).toBeNull();
    expect(result.state.phase).toBe("awaitingAction");
  });

  it("will not let anyone else pay the debt", () => {
    const snapped = resolve(table(), "ana", "bo", 0).state;
    const result = reduce(snapped, "cy", { a: "snapGive", slot: 0 }, ctx);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("illegalAction");
  });

  it("blocks further play until the debt is paid", () => {
    const snapped = resolve(table(), "ana", "bo", 0).state;
    const result = reduce(snapped, "ana", { a: "drawDeck" }, ctx);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("illegalAction");
  });

  it("returns the table to the phase the snap interrupted", () => {
    // Ana is mid-turn holding a card when the snap lands.
    let state = table();
    const drawn = reduce(state, "ana", { a: "drawDeck" }, ctx);
    if (!drawn.ok) throw new Error(drawn.message);
    state = drawn.state;
    expect(state.phase).toBe("holdingCard");

    const snapped = resolve(state, "cy", "bo", 0).state;
    expect(snapped.phase).toBe("snapGiveCard");

    const paid = reduce(snapped, "cy", { a: "snapGive", slot: 0 }, ctx);
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
    const snapped = resolve(state, "ana", "bo", 0).state;
    const result = reduce(snapped, "ana", { a: "snapGive", slot: 0 }, ctx);
    if (!result.ok) throw new Error(result.message);

    expect(result.state.seats[0]?.hand).toEqual([]);
    expect(result.state.phase).toBe("finished");
  });
});

describe("snapping the wrong card", () => {
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
    // C5 is a different suit from the H5 on the discard, and still a legal snap.
    expect(outcomeOf(table(), "bo", "bo", 0)).toBe("ownCardDiscarded");
  });

  it("lets a joker snap a joker but nothing else", () => {
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

describe("races nobody won", () => {
  it("reports a null winner as void", () => {
    const { state, event } = resolve(table(), null, "ana", 0);

    expect(event.outcome).toBe("noLongerValid");
    expect(event.winnerId).toBeNull();
    expect(state.seats[0]?.hand).toEqual(["S5", "S2", "S3"]); // nothing moved
  });

  it("voids a snap at a slot that no longer exists", () => {
    // Two snaps can be in flight at once; the second may target a gap the first
    // already created.
    const afterFirst = resolve(table(), "ana", "ana", 0).state;
    const { state, event } = resolve(afterFirst, "cy", "ana", 5);

    expect(event.outcome).toBe("noLongerValid");
    expect(state.seats[2]?.hand).toEqual(["D9", "D10"]);
  });

  it("voids a snap from a player who is no longer seated", () => {
    expect(outcomeOf(table(), "ghost", "ana", 0)).toBe("noLongerValid");
  });

  it("voids a snap against an empty discard pile", () => {
    const empty = fixture({
      hands: { ana: ["S5"], bo: ["C5"] },
      discard: [],
      deck: ["S4"],
    });
    expect(outcomeOf(empty, "ana", "ana", 0)).toBe("noLongerValid");
  });
});

describe("the losers of a race", () => {
  it("are not penalised - only the winning snap is applied", () => {
    // Ana wins the race; Bo's simultaneous snap simply never reaches the
    // reducer, so Bo's hand is untouched.
    const { state } = resolve(table(), "ana", "ana", 0);

    expect(state.seats[1]?.hand).toEqual(["C5", "C7", "C8"]);
    expect(state.seats[1]?.hand).toHaveLength(3);
  });
});
