import { DEFAULT_BACK, DEFAULT_RULES, type CardId, type PlayerId, type RoomCode, type RuleConfig } from "@cambio/shared";
import { genCambioDeck, shuffle } from "../deck.js";
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
    publicIds: new Map(),
    knownBy: new Map(),
    turnIndex: 0,
    turnEndsAt: null,
    held: null,
    pendingPower: null,
    kingPicks: [],
    slapGiveFor: null,
    slapLock: null,
    cambioCallerId: null,
    finalTurnsRemaining: null,
    winnerId: null,
    scores: null,
  };
}

/**
 * Hand every card in the round an opaque name to be known by off the server.
 *
 * The real ids spell out what they are - `S7`, `H13` - and a slot is sent to
 * every player at the table, so the real ones can never leave. The handles are
 * dealt from a shuffled list, so neither the handle nor the order they were
 * assigned in says anything about the card.
 */
function mintPublicIds(ids: readonly CardId[], rng: Rng): Map<CardId, string> {
  const handles = shuffle(
    ids.map((_, index) => `c${index}`),
    rng,
  );
  return new Map(ids.map((id, index) => [id, handles[index] ?? `c${index}`]));
}

/**
 * Deal a fresh round. Each player gets `handSize` cards and one card is turned
 * up to seed the discard pile, so a slap is legal from the first move.
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
    publicIds: mintPublicIds(ids, rng),
    knownBy: new Map(),
    turnIndex: 0,
    turnEndsAt: null,
    held: null,
    pendingPower: null,
    kingPicks: [],
    slapGiveFor: null,
    slapLock: null,
    cambioCallerId: null,
    finalTurnsRemaining: null,
    winnerId: null,
    scores: null,
  };
}

/**
 * Put a finished table back in its lobby, ready to be dealt again.
 *
 * This is what "play again" does. It is deliberately not a fresh deal: the
 * host may want to change the deck count or let somebody else sit down first,
 * and a table that jumped straight into a new round gave them no chance to.
 */
export function returnToLobby(state: GameState): GameState {
  return {
    ...state,
    version: state.version + 1,
    phase: "lobby",
    seats: state.seats.map((seat) => ({
      ...seat,
      hand: [],
      initialPeeked: [],
      ready: false,
      calledCambio: false,
    })),
    cards: new Map(),
    deck: [],
    discard: [],
    publicIds: new Map(),
    knownBy: new Map(),
    turnIndex: 0,
    turnEndsAt: null,
    held: null,
    pendingPower: null,
    kingPicks: [],
    slapGiveFor: null,
    slapLock: null,
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
