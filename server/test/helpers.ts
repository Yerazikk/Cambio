import {
  DEFAULT_BACK,
  DEFAULT_RULES,
  type Card,
  type CardId,
  type GameView,
  type PlayerId,
  type Phase,
  type RuleConfig,
  type SlotView,
} from "@cambio/shared";
import { orderedCambioDeck } from "../src/deck.js";
import type { GameState, Seat } from "../src/engine/state.js";

/** Every card in the game, addressable by id: "S7" is the seven of spades, "X0" a joker. */
export const ALL_CARDS: ReadonlyMap<CardId, Card> = new Map(orderedCambioDeck().map((c) => [c.id, c]));

export function card(id: CardId): Card {
  const found = ALL_CARDS.get(id);
  if (!found) throw new Error(`no such card: ${id}`);
  return found;
}

export type Fixture = {
  /**
   * Seat order is turn order. Values are card ids, in slot order, with `null`
   * for a hole - a place a card has been slapped out of.
   */
  hands: Record<PlayerId, (CardId | null)[]>;
  /** Top of the discard pile is the LAST element. */
  discard?: CardId[];
  /** Next card drawn is the LAST element, so `pop()` takes it. */
  deck?: CardId[];
  phase?: Phase;
  rules?: Partial<RuleConfig>;
  turnIndex?: number;
  turnEndsAt?: number | null;
  hostId?: PlayerId;
};

/**
 * Build a fully determined state for rule tests. Nothing is shuffled and no
 * clock is read, so every engine test is exact rather than probabilistic.
 */
export function fixture(spec: Fixture): GameState {
  const ids = Object.keys(spec.hands);
  const first = ids[0];
  if (first === undefined) throw new Error("a fixture needs at least one seat");

  const seats: Seat[] = ids.map((id) => ({
    id,
    name: id,
    connected: true,
    hand: [...(spec.hands[id] ?? [])],
    initialPeeked: [],
    ready: true,
    calledCambio: false,
  }));

  const used = [
    ...seats.flatMap((s) => s.hand),
    ...(spec.discard ?? []),
    ...(spec.deck ?? []),
  ].filter((id): id is CardId => id !== null);
  for (const id of used) card(id);

  const duplicates = used.filter((id, i) => used.indexOf(id) !== i);
  if (duplicates.length > 0) throw new Error(`fixture reuses cards: ${duplicates.join(", ")}`);

  return {
    code: "TESTRM",
    version: 0,
    rules: { ...DEFAULT_RULES, ...spec.rules },
    back: DEFAULT_BACK,
    phase: spec.phase ?? "awaitingAction",
    seats,
    hostId: spec.hostId ?? first,
    cards: new Map(ALL_CARDS),
    deck: [...(spec.deck ?? [])],
    discard: [...(spec.discard ?? [])],
    // Fixtures keep the real ids as handles: a test that reads a slot wants to
    // see "S7", and nothing it drives is a client that could be leaked to.
    publicIds: new Map([...ALL_CARDS.keys()].map((id) => [id, id])),
    knownBy: new Map(),
    turnIndex: spec.turnIndex ?? 0,
    turnEndsAt: spec.turnEndsAt ?? null,
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
 * Flatten a view's slots for a given player into the card ids it actually
 * shows, with null where a face is hidden or the place is a hole.
 */
export function slotFaces(view: GameView, playerId: PlayerId): (CardId | null)[] {
  const player = view.players.find((p) => p.id === playerId);
  if (!player) throw new Error(`no such player in view: ${playerId}`);
  return player.slots.map((s) => (s.kind === "up" ? s.card.id : null));
}

/** Where a hand has holes, as seen from a view. */
export function slotKinds(view: GameView, playerId: PlayerId): SlotView["kind"][] {
  const player = view.players.find((p) => p.id === playerId);
  if (!player) throw new Error(`no such player in view: ${playerId}`);
  return player.slots.map((s) => s.kind);
}
