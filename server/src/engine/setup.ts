import { DEFAULT_BACK, DEFAULT_RULES, type PlayerId, type RoomCode, type RuleConfig } from "@cambio/shared";
import { genCambioDeck } from "../deck.js";
import type { Rng } from "../rng.js";
import type { GameState, Seat } from "./state.js";

export type SeatSpec = { id: PlayerId; name: string };

export function emptyState(code: RoomCode, hostId: PlayerId, rules: RuleConfig = DEFAULT_RULES): GameState {
  return {
    code,
    rules,
    back: DEFAULT_BACK,
    phase: "lobby",
    version: 0,
    seats: [],
    hostId,
    cards: new Map(),
    deck: [],
    discard: [],
    knownBy: new Map(),
    turnIndex: 0,
    turnEndsAt: null,
    held: null,
    pendingPower: null,
    kingPeeked: false,
    snapGiveFor: null,
    cambioCallerId: null,
    finalTurnsRemaining: null,
    winnerId: null,
    scores: null,
  };
}

/**
 * Deal a fresh round. Each player gets `handSize` cards and one card is turned
 * up to seed the discard pile, so a snap is legal from the first move.
 */
export function startRound(state: GameState, rng: Rng): GameState {
  const deck = genCambioDeck(rng, state.rules.decks);
  const cards = new Map(deck.map((c) => [c.id, c]));
  const ids = deck.map((c) => c.id);

  let cursor = 0;
  const seats: Seat[] = state.seats.map((seat) => ({
    ...seat,
    hand: ids.slice(cursor, (cursor += state.rules.handSize)),
    initialPeeked: [],
    ready: false,
    calledCambio: false,
  }));

  const discardSeed = ids[cursor++];
  if (discardSeed === undefined) throw new Error("deck exhausted while dealing");

  return {
    ...state,
    version: state.version + 1,
    phase: "study",
    seats,
    cards,
    deck: ids.slice(cursor),
    discard: [discardSeed],
    knownBy: new Map(),
    turnIndex: 0,
    turnEndsAt: null,
    held: null,
    pendingPower: null,
    kingPeeked: false,
    snapGiveFor: null,
    cambioCallerId: null,
    finalTurnsRemaining: null,
    winnerId: null,
    scores: null,
  };
}

export function addSeat(state: GameState, spec: SeatSpec): GameState {
  const seat: Seat = {
    id: spec.id,
    name: spec.name,
    connected: true,
    hand: [],
    initialPeeked: [],
    ready: false,
    calledCambio: false,
  };
  return { ...state, version: state.version + 1, seats: [...state.seats, seat] };
}
