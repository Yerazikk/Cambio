import type { Card, CardId, Power } from "./cards.js";

export type PlayerId = string;
export type RoomCode = string;

/* ------------------------------------------------------------------ actions */

/**
 * Game actions. Every one of these is fed to the pure reducer, so this union is
 * exactly the rule surface the engine tests enumerate.
 *
 * `snap` is the one exception: the socket layer intercepts it, hands it to the
 * arbiter to win or lose the race, and only the resolved outcome reaches the
 * reducer as `snapResolve`.
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
  | { a: "kingSkip" }
  /** Decline a power outright. Powers are optional, and the turn clock uses this. */
  | { a: "forfeitPower" }
  /* pre-round study phase */
  | { a: "initialPeek"; slot: number }
  | { a: "readyUp" }
  /* snap */
  | { a: "snap"; targetId: PlayerId; slot: number }
  | { a: "snapGive"; slot: number };

/** Emitted by the arbiter, never sent by a client. */
export type ResolvedAction = {
  a: "snapResolve";
  winnerId: PlayerId | null;
  targetId: PlayerId;
  slot: number;
  marginMs: number | null;
};

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
  | "powerKing"
  | "snapGiveCard"
  | "finished";

/**
 * One card as a given viewer sees it. Faces appear only where that viewer is
 * entitled to them: at the final reveal, or — when the server is configured to
 * remember peeks — for cards they have legitimately seen.
 */
export type SlotView = { id: CardId } & ({ known: false } | { known: true; card: Card });

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
   * For a king: whether its look has been spent, so only the swap-or-pass
   * choice remains. In the view rather than client-local state, so a refresh
   * mid-power does not lose track of where the turn is.
   */
  kingPeeked: boolean;
  /** Who owes whom a card after snapping someone else's. */
  snapDebt: { snapperId: PlayerId; targetId: PlayerId } | null;
  /** Non-null once someone calls Cambio: how many final turns remain. */
  finalTurnsRemaining: number | null;
  /** Whether a snap is legal right now. */
  snapOpen: boolean;
  winnerId: PlayerId | null;
};

/** One card, named by where it sits rather than by its id. */
export type SlotRef = { ownerId: PlayerId; slot: number };

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
  /** A card moved from one hand to another to settle a snap. */
  | "give"
  /** A card was dealt into a hand as a penalty for a wrong snap. */
  | "penalty"
  /** Cambio was called. */
  | "cambio";

export type SnapOutcome =
  | "ownCardDiscarded"
  | "otherCardDiscarded"
  | "wrongRankPenalty"
  | "lostRace"
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
  | {
      t: "snap.resolved";
      winnerId: PlayerId | null;
      targetId: PlayerId;
      slot: number;
      outcome: SnapOutcome;
      /** How far ahead the winner was, in compensated ms. */
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
