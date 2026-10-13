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
  | { a: "blindSwap"; mySlot: number; targetId: PlayerId; targetSlot: number }
  | { a: "kingSwap"; mySlot: number; targetId: PlayerId; targetSlot: number }
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
  | "powerBlindSwap"
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
  deckCount: number;
  discardTop: Card | null;
  discardCount: number;
  /** The card the current player is holding, visible only to them. */
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
  | { t: "game.over"; scores: { playerId: PlayerId; score: number }[]; winnerId: PlayerId }
  | { t: "kicked"; reason: string }
  | { t: "error"; code: ErrorCode; message: string }
  /** Latency probe; the client echoes the nonce back untouched. */
  | { t: "ping"; nonce: number };
