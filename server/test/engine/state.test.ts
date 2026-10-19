import { describe, expect, it } from "vitest";
import { knows, learn, snapOpen, viewFor } from "../../src/engine/state.js";
import { fixture, slotFaces } from "../helpers.js";

describe("view redaction", () => {
  it("hides every hand from every viewer during play", () => {
    const state = fixture({
      hands: { ana: ["S7", "H13"], bo: ["C3", "D9"] },
      discard: ["S2"],
    });

    for (const viewer of ["ana", "bo"]) {
      const view = viewFor(state, viewer);
      expect(slotFaces(view, "ana"), `${viewer} looking at ana`).toEqual([null, null]);
      expect(slotFaces(view, "bo"), `${viewer} looking at bo`).toEqual([null, null]);
    }
  });

  it("still reports hand sizes and card ids so the table can be drawn", () => {
    const state = fixture({ hands: { ana: ["S7", "H13", "C3"], bo: ["D9"] } });
    const view = viewFor(state, "bo");
    expect(view.players.find((p) => p.id === "ana")?.slots).toHaveLength(3);
    expect(view.players.find((p) => p.id === "bo")?.slots).toHaveLength(1);
  });

  it("reveals every hand once the round is finished", () => {
    const state = fixture({ hands: { ana: ["S7"], bo: ["C3"] }, phase: "finished" });
    const view = viewFor(state, "ana");
    expect(slotFaces(view, "ana")).toEqual(["S7"]);
    expect(slotFaces(view, "bo")).toEqual(["C3"]);
  });

  it("keeps peeks out of the state view when the server is set to forget them", () => {
    const state = fixture({ hands: { ana: ["S7"], bo: ["C3"] } });
    learn(state, "S7", "ana");
    // The peek was legitimate, but a forgetful server never re-sends the face:
    // remembering it is the player's job.
    expect(slotFaces(viewFor(state, "ana"), "ana")).toEqual([null]);
  });

  it("folds peeks into the view when the server is set to remember them", () => {
    const state = fixture({
      hands: { ana: ["S7", "H13"], bo: ["C3"] },
      rules: { serverRemembersPeeks: true },
    });
    learn(state, "S7", "ana");

    expect(slotFaces(viewFor(state, "ana"), "ana")).toEqual(["S7", null]);
    // Knowledge is per-viewer: Bo learned nothing.
    expect(slotFaces(viewFor(state, "bo"), "ana")).toEqual([null, null]);
  });

  it("shows the held card only to the player holding it", () => {
    const state = fixture({ hands: { ana: ["S7"], bo: ["C3"] }, deck: ["D5"] });
    state.held = { cardId: "D5", fromDiscard: false };

    expect(viewFor(state, "ana").heldCard?.id).toBe("D5");
    expect(viewFor(state, "bo").heldCard).toBeNull();
  });

  it("tells everyone who is holding a card, if not what it is", () => {
    const state = fixture({ hands: { ana: ["S7"], bo: ["C3"] }, deck: ["D5"] });
    state.held = { cardId: "D5", fromDiscard: false };

    // A card leaving the pile is something the whole table watches happen.
    expect(viewFor(state, "ana").heldBy).toBe("ana");
    expect(viewFor(state, "bo").heldBy).toBe("ana");
    expect(viewFor(state, "bo").heldCard).toBeNull();
  });

  it("shows a card taken off the discard pile to the whole table", () => {
    const state = fixture({ hands: { ana: ["S7"], bo: ["C3"] }, discard: ["D5"] });
    state.discard = [];
    state.held = { cardId: "D5", fromDiscard: true };

    // It was face up on the pile a moment ago, so hiding it now would be a
    // fiction - and knowing it is exactly what makes taking one a decision.
    expect(viewFor(state, "bo").heldCard?.id).toBe("D5");
  });

  it("leaves heldBy null when nobody is holding anything", () => {
    const state = fixture({ hands: { ana: ["S7"], bo: ["C3"] } });

    expect(viewFor(state, "ana").heldBy).toBeNull();
  });

  it("shows a pending power only to the player who must resolve it", () => {
    const state = fixture({ hands: { ana: ["S7"], bo: ["C3"] } });
    state.pendingPower = "peekOther";

    expect(viewFor(state, "ana").pendingPower).toBe("peekOther");
    expect(viewFor(state, "bo").pendingPower).toBeNull();
  });

  it("publishes the discard top to everyone, since snapping depends on it", () => {
    const state = fixture({ hands: { ana: ["S7"], bo: ["C3"] }, discard: ["S2", "H9"] });
    for (const viewer of ["ana", "bo"]) {
      expect(viewFor(state, viewer).discardTop?.id).toBe("H9");
      expect(viewFor(state, viewer).discardCount).toBe(2);
    }
  });
});

describe("knowledge follows the card, not the slot", () => {
  it("carries a peeked card's knowledge into its new hand after a swap", () => {
    const state = fixture({
      hands: { ana: ["S7"], bo: ["C3", "D9"], cy: ["H4"] },
      rules: { serverRemembersPeeks: true },
    });

    // Ana peeks Bo's slot 1.
    learn(state, "D9", "ana");
    expect(slotFaces(viewFor(state, "ana"), "bo")).toEqual([null, "D9"]);

    // A jack or queen moves that card to Cy's slot 0.
    state.seats[1]!.hand[1] = "H4";
    state.seats[2]!.hand[0] = "D9";

    // Ana should now know Cy's slot 0 - the knowledge travelled with the card.
    // Slot-keyed knowledge would have wrongly left her "knowing" Bo's slot 1.
    expect(slotFaces(viewFor(state, "ana"), "cy")).toEqual(["D9"]);
    expect(slotFaces(viewFor(state, "ana"), "bo")).toEqual([null, null]);
  });

  it("tracks knowledge independently per player", () => {
    const state = fixture({ hands: { ana: ["S7"], bo: ["C3"] } });
    learn(state, "S7", "ana");

    expect(knows(state, "S7", "ana")).toBe(true);
    expect(knows(state, "S7", "bo")).toBe(false);
  });

  it("lets two players know the same card", () => {
    const state = fixture({ hands: { ana: ["S7"], bo: ["C3"] } });
    learn(state, "S7", "ana");
    learn(state, "S7", "bo");

    expect(knows(state, "S7", "ana")).toBe(true);
    expect(knows(state, "S7", "bo")).toBe(true);
  });
});

describe("snap availability", () => {
  it("is open during play while a discard top exists", () => {
    const state = fixture({ hands: { ana: ["S7"], bo: ["C3"] }, discard: ["S2"] });
    expect(snapOpen(state)).toBe(true);
    expect(viewFor(state, "ana").snapOpen).toBe(true);
  });

  it("is closed with an empty discard pile", () => {
    const state = fixture({ hands: { ana: ["S7"], bo: ["C3"] }, discard: [] });
    expect(snapOpen(state)).toBe(false);
  });

  it("is closed in the lobby, the study phase, and after the round ends", () => {
    for (const phase of ["lobby", "study", "finished"] as const) {
      const state = fixture({ hands: { ana: ["S7"], bo: ["C3"] }, discard: ["S2"], phase });
      expect(snapOpen(state), phase).toBe(false);
    }
  });

  it("is closed while a snapper still owes a card", () => {
    const state = fixture({ hands: { ana: ["S7"], bo: ["C3"] }, discard: ["S2"] });
    state.snapGiveFor = { snapperId: "ana", targetId: "bo" };
    expect(snapOpen(state)).toBe(false);
  });

  it("honours the rule flag for snapping after a Cambio call", () => {
    const base = { hands: { ana: ["S7"], bo: ["C3"] }, discard: ["S2"] };

    const live = fixture({ ...base, rules: { snapAfterCambio: true } });
    live.cambioCallerId = "ana";
    expect(snapOpen(live)).toBe(true);

    const closed = fixture({ ...base, rules: { snapAfterCambio: false } });
    closed.cambioCallerId = "ana";
    expect(snapOpen(closed)).toBe(false);
  });
});
