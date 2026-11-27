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
  /**
   * Slot index -> card, or null where a card has left.
   *
   * A hand never closes up. Slapping a card away or handing one over leaves
   * the place it held empty, because the alternative - sliding everything
   * down - moves cards the player has memorised, and remembering where your
   * cards are is the whole game. Penalties still grow it off the end.
   */
  hand: (CardId | null)[];
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
   * The handle each card is known by off this server.
   *
   * A card's real id names it - `S7` is the seven of spades - and a slot goes
   * to every player at the table, so the real one can never be sent. These are
   * dealt out of a shuffled list at the start of the round, so a handle says
   * nothing about the card, its rank, or where in the deck it started.
   */
  publicIds: Map<CardId, string>;
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
  /**
   * The cards a king has named, in order. A king names two and is shown both
   * together before it is asked whether to trade them, so this fills up to two
   * entries and is then the pair the choice applies to.
   */
  kingPicks: { ownerId: PlayerId; slot: number }[];
  /**
   * Set while a slapper who took another player's card owes them one back.
   * `slot` is the hole the slap left, which is where the paid card goes.
   */
  slapGiveFor: { slapperId: PlayerId; targetId: PlayerId; slot: number } | null;
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
  return id === undefined || id === null ? undefined : state.cards.get(id);
}

/** The cards actually in a hand, with its holes left out. */
export function handCards(seat: Seat): CardId[] {
  return seat.hand.filter((id): id is CardId => id !== null);
}

/**
 * Whether a hand is empty - which ends the round on the spot. Holes do not
 * count: a hand of four holes is a hand of no cards.
 */
export function handIsEmpty(seat: Seat): boolean {
  return seat.hand.every((id) => id === null);
}

/** The card in a slot, or null for a hole and undefined for no such slot. */
export function slotCardId(seat: Seat, slot: number): CardId | null | undefined {
  return seat.hand[slot];
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
      // A hole stays a hole, so nobody's hand shifts under them mid-round.
      if (cardId === null) return { kind: "gap" };
      const card = state.cards.get(cardId);
      if (card === undefined) return { kind: "gap" };
      const visible = revealAll || (state.rules.serverRemembersPeeks && knows(state, cardId, viewerId));
      const id = publicIdOf(state, cardId);
      return visible ? { kind: "up", id, card } : { kind: "down", id };
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
    // Which cards a king has named is public - the table watches them get
    // picked up - even though only the king sees what is on them.
    kingPicks: state.kingPicks.map((pick) => ({ ownerId: pick.ownerId, slot: pick.slot })),
    slapDebt: state.slapGiveFor,
    finalTurnsRemaining: state.finalTurnsRemaining,
    slapOpen: slapOpen(state),
    slapLock: lockView(state),
    winnerId: state.winnerId,
  };
}

/**
 * The handle a card is known by off this server.
 *
 * Falls back to the real id only for a state that was never dealt - an empty
 * lobby has no cards to leak - so a round in progress always has one.
 */
export function publicIdOf(state: GameState, cardId: CardId): string {
  return state.publicIds.get(cardId) ?? cardId;
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
