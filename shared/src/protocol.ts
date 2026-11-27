import type { Card, CardId, Power } from "./cards.js";

export type PlayerId = string;
export type RoomCode = string;

/* ------------------------------------------------------------------ actions */

/**
 * Game actions. Every one of these is fed to the pure reducer, so this union is
 * exactly the rule surface the engine tests enumerate.
 *
 * `slap` is the one exception: the socket layer intercepts it, hands it to the
 * arbiter to put it in the queue, and only the resolved outcome reaches the
 * reducer as `slapResolve` - once per slap that actually gets its turn.
 */
export type Action =
  /* turn start */
  | { a: "drawDeck" }
  | { a: "drawDiscard" }
  | { a: "callCambio" }
  /* holding a drawn card */
  | { a: "swapWithSlot"; slot: number }
  | { a: "discardDrawn" }
  /* powers */
  | { a: "peekOwn"; slot: number }
  | { a: "peekOther"; playerId: PlayerId; slot: number }
  /**
   * A jack, a queen, or a king that has spent its look. Both ends are named
   * outright, because either end may belong to anyone - two of yours, two of
   * theirs, or one of each.
   */
  | { a: "freeSwap"; aId: PlayerId; aSlot: number; bId: PlayerId; bSlot: number }
  /**
   * One of the two cards a king names. The king does not look and then decide
   * what to do about it - it picks both cards first, is shown them together,
   * and only then asks whether to trade them.
   */
  | { a: "kingPick"; playerId: PlayerId; slot: number }
  /** Trade the two cards the king looked at. */
  | { a: "kingSwap" }
  /** Having seen both, leave them where they are. */
  | { a: "kingSkip" }
  /**
   * Decline a power outright. Legal only at a table whose host has made powers
   * optional; by default a power you triggered is a power you resolve.
   */
  | { a: "forfeitPower" }
  /* pre-round study phase */
  | { a: "initialPeek"; slot: number }
  | { a: "readyUp" }
  /* slap */
  /**
   * Claim a slap without naming a card yet. This is the SLAP button: it puts
   * you in the queue and stops the table, and the card you mean follows as a
   * `slap` once the queue reaches you.
   */
  | { a: "slapClaim" }
  /**
   * Name the card. Sent on its own it both claims and answers in one gesture -
   * the number-key fast path - and sent while you hold the lock it is the
   * answer the table is waiting for.
   */
  | { a: "slap"; targetId: PlayerId; slot: number }
  | { a: "slapGive"; slot: number };

/**
 * Emitted by the arbiter, never sent by a client. One of these is fed to the
 * reducer for each slap the queue actually reaches.
 */
export type ResolvedAction =
  | {
      a: "slapResolve";
      slapperId: PlayerId;
      targetId: PlayerId;
      slot: number;
      marginMs: number | null;
    }
  /**
   * The lock holder never named a card. Emitted by the clock rather than by a
   * client: claiming a slap and then not making one costs a card, or stopping
   * the table would be free.
   */
  | { a: "slapForfeit"; slapperId: PlayerId }
  /**
   * A power ran out of clock. Emitted by the turn timer only, because at a
   * table where powers are compulsory no player may walk away from one - and
   * something still has to unstick a seat nobody is sitting in.
   */
  | { a: "powerTimeout" };

export type EngineAction = Action | ResolvedAction;

/* ------------------------------------------------------- client -> server */

export type ClientMsg =
  | { t: "room.create"; name: string }
  | { t: "room.join"; code: RoomCode; name: string }
  | { t: "room.resume"; token: string }
  | { t: "room.leave" }
  | { t: "lobby.kick"; playerId: PlayerId }
  /** Host only, lobby only: how many packs to deal the next round from. */
  | { t: "lobby.decks"; decks: number }
  /** Host only: which card back the whole table plays with. */
  | { t: "lobby.back"; back: string }
  /** Host only, lobby only: whether a power may be declined. */
  | { t: "lobby.powers"; optional: boolean }
  | { t: "lobby.start" }
  /** Deal another round to the same table, once one has finished. */
  | { t: "lobby.restart" }
  | { t: "act"; action: Action }
  /** Echo of the server's latency probe. Carries no clock, only the nonce. */
  | { t: "pong"; nonce: number };

/* ------------------------------------------------------- server -> client */

export type Phase =
  | "lobby"
  | "study"
  | "awaitingAction"
  | "holdingCard"
  | "powerPeekOwn"
  | "powerPeekOther"
  | "powerFreeSwap"
  /** A king, still naming the two cards it will look at. */
  | "powerKing"
  /** A king that has shown its two cards and is waiting on swap-or-keep. */
  | "powerKingChoice"
  | "slapGiveCard"
  | "finished";

/**
 * One place in a hand, as a given viewer sees it.
 *
 * Faces appear only where that viewer is entitled to them: at the final
 * reveal, or — when the server is configured to remember peeks — for cards
 * they have legitimately seen.
 *
 * `id` is deliberately *not* the card's real id. Internally a card is called
 * `S7` or `H13`, which names it outright, and a slot is sent to every player
 * at the table - so sending the real one would hand the whole table's hands to
 * anyone who opened a console. It is a per-round handle instead: stable for as
 * long as the card is on the table, and worth nothing off it.
 */
export type SlotView =
  /**
   * A card that has left this hand - slapped away, or handed over to settle
   * someone else's slap. The place it held stays, because a hand that closed
   * up behind it would move every card a player had memorised.
   */
  | { kind: "gap" }
  | { kind: "down"; id: string }
  | { kind: "up"; id: string; card: Card };

export type PlayerView = {
  id: PlayerId;
  name: string;
  connected: boolean;
  isHost: boolean;
  slots: SlotView[];
  /** Populated only once the round is over. */
  score: number | null;
  /** True for the player who called Cambio. */
  calledCambio: boolean;
  /** Set during the study phase: whether they have finished their initial peeks. */
  ready: boolean;
  /**
   * Which slots this player has already studied. Sent only to the player
   * themselves - for everyone else it is empty, since which cards an opponent
   * chose to look at is theirs to know.
   */
  peeked: number[];
};

/** One card, named by where it sits rather than by its id. */
export type SlotRef = { ownerId: PlayerId; slot: number };

export type GameView = {
  code: RoomCode;
  phase: Phase;
  /**
   * Monotonic state counter. Lets a client discard a view that arrives out of
   * order, and lets a test tell "the state has advanced" from "the state looks
   * the same as before".
   */
  version: number;
  /** The viewer this payload was redacted for. */
  you: PlayerId;
  players: PlayerView[];
  turnPlayerId: PlayerId | null;
  /** Wall-clock ms at which the current turn expires, or null when untimed. */
  turnEndsAt: number | null;
  /** How many packs this table plays with. Set by the host in the lobby. */
  decks: number;
  /**
   * Whether a triggered power may be declined. False by default: discard a
   * card from the deck and you use what it does.
   */
  optionalPowers: boolean;
  /** The card back every face-down card wears. Cosmetic, and the host's choice. */
  back: string;
  /** Cards left face down to draw from. */
  deckCount: number;
  discardTop: Card | null;
  discardCount: number;
  /**
   * Who is holding a drawn card, if anyone. Public, because at a real table
   * everyone can see a card leave the pile and sit in someone's hand - it is
   * only the face of it that is private.
   */
  heldBy: PlayerId | null;
  /**
   * The held card's face. Sent to the holder, and to everyone when it came off
   * the discard pile, which is face up and so was public the moment it moved.
   */
  heldCard: Card | null;
  /** Whether the held card came from the discard pile (so it grants no power). */
  heldFromDiscard: boolean;
  /** The power awaiting resolution, if any. */
  pendingPower: Power | null;
  /**
   * For a king: the cards it has named so far, in the order they were named.
   * Two of them means both have been shown and only swap-or-keep is left.
   *
   * In the view rather than client-local state, so a refresh mid-power does
   * not lose track of where the turn is.
   */
  kingPicks: SlotRef[];
  /**
   * Who owes whom a card after slapping someone else's, and the place in the
   * target's hand it has to go: the hole the slap just made in it.
   */
  slapDebt: { slapperId: PlayerId; targetId: PlayerId; slot: number } | null;
  /** Non-null once someone calls Cambio: how many final turns remain. */
  finalTurnsRemaining: number | null;
  /** Whether a slap is legal right now. */
  slapOpen: boolean;
  /**
   * Set while a slap is being settled. The table is stopped: whoever holds the
   * lock owes the table a card, everyone behind them waits, and nobody takes a
   * turn until the queue has emptied.
   */
  slapLock: {
    /** Whose slap the table is waiting on. */
    holderId: PlayerId;
    /** Everyone queued behind them, in the order they will be asked. */
    waiting: PlayerId[];
    /** When the holder runs out of time to name a card, or null when untimed. */
    endsAt: number | null;
  } | null;
  winnerId: PlayerId | null;
};

/**
 * What a move looked like from across the table.
 *
 * Cambio is played face down, so the only thing stopping it from being opaque
 * is that everyone can see *which* cards a player touches, even when they
 * cannot see what those cards are. These carry exactly that much: the gesture
 * and the slots it landed on, never a face.
 */
export type TableEventKind =
  /** A card came off the deck and is now in someone's hand. */
  | "draw"
  /** The face-up top of the discard pile was picked up. */
  | "take"
  /** A held card went to the discard pile. */
  | "discard"
  /** A held card went into a hand, sending the card it displaced to the pile. */
  | "replace"
  /** Someone looked at a card - theirs or another player's. */
  | "peek"
  /** Two cards changed places. */
  | "swap"
  /** A card moved from one hand to another to settle a slap. */
  | "give"
  /** A card was dealt into a hand as a penalty for a wrong slap. */
  | "penalty"
  /** Cambio was called. */
  | "cambio";

export type SlapOutcome =
  /** The slap was right, and the card was the slapper's own. */
  | "ownCardDiscarded"
  /** The slap was right, and the card belonged to someone else. */
  | "otherCardDiscarded"
  /** The slap was wrong. The slapper took a card, and the queue moves on. */
  | "wrongRankPenalty"
  /** The slapper held the table and never named a card. Same cost as a wrong one. */
  | "noPickPenalty"
  /** An earlier slap in the queue was right, so this one never had to be played. */
  | "lostRace"
  /** The card or the discard top was gone by the time the queue reached it. */
  | "noLongerValid";

export type ErrorCode =
  | "roomNotFound"
  | "roomFull"
  | "nameTaken"
  | "notHost"
  | "notYourTurn"
  | "illegalAction"
  | "badSlot"
  | "badTarget"
  | "notEnoughPlayers"
  | "gameAlreadyStarted"
  | "sessionInvalid"
  | "malformed";

export type ServerEvent =
  /** First reply to create/join/resume. The token is what survives a refresh. */
  | { t: "hello"; playerId: PlayerId; token: string; code: RoomCode }
  | { t: "game.state"; view: GameView }
  /**
   * A one-shot look at a card, sent only to the entitled viewer. When the server
   * is configured to forget peeks this is the only time that face is ever sent,
   * which is what keeps Cambio a memory game.
   */
  | { t: "card.revealed"; ownerId: PlayerId; slot: number; card: Card; ttlMs: number }
  /**
   * One slap, settled. A contested race produces several of these, in queue
   * order, because every slap is played out until one of them is right.
   */
  | {
      t: "slap.resolved";
      /** Whose slap this is. */
      slapperId: PlayerId;
      targetId: PlayerId;
      slot: number;
      outcome: SlapOutcome;
      /**
       * The card that was turned over, for a slap that landed.
       *
       * Everyone sees it, not just the slapper: it went face up onto the pile
       * in front of the whole table, so there is nothing left to hide, and
       * watching it happen is most of the fun of someone else slapping.
       */
      card: Card | null;
      /** On `lostRace`, whose correct slap ended the queue. Null otherwise. */
      endedById: PlayerId | null;
      /**
       * For the first slap in the queue, how far ahead of the next one it
       * landed, in compensated ms - null if it was unopposed. For every slap
       * after it, how far behind the first one it landed.
       */
      marginMs: number | null;
    }
  /**
   * A move, as the whole table saw it. Broadcast to everyone, including the
   * player who made it, so every screen animates the same gesture at the same
   * moment and nobody has to be told what just happened.
   */
  | { t: "table.event"; kind: TableEventKind; byId: PlayerId; slots: SlotRef[] }
  | { t: "game.over"; scores: { playerId: PlayerId; score: number }[]; winnerId: PlayerId }
  | { t: "kicked"; reason: string }
  | { t: "error"; code: ErrorCode; message: string }
  /** Latency probe; the client echoes the nonce back untouched. */
  | { t: "ping"; nonce: number };
