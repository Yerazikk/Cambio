import { describe, expect, it } from "vitest";
import type { EngineAction, PlayerId } from "@cambio/shared";
import { reduce, type ReduceCtx } from "../../src/engine/reduce.js";
import { knows, type GameState } from "../../src/engine/state.js";
import { mulberry32 } from "../../src/rng.js";
import { fixture } from "../helpers.js";

const ctx: ReduceCtx = { now: 1_000, rng: mulberry32(1) };

/** Apply an action and insist it was legal, so tests read as a script of play. */
function ok(state: GameState, actor: PlayerId, action: EngineAction): GameState {
  const result = reduce(state, actor, action, ctx);
  if (!result.ok) throw new Error(`expected ${action.a} to be legal, got ${result.code}: ${result.message}`);
  return result.state;
}

/** Apply an action and insist it was rejected, returning the error code. */
function rejected(state: GameState, actor: PlayerId, action: EngineAction): string {
  const result = reduce(state, actor, action, ctx);
  if (result.ok) throw new Error(`expected ${action.a} to be rejected, but it succeeded`);
  return result.code;
}

const twoHanded = () =>
  fixture({
    hands: { ana: ["S2", "S3", "S4", "S5"], bo: ["C2", "C3", "C4", "C5"] },
    discard: ["D2"],
    deck: ["H6", "H7"],
  });

describe("purity", () => {
  it("never mutates the state it was given", () => {
    const before = twoHanded();
    const snapshot = structuredClone(before);
    reduce(before, "ana", { a: "drawDeck" }, ctx);
    expect(before).toEqual(snapshot);
  });
});

describe("the study phase", () => {
  const studying = () =>
    fixture({
      hands: { ana: ["S2", "S3", "S4", "S5"], bo: ["C2", "C3", "C4", "C5"] },
      discard: ["D2"],
      phase: "study",
    });

  it("reveals a studied card to that player alone", () => {
    const state = studying();
    state.seats.forEach((s) => (s.ready = false));

    const result = reduce(state, "ana", { a: "initialPeek", slot: 2 }, ctx);
    if (!result.ok) throw new Error(result.message);

    const faces = result.out.filter((o) => o.event.t === "card.revealed");
    expect(faces).toHaveLength(1);
    expect(faces[0]?.to).toBe("ana");
    const event = faces[0]?.event;
    if (event?.t === "card.revealed") expect(event.card.id).toBe("S4");
  });

  it("tells the whole table which card was studied, but not what it is", () => {
    const state = studying();
    state.seats.forEach((s) => (s.ready = false));

    const result = reduce(state, "ana", { a: "initialPeek", slot: 2 }, ctx);
    if (!result.ok) throw new Error(result.message);

    // Everyone sees you pick a card up at a real table; only you see its face.
    const announced = result.out.filter((o) => o.event.t === "table.event");
    expect(announced).toHaveLength(1);
    expect(announced[0]?.to).toBe("all");
    const event = announced[0]?.event;
    if (event?.t === "table.event") {
      expect(event.kind).toBe("peek");
      expect(event.byId).toBe("ana");
      expect(event.slots).toEqual([{ ownerId: "ana", slot: 2 }]);
      expect(JSON.stringify(event)).not.toContain("S4");
    }
  });

  it("allows exactly the configured number of initial peeks", () => {
    let state = studying();
    state.seats.forEach((s) => (s.ready = false));

    state = ok(state, "ana", { a: "initialPeek", slot: 2 });
    state = ok(state, "ana", { a: "initialPeek", slot: 3 });
    expect(rejected(state, "ana", { a: "initialPeek", slot: 2 })).toBe("illegalAction");
  });

  it("only lets you study the bottom row of your hand", () => {
    const state = studying();
    state.seats.forEach((s) => (s.ready = false));

    expect(rejected(state, "ana", { a: "initialPeek", slot: 0 })).toBe("badSlot");
    expect(rejected(state, "ana", { a: "initialPeek", slot: 1 })).toBe("badSlot");
  });

  it("refuses to study the same card twice", () => {
    const state = studying();
    state.seats.forEach((s) => (s.ready = false));

    const once = ok(state, "ana", { a: "initialPeek", slot: 2 });
    expect(rejected(once, "ana", { a: "initialPeek", slot: 2 })).toBe("illegalAction");
  });

  it("rejects studying a slot that does not exist", () => {
    const state = studying();
    state.seats.forEach((s) => (s.ready = false));
    expect(rejected(state, "ana", { a: "initialPeek", slot: 9 })).toBe("badSlot");
  });

  it("starts play only once every player is ready", () => {
    let state = studying();
    state.seats.forEach((s) => (s.ready = false));

    state = ok(state, "ana", { a: "readyUp" });
    expect(state.phase).toBe("study");

    state = ok(state, "bo", { a: "readyUp" });
    expect(state.phase).toBe("awaitingAction");
    expect(state.turnIndex).toBe(0);
    expect(state.turnEndsAt).toBe(ctx.now + state.rules.turnMs);
  });
});

describe("drawing", () => {
  it("takes the top of the deck and shows it only to the drawer", () => {
    const state = ok(twoHanded(), "ana", { a: "drawDeck" });

    expect(state.phase).toBe("holdingCard");
    expect(state.held).toEqual({ cardId: "H7", fromDiscard: false });
    expect(state.deck).toEqual(["H6"]);
    expect(knows(state, "H7", "ana")).toBe(true);
    expect(knows(state, "H7", "bo")).toBe(false);
  });

  it("takes the discard top and removes it from the pile", () => {
    const state = ok(twoHanded(), "ana", { a: "drawDiscard" });

    expect(state.held).toEqual({ cardId: "D2", fromDiscard: true });
    expect(state.discard).toEqual([]);
  });

  it("refuses a draw from the player whose turn it is not", () => {
    expect(rejected(twoHanded(), "bo", { a: "drawDeck" })).toBe("notYourTurn");
  });

  it("refuses a second draw while already holding a card", () => {
    const state = ok(twoHanded(), "ana", { a: "drawDeck" });
    expect(rejected(state, "ana", { a: "drawDeck" })).toBe("illegalAction");
  });

  it("refuses a draw from an empty discard pile", () => {
    const state = fixture({
      hands: { ana: ["S2", "S3"], bo: ["C2", "C3"] },
      discard: [],
      deck: ["H6"],
    });
    expect(rejected(state, "ana", { a: "drawDiscard" })).toBe("illegalAction");
  });
});

describe("resolving a drawn card", () => {
  it("swaps the drawn card in and sends the displaced one to the discard", () => {
    let state = ok(twoHanded(), "ana", { a: "drawDeck" });
    state = ok(state, "ana", { a: "swapWithSlot", slot: 1 });

    expect(state.seats[0]?.hand).toEqual(["S2", "H7", "S4", "S5"]);
    expect(state.discard).toEqual(["D2", "S3"]);
    expect(state.held).toBeNull();
    expect(state.turnIndex).toBe(1); // the turn passed to Bo
  });

  it("discards a plain drawn card and simply ends the turn", () => {
    let state = ok(twoHanded(), "ana", { a: "drawDeck" }); // H7 is a power card
    state = ok(state, "ana", { a: "swapWithSlot", slot: 0 });

    // Bo draws the H6, which carries no power.
    state = ok(state, "bo", { a: "drawDeck" });
    state = ok(state, "bo", { a: "discardDrawn" });

    expect(state.phase).toBe("awaitingAction");
    expect(state.pendingPower).toBeNull();
    expect(state.discard.at(-1)).toBe("H6");
  });

  it("will not let a card taken from the discard pile be re-discarded", () => {
    // Otherwise a player could burn a turn without ever changing their hand.
    const state = ok(twoHanded(), "ana", { a: "drawDiscard" });
    expect(rejected(state, "ana", { a: "discardDrawn" })).toBe("illegalAction");
  });

  it("grants no power to a card taken from the discard pile", () => {
    const state = fixture({
      hands: { ana: ["S2", "S3"], bo: ["C2", "C3"] },
      discard: ["H7"], // a peek-own card, but it is coming from the pile
      deck: ["D4"],
    });
    const after = ok(ok(state, "ana", { a: "drawDiscard" }), "ana", { a: "swapWithSlot", slot: 0 });

    expect(after.pendingPower).toBeNull();
    expect(after.phase).toBe("awaitingAction");
  });

  it("rejects a swap into a slot that does not exist", () => {
    const state = ok(twoHanded(), "ana", { a: "drawDeck" });
    expect(rejected(state, "ana", { a: "swapWithSlot", slot: 9 })).toBe("badSlot");
  });
});

describe("powers", () => {
  /** Draw `card` from the deck and discard it, so its power triggers. */
  function trigger(card: string, hands?: Record<PlayerId, string[]>) {
    const state = fixture({
      hands: hands ?? { ana: ["S2", "S3", "S4", "S5"], bo: ["C2", "C3", "C4", "C5"], cy: ["D6", "D7"] },
      discard: ["D2"],
      deck: [card],
    });
    return ok(ok(state, "ana", { a: "drawDeck" }), "ana", { a: "discardDrawn" });
  }

  describe("seven and eight: look at your own card", () => {
    it("enters the peek-own phase", () => {
      for (const card of ["S7", "S8"]) {
        const state = trigger(card);
        expect(state.phase, card).toBe("powerPeekOwn");
        expect(state.pendingPower, card).toBe("peekOwn");
      }
    });

    it("reveals the chosen card to the player and ends the turn", () => {
      const state = trigger("S7");
      const result = reduce(state, "ana", { a: "peekOwn", slot: 2 }, ctx);
      if (!result.ok) throw new Error(result.message);

      expect(result.out[0]?.to).toBe("ana");
      const event = result.out[0]?.event;
      if (event?.t === "card.revealed") {
        expect(event.card.id).toBe("S4");
        expect(event.ownerId).toBe("ana");
      }
      expect(result.state.phase).toBe("awaitingAction");
      expect(result.state.turnIndex).toBe(1);
    });
  });

  describe("nine and ten: look at someone else's card", () => {
    it("enters the peek-other phase", () => {
      for (const card of ["S9", "S10"]) {
        expect(trigger(card).phase, card).toBe("powerPeekOther");
      }
    });

    it("reveals an opponent's card to the player alone", () => {
      const state = trigger("S9");
      const result = reduce(state, "ana", { a: "peekOther", playerId: "bo", slot: 3 }, ctx);
      if (!result.ok) throw new Error(result.message);

      expect(result.out[0]?.to).toBe("ana");
      const event = result.out[0]?.event;
      if (event?.t === "card.revealed") {
        expect(event.card.id).toBe("C5");
        expect(event.ownerId).toBe("bo");
      }
      expect(knows(result.state, "C5", "ana")).toBe(true);
      expect(knows(result.state, "C5", "bo")).toBe(false);
    });

    it("refuses to be aimed at your own hand", () => {
      const state = trigger("S9");
      expect(rejected(state, "ana", { a: "peekOther", playerId: "ana", slot: 0 })).toBe("badTarget");
    });

    it("refuses an unknown player or a missing slot", () => {
      const state = trigger("S9");
      expect(rejected(state, "ana", { a: "peekOther", playerId: "nobody", slot: 0 })).toBe("badTarget");
      expect(rejected(state, "ana", { a: "peekOther", playerId: "bo", slot: 9 })).toBe("badSlot");
    });
  });

  describe("jack and queen: swap any two cards", () => {
    it("enters the free-swap phase", () => {
      for (const card of ["S11", "S12"]) {
        expect(trigger(card).phase, card).toBe("powerFreeSwap");
        expect(trigger(card).pendingPower, card).toBe("freeSwap");
      }
    });

    it("carries existing knowledge along with the swapped cards", () => {
      let state = trigger("S11");
      // Pretend Cy had previously peeked Bo's slot 1.
      state.knownBy.set("C3", new Set(["cy"]));
      state = ok(state, "ana", { a: "freeSwap", aId: "ana", aSlot: 0, bId: "bo", bSlot: 1 });

      // That card now sits in Ana's slot 0, and Cy still knows it.
      expect(state.seats[0]?.hand[0]).toBe("C3");
      expect(knows(state, "C3", "cy")).toBe(true);
    });

    it("swaps one of yours for one of theirs", () => {
      const state = ok(trigger("S12"), "ana", {
        a: "freeSwap",
        aId: "ana",
        aSlot: 0,
        bId: "bo",
        bSlot: 1,
      });

      expect(state.seats[0]?.hand).toEqual(["C3", "S3", "S4", "S5"]);
      expect(state.seats[1]?.hand).toEqual(["C2", "S2", "C4", "C5"]);
      expect(state.phase).toBe("awaitingAction");
    });

    it("swaps two of your own cards", () => {
      const state = ok(trigger("S12"), "ana", {
        a: "freeSwap",
        aId: "ana",
        aSlot: 0,
        bId: "ana",
        bSlot: 3,
      });

      expect(state.seats[0]?.hand).toEqual(["S5", "S3", "S4", "S2"]);
      expect(state.phase).toBe("awaitingAction");
    });

    it("swaps two cards between other players, leaving your own hand alone", () => {
      const state = ok(trigger("S12"), "ana", {
        a: "freeSwap",
        aId: "bo",
        aSlot: 0,
        bId: "cy",
        bSlot: 1,
      });

      expect(state.seats[0]?.hand).toEqual(["S2", "S3", "S4", "S5"]);
      expect(state.seats[1]?.hand).toEqual(["D7", "C3", "C4", "C5"]);
      expect(state.seats[2]?.hand).toEqual(["D6", "C2"]);
    });

    it("swaps two cards in a single opponent's hand", () => {
      const state = ok(trigger("S12"), "ana", {
        a: "freeSwap",
        aId: "bo",
        aSlot: 0,
        bId: "bo",
        bSlot: 2,
      });

      expect(state.seats[1]?.hand).toEqual(["C4", "C3", "C2", "C5"]);
    });

    it("reveals nothing - it moves cards without showing them", () => {
      const result = reduce(
        trigger("S12"),
        "ana",
        { a: "freeSwap", aId: "ana", aSlot: 0, bId: "bo", bSlot: 1 },
        ctx,
      );
      if (!result.ok) throw new Error(result.message);

      expect(result.out.filter((o) => o.event.t === "card.revealed")).toHaveLength(0);
      expect(knows(result.state, "C3", "ana")).toBe(false);
    });

    it("refuses to swap a card with itself", () => {
      const state = trigger("S12");
      expect(rejected(state, "ana", { a: "freeSwap", aId: "bo", aSlot: 1, bId: "bo", bSlot: 1 })).toBe("badTarget");
    });

    it("refuses an unknown player or a missing slot", () => {
      const state = trigger("S12");
      expect(rejected(state, "ana", { a: "freeSwap", aId: "nobody", aSlot: 0, bId: "bo", bSlot: 0 })).toBe("badTarget");
      expect(rejected(state, "ana", { a: "freeSwap", aId: "ana", aSlot: 0, bId: "cy", bSlot: 9 })).toBe("badSlot");
    });

    it("is only one player's to resolve", () => {
      const state = trigger("S12");
      expect(rejected(state, "bo", { a: "freeSwap", aId: "bo", aSlot: 0, bId: "ana", bSlot: 0 })).toBe("notYourTurn");
    });

    it("may be declined like any other power", () => {
      const state = ok(trigger("S12"), "ana", { a: "forfeitPower" });
      expect(state.seats[0]?.hand).toEqual(["S2", "S3", "S4", "S5"]);
      expect(state.phase).toBe("awaitingAction");
      expect(state.turnIndex).toBe(1);
    });
  });

  describe("king: look, then choose", () => {
    it("enters the king phase", () => {
      const state = trigger("S13");
      expect(state.phase).toBe("powerKing");
      expect(state.kingPeeked).toBe(false);
    });

    it("does not end the turn on the peek - the choice still remains", () => {
      const state = ok(trigger("S13"), "ana", { a: "peekOther", playerId: "bo", slot: 0 });

      expect(state.phase).toBe("powerKing");
      expect(state.kingPeeked).toBe(true);
      expect(state.turnIndex).toBe(0);
    });

    it("may look at your own card, unlike a nine or ten", () => {
      const state = ok(trigger("S13"), "ana", { a: "peekOther", playerId: "ana", slot: 0 });
      expect(state.kingPeeked).toBe(true);
    });

    it("swaps one of yours for one of theirs after looking", () => {
      let state = ok(trigger("S13"), "ana", { a: "peekOther", playerId: "bo", slot: 0 });
      state = ok(state, "ana", { a: "freeSwap", aId: "ana", aSlot: 1, bId: "bo", bSlot: 0 });

      expect(state.seats[0]?.hand).toEqual(["S2", "C2", "S4", "S5"]);
      expect(state.seats[1]?.hand).toEqual(["S3", "C3", "C4", "C5"]);
      expect(state.phase).toBe("awaitingAction");
    });

    it("swaps any two cards after looking, not just one of yours for one of theirs", () => {
      const peeked = ok(trigger("S13"), "ana", { a: "peekOther", playerId: "bo", slot: 0 });

      // Two of your own.
      const mine = ok(peeked, "ana", { a: "freeSwap", aId: "ana", aSlot: 0, bId: "ana", bSlot: 3 });
      expect(mine.seats[0]?.hand).toEqual(["S5", "S3", "S4", "S2"]);

      // Two that are not yours at all.
      const theirs = ok(peeked, "ana", { a: "freeSwap", aId: "bo", aSlot: 0, bId: "cy", bSlot: 1 });
      expect(theirs.seats[0]?.hand).toEqual(["S2", "S3", "S4", "S5"]);
      expect(theirs.seats[1]?.hand).toEqual(["D7", "C3", "C4", "C5"]);
      expect(theirs.seats[2]?.hand).toEqual(["D6", "C2"]);
    });

    it("refuses to swap a card with itself", () => {
      const state = ok(trigger("S13"), "ana", { a: "peekOther", playerId: "bo", slot: 0 });
      expect(rejected(state, "ana", { a: "freeSwap", aId: "ana", aSlot: 0, bId: "ana", bSlot: 0 })).toBe("badTarget");
    });

    it("passes after looking, leaving hands untouched", () => {
      const peeked = ok(trigger("S13"), "ana", { a: "peekOther", playerId: "bo", slot: 0 });
      const state = ok(peeked, "ana", { a: "kingSkip" });

      expect(state.seats[0]?.hand).toEqual(["S2", "S3", "S4", "S5"]);
      expect(state.phase).toBe("awaitingAction");
      expect(state.turnIndex).toBe(1);
    });

    it("insists you look before you swap or pass", () => {
      const state = trigger("S13");
      expect(rejected(state, "ana", { a: "freeSwap", aId: "ana", aSlot: 0, bId: "bo", bSlot: 0 })).toBe(
        "illegalAction",
      );
      expect(rejected(state, "ana", { a: "kingSkip" })).toBe("illegalAction");
    });

    it("allows only one look", () => {
      const state = ok(trigger("S13"), "ana", { a: "peekOther", playerId: "bo", slot: 0 });
      expect(rejected(state, "ana", { a: "peekOther", playerId: "bo", slot: 1 })).toBe("illegalAction");
    });
  });

  it("refuses a power action from a player who is not resolving it", () => {
    const state = trigger("S7");
    expect(rejected(state, "bo", { a: "peekOwn", slot: 0 })).toBe("notYourTurn");
  });

  it("refuses a power action that does not match the pending power", () => {
    const state = trigger("S7"); // peek-own is pending
    expect(rejected(state, "ana", { a: "freeSwap", aId: "ana", aSlot: 0, bId: "bo", bSlot: 0 })).toBe("illegalAction");
  });
});

describe("turn order", () => {
  it("passes round the table and wraps", () => {
    let state = fixture({
      hands: { ana: ["S2", "S3"], bo: ["C2", "C3"], cy: ["D2", "D3"] },
      discard: ["H2"],
      deck: ["S4", "S5", "S6"],
    });

    for (const player of ["ana", "bo", "cy"]) {
      state = ok(state, player, { a: "drawDeck" });
      state = ok(state, player, { a: "swapWithSlot", slot: 0 });
    }
    expect(state.turnIndex).toBe(0); // wrapped back to Ana
  });

  it("skips a player who has dropped, so a disconnect cannot stall the table", () => {
    let state = fixture({
      hands: { ana: ["S2", "S3"], bo: ["C2", "C3"], cy: ["D2", "D3"] },
      discard: ["H2"],
      deck: ["S4", "S5"],
    });
    state.seats[1]!.connected = false;

    state = ok(state, "ana", { a: "drawDeck" });
    state = ok(state, "ana", { a: "swapWithSlot", slot: 0 });

    expect(state.seats[state.turnIndex]?.id).toBe("cy");
  });

  it("refreshes the turn deadline each turn", () => {
    let state = twoHanded();
    state = ok(state, "ana", { a: "drawDeck" });
    state = ok(state, "ana", { a: "swapWithSlot", slot: 0 });
    expect(state.turnEndsAt).toBe(ctx.now + state.rules.turnMs);
  });

  it("leaves the turn untimed when the clock is disabled", () => {
    let state = fixture({
      hands: { ana: ["S2", "S3"], bo: ["C2", "C3"] },
      discard: ["H2"],
      deck: ["S4"],
      rules: { turnMs: 0 },
    });
    state = ok(state, "ana", { a: "drawDeck" });
    state = ok(state, "ana", { a: "swapWithSlot", slot: 0 });
    expect(state.turnEndsAt).toBeNull();
  });
});

describe("calling Cambio", () => {
  const threeHanded = () =>
    fixture({
      hands: { ana: ["S1", "S2"], bo: ["C5", "C6"], cy: ["D7", "D8"] },
      discard: ["H2"],
      // Deliberately power-free, so a final turn ends on the discard itself.
      deck: ["D2", "D3", "D4", "D5"],
    });

  it("gives every other player exactly one final turn", () => {
    const state = ok(threeHanded(), "ana", { a: "callCambio" });

    expect(state.cambioCallerId).toBe("ana");
    expect(state.seats[0]?.calledCambio).toBe(true);
    expect(state.finalTurnsRemaining).toBe(2);
    expect(state.turnIndex).toBe(1);
  });

  it("ends the round after those final turns and settles the scores", () => {
    let state = ok(threeHanded(), "ana", { a: "callCambio" });

    state = ok(state, "bo", { a: "drawDeck" });
    state = ok(state, "bo", { a: "swapWithSlot", slot: 0 });
    expect(state.phase).toBe("awaitingAction");
    expect(state.finalTurnsRemaining).toBe(1);

    const last = reduce(state, "cy", { a: "drawDeck" }, ctx);
    if (!last.ok) throw new Error(last.message);
    const final = reduce(last.state, "cy", { a: "swapWithSlot", slot: 0 }, ctx);
    if (!final.ok) throw new Error(final.message);

    expect(final.state.phase).toBe("finished");
    expect(final.state.scores).not.toBeNull();
    expect(final.out.some((o) => o.event.t === "game.over")).toBe(true);
  });

  it("cannot be called twice", () => {
    const state = ok(threeHanded(), "ana", { a: "callCambio" });
    expect(rejected(state, "bo", { a: "callCambio" })).toBe("illegalAction");
  });

  it("cannot be called out of turn", () => {
    expect(rejected(threeHanded(), "bo", { a: "callCambio" })).toBe("notYourTurn");
  });

  it("cannot be called while holding a card", () => {
    const state = ok(threeHanded(), "ana", { a: "drawDeck" });
    expect(rejected(state, "ana", { a: "callCambio" })).toBe("illegalAction");
  });

  it("awards the win to the caller who really was lowest", () => {
    let state = ok(threeHanded(), "ana", { a: "callCambio" }); // Ana holds A+2 = 3
    state = ok(state, "bo", { a: "drawDeck" });
    state = ok(state, "bo", { a: "discardDrawn" });
    const result = reduce(state, "cy", { a: "drawDeck" }, ctx);
    if (!result.ok) throw new Error(result.message);
    const final = reduce(result.state, "cy", { a: "discardDrawn" }, ctx);
    if (!final.ok) throw new Error(final.message);

    expect(final.state.phase).toBe("finished");
    expect(final.state.winnerId).toBe("ana");
  });
});

describe("running out of deck", () => {
  it("reshuffles the discard pile back into the deck, keeping the top card up", () => {
    const state = fixture({
      hands: { ana: ["S2", "S3"], bo: ["C2", "C3"] },
      discard: ["H2", "H3", "H4", "H5"],
      deck: [],
    });

    const result = reduce(state, "ana", { a: "drawDeck" }, ctx);
    if (!result.ok) throw new Error(result.message);

    // H5 stayed face up as the snap target; the rest became the new deck.
    expect(result.state.discard).toEqual(["H5"]);
    expect(result.state.deck.length + 1).toBe(3); // 3 reshuffled, 1 now held
    expect(result.state.held?.cardId).not.toBe("H5");
  });

  it("ends the round when there is genuinely nothing left to draw", () => {
    const state = fixture({
      hands: { ana: ["S2"], bo: ["C2"] },
      discard: ["H2"],
      deck: [],
    });

    const result = reduce(state, "ana", { a: "drawDeck" }, ctx);
    if (!result.ok) throw new Error(result.message);
    expect(result.state.phase).toBe("finished");
  });
});

describe("guards that apply everywhere", () => {
  it("rejects actions from someone who is not seated", () => {
    expect(rejected(twoHanded(), "stranger", { a: "drawDeck" })).toBe("sessionInvalid");
  });

  it("refuses a raw snap, which belongs to the arbiter", () => {
    expect(rejected(twoHanded(), "ana", { a: "snap", targetId: "ana", slot: 0 })).toBe("illegalAction");
  });

  it("refuses a snap payment from someone who owes nothing", () => {
    expect(rejected(twoHanded(), "ana", { a: "snapGive", slot: 0 })).toBe("illegalAction");
  });

  it("refuses play actions once the round is finished", () => {
    const state = twoHanded();
    state.phase = "finished";
    expect(rejected(state, "ana", { a: "drawDeck" })).toBe("illegalAction");
  });
});
