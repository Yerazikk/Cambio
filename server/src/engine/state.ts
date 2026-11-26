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
  /** Slot index -> card. Length is variable: slaps shrink it, penalties grow it. */
  hand: CardId[];
  /** Which slots this player studied before the first turn, in click order. */
  initialPeeked: number[];
  ready: boolean;
  calledCambio: boolean;
};

export type Held = { cardId: CardId; fromDiscard: boolean };

/** One player's place in the slap queue, and the card they have named, if any. */
export type SlapQueueEntry = {
  playerId: PlayerId;
  /** The card this slap means, once it has been named. Null while unanswered. */
  targetId: PlayerId | null;
  slot: number | null;
};

/**
 * The table, stopped on a slap.
 *
 * Slapping is not a thing that happens alongside the game - it interrupts it.
 * The first slap takes the lock, every turn action is refused until the queue
 * has emptied, and the clock on the turn it interrupted is held rather than
 * run down, so nobody loses their turn to somebody else's slap.
 */
export type SlapLock = {
  /** queue[0] holds the lock; everyone behind is waiting their go. */
  queue: SlapQueueEntry[];
  /** When the holder's time to name a card runs out, or null when untimed. */
  endsAt: number | null;
  /** What was left of the interrupted turn's clock, to be given back after. */
  turnRemainingMs: number | null;
};

export type GameState = {
  code: RoomCode;
  rules: RuleConfig;
  /**
   * The card back the table plays with. Cosmetic, and the same for every card,
   * so it lives beside the rules rather than in them.
   */
  back: string;
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
   * it occupies. Keying on the card is what makes a sight-unseen J/Q swap come
   * out right: knowledge travels with the card into its new hand, instead of
   * wrongly staying with the slot.
   */
  knownBy: Map<CardId, Set<PlayerId>>;
  turnIndex: number;
  turnEndsAt: number | null;
  held: Held | null;
  pendingPower: Power | null;
  /** True once a king's peek is spent, so only the swap-or-skip choice remains. */
  kingPeeked: boolean;
  /** Set while a slapper who took another player's card owes them one back. */
  slapGiveFor: { slapperId: PlayerId; targetId: PlayerId } | null;
  /** Set while the table is stopped on a slap. See SlapLock. */
  slapLock: SlapLock | null;
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

/** Who the table is waiting on, if a slap has stopped it. */
export function lockHolder(state: GameState): SlapQueueEntry | null {
  return state.slapLock?.queue[0] ?? null;
}

/** Whether a slap has the table stopped. */
export function isLocked(state: GameState): boolean {
  return lockHolder(state) !== null;
}

/**
 * Slapping is legal whenever there is a discard top to match against.
 *
 * It stays legal while another player holds the lock: slapping then does not
 * jump the queue, it joins it - which is the whole of the rule that a slap is
 * never thrown away for being second.
 */
export function slapOpen(state: GameState): boolean {
  if (state.phase === "lobby" || state.phase === "study" || state.phase === "finished") return false;
  if (state.slapGiveFor !== null) return false;
  if (state.cambioCallerId !== null && !state.rules.slapAfterCambio) return false;
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
    // Which cards a player chose to study is their own business.
    peeked: seat.id === viewerId ? [...seat.initialPeeked] : [],
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
  // That someone is holding a card is public - you can see it leave the pile.
  // Its face is not, unless it came off the discard pile face up, in which
  // case the whole table already read it on the way out.
  const holder = state.held === null ? null : (turn?.id ?? null);
  const heldPublic = state.held?.fromDiscard === true;
  const heldCard =
    state.held !== null && (isViewersTurn || heldPublic) ? (state.cards.get(state.held.cardId) ?? null) : null;

  return {
    code: state.code,
    phase: state.phase,
    version: state.version,
    you: viewerId,
    players,
    turnPlayerId: turn?.id ?? null,
    turnEndsAt: state.turnEndsAt,
    decks: state.rules.decks,
    optionalPowers: state.rules.optionalPowers,
    back: state.back,
    deckCount: state.deck.length,
    discardTop: discardTopCard(state),
    discardCount: state.discard.length,
    heldBy: holder,
    heldCard,
    heldFromDiscard: state.held?.fromDiscard ?? false,
    pendingPower: isViewersTurn ? state.pendingPower : null,
    kingPeeked: state.kingPeeked,
    slapDebt: state.slapGiveFor,
    finalTurnsRemaining: state.finalTurnsRemaining,
    slapOpen: slapOpen(state),
    slapLock: lockView(state),
    winnerId: state.winnerId,
  };
}

/** The stopped table as the clients see it: who owes a card, and who is next. */
function lockView(state: GameState): GameView["slapLock"] {
  const lock = state.slapLock;
  const holder = lock?.queue[0];
  if (lock === null || lock === undefined || holder === undefined) return null;
  return {
    holderId: holder.playerId,
    waiting: lock.queue.slice(1).map((entry) => entry.playerId),
    endsAt: lock.endsAt,
  };
}

export const PHASES_IN_ROUND: readonly Phase[] = [
  "study",
  "awaitingAction",
  "holdingCard",
  "powerPeekOwn",
  "powerPeekOther",
  "powerFreeSwap",
  "powerKing",
  "slapGiveCard",
];
