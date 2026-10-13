import type {
  Card,
  CardId,
  GameView,
  Phase,
  PlayerId,
  PlayerView,
  Power,
  RoomCode,
  RuleConfig,
  SlotView,
} from "@cambio/shared";

export type Seat = {
  id: PlayerId;
  name: string;
  connected: boolean;
  /** Slot index -> card. Length is variable: snaps shrink it, penalties grow it. */
  hand: CardId[];
  /** Initial study phase bookkeeping. */
  initialPeeksUsed: number;
  ready: boolean;
  calledCambio: boolean;
};

export type Held = { cardId: CardId; fromDiscard: boolean };

export type GameState = {
  code: RoomCode;
  rules: RuleConfig;
  phase: Phase;
  /** Bumped on every accepted mutation. See GameView.version. */
  version: number;
  /** Seat order is turn order. */
  seats: Seat[];
  hostId: PlayerId;
  /** Every card in the round, by id. Cards move between piles; this never changes. */
  cards: Map<CardId, Card>;
  deck: CardId[];
  discard: CardId[];
  /**
   * Who has legitimately seen each card, keyed on the card rather than the slot
   * it occupies. Keying on the card is what makes a blind J/Q swap come out
   * right: knowledge travels with the card into its new hand, instead of
   * wrongly staying with the slot.
   */
  knownBy: Map<CardId, Set<PlayerId>>;
  turnIndex: number;
  turnEndsAt: number | null;
  held: Held | null;
  pendingPower: Power | null;
  /** True once a king's peek is spent, so only the swap-or-skip choice remains. */
  kingPeeked: boolean;
  /** Set while a snapper who took another player's card owes them one back. */
  snapGiveFor: { snapperId: PlayerId; targetId: PlayerId } | null;
  cambioCallerId: PlayerId | null;
  finalTurnsRemaining: number | null;
  winnerId: PlayerId | null;
  scores: Map<PlayerId, number> | null;
};

/* ---------------------------------------------------------------- knowledge */

export function learn(state: GameState, cardId: CardId, playerId: PlayerId): void {
  const set = state.knownBy.get(cardId);
  if (set) set.add(playerId);
  else state.knownBy.set(cardId, new Set([playerId]));
}

export function forgetCard(state: GameState, cardId: CardId): void {
  state.knownBy.delete(cardId);
}

export function knows(state: GameState, cardId: CardId, playerId: PlayerId): boolean {
  return state.knownBy.get(cardId)?.has(playerId) ?? false;
}

/* -------------------------------------------------------------- accessors */

export function seatOf(state: GameState, playerId: PlayerId): Seat | undefined {
  return state.seats.find((s) => s.id === playerId);
}

export function cardAt(state: GameState, playerId: PlayerId, slot: number): Card | undefined {
  const seat = seatOf(state, playerId);
  const id = seat?.hand[slot];
  return id === undefined ? undefined : state.cards.get(id);
}

export function turnSeat(state: GameState): Seat | undefined {
  return state.seats[state.turnIndex];
}

export function discardTopId(state: GameState): CardId | undefined {
  return state.discard[state.discard.length - 1];
}

export function discardTopCard(state: GameState): Card | null {
  const id = discardTopId(state);
  return id === undefined ? null : (state.cards.get(id) ?? null);
}

/** Snapping is legal whenever there is a discard top to match against. */
export function snapOpen(state: GameState): boolean {
  if (state.phase === "lobby" || state.phase === "study" || state.phase === "finished") return false;
  if (state.snapGiveFor !== null) return false;
  if (state.cambioCallerId !== null && !state.rules.snapAfterCambio) return false;
  return discardTopId(state) !== undefined;
}

/* ------------------------------------------------------------------- views */

/**
 * Redact the authoritative state down to what one player is entitled to see.
 * Every byte sent to a client goes through here, which is what prevents the
 * hand leak the old broadcast-everything server would have had.
 */
export function viewFor(state: GameState, viewerId: PlayerId): GameView {
  const revealAll = state.phase === "finished";

  const players: PlayerView[] = state.seats.map((seat) => ({
    id: seat.id,
    name: seat.name,
    connected: seat.connected,
    isHost: seat.id === state.hostId,
    ready: seat.ready,
    calledCambio: seat.calledCambio,
    score: state.scores?.get(seat.id) ?? null,
    slots: seat.hand.map((cardId): SlotView => {
      const card = state.cards.get(cardId);
      const visible = card !== undefined && (revealAll || (state.rules.serverRemembersPeeks && knows(state, cardId, viewerId)));
      return visible ? { id: cardId, known: true, card } : { id: cardId, known: false };
    }),
  }));

  const turn = turnSeat(state);
  const isViewersTurn = turn?.id === viewerId;
  const heldCard = state.held !== null && isViewersTurn ? (state.cards.get(state.held.cardId) ?? null) : null;

  return {
    code: state.code,
    phase: state.phase,
    version: state.version,
    you: viewerId,
    players,
    turnPlayerId: turn?.id ?? null,
    turnEndsAt: state.turnEndsAt,
    deckCount: state.deck.length,
    discardTop: discardTopCard(state),
    discardCount: state.discard.length,
    heldCard,
    heldFromDiscard: state.held?.fromDiscard ?? false,
    pendingPower: isViewersTurn ? state.pendingPower : null,
    kingPeeked: state.kingPeeked,
    snapDebt: state.snapGiveFor,
    finalTurnsRemaining: state.finalTurnsRemaining,
    snapOpen: snapOpen(state),
    winnerId: state.winnerId,
  };
}

export const PHASES_IN_ROUND: readonly Phase[] = [
  "study",
  "awaitingAction",
  "holdingCard",
  "powerPeekOwn",
  "powerPeekOther",
  "powerBlindSwap",
  "powerKing",
  "snapGiveCard",
];
