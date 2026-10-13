import { describe, expect, it } from "vitest";
import { handScore, rawScores, settle } from "../../src/engine/score.js";
import { ALL_CARDS, fixture } from "../helpers.js";

describe("hand scoring", () => {
  const score = (ids: string[]) => handScore(ids, ALL_CARDS);

  it("scores an empty hand as zero", () => {
    expect(score([])).toBe(0);
  });

  it("sums aces and pips", () => {
    expect(score(["S1", "S2", "S3"])).toBe(6);
    expect(score(["H10", "D4"])).toBe(14);
  });

  it("scores jacks and queens as ten each", () => {
    expect(score(["S11", "H12"])).toBe(20);
  });

  it("makes a pair of red kings the best possible hand", () => {
    expect(score(["H13", "D13"])).toBe(-2);
  });

  it("makes a pair of black kings a disaster", () => {
    expect(score(["S13", "C13"])).toBe(26);
  });

  it("scores jokers as zero", () => {
    expect(score(["X0", "X1"])).toBe(0);
  });

  it("lets red kings pull a hand below zero", () => {
    expect(score(["H13", "D13", "X0", "S1"])).toBe(-1);
  });
});

describe("settling a round", () => {
  it("awards the win to the Cambio caller when their hand is lowest", () => {
    const state = fixture({ hands: { ana: ["H13"], bo: ["S5"] }, phase: "finished" });
    state.cambioCallerId = "ana";

    const result = settle(state);
    expect(result.winnerId).toBe("ana");
    expect(result.callerPenalised).toBe(false);
    expect(result.scores.get("ana")).toBe(-1);
    expect(result.scores.get("bo")).toBe(5);
  });

  it("gives ties to the caller, since calling carried the risk", () => {
    const state = fixture({ hands: { ana: ["S5"], bo: ["C5"] }, phase: "finished" });
    state.cambioCallerId = "ana";

    const result = settle(state);
    expect(result.winnerId).toBe("ana");
    expect(result.callerPenalised).toBe(false);
    expect(result.scores.get("ana")).toBe(5);
  });

  it("penalises a caller who was not lowest, and hands the win elsewhere", () => {
    const state = fixture({ hands: { ana: ["S5"], bo: ["S1"] }, phase: "finished" });
    state.cambioCallerId = "ana";

    const result = settle(state);
    expect(result.winnerId).toBe("bo");
    expect(result.callerPenalised).toBe(true);
    expect(result.scores.get("ana")).toBe(15); // 5 + the 10-point penalty
    expect(result.scores.get("bo")).toBe(1);
  });

  it("breaks a tie between non-callers by seat order, never by map order", () => {
    const state = fixture({
      hands: { ana: ["S13"], bo: ["S2"], cy: ["H2"] },
      phase: "finished",
    });
    state.cambioCallerId = "ana";

    const result = settle(state);
    expect(result.scores.get("ana")).toBe(23); // 13 + 10
    expect(result.winnerId).toBe("bo"); // bo seats before cy
  });

  it("honours a reconfigured penalty", () => {
    const state = fixture({
      hands: { ana: ["S5"], bo: ["S1"] },
      phase: "finished",
      rules: { cambioPenalty: 25 },
    });
    state.cambioCallerId = "ana";

    expect(settle(state).scores.get("ana")).toBe(30);
  });

  it("reports raw scores without any penalty applied", () => {
    const state = fixture({ hands: { ana: ["S5"], bo: ["S1"] }, phase: "finished" });
    state.cambioCallerId = "ana";

    const raw = rawScores(state);
    expect(raw.get("ana")).toBe(5);
    expect(raw.get("bo")).toBe(1);
  });
});
