/** Every tunable the game depends on. Tests override these per-scenario. */

/** Cards dealt to each player at the start of a round. */
export const HAND_SIZE = 4;
/** How many of your own cards you may study before the first turn. */
export const INITIAL_PEEKS = 2;
/** Table size bounds. */
export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 6;

/**
 * How long the arbiter waits, after the first snap lands, before deciding the
 * race. Must comfortably exceed the spread in players' one-way latency, or
 * well-connected players win purely on network position.
 */
export const SNAP_WINDOW_MS = 200;

/**
 * How long a peeked card stays face up on the peeker's screen. Cambio is a
 * memory game: the card is shown once and then never re-sent, so this is the
 * only window in which the player can commit it to memory.
 */
export const PEEK_MS = 4_000;

/** Per-turn clock. On expiry the server auto-plays a safe move. */
export const TURN_MS = 45_000;

/** Added to the caller's score when they call Cambio without the lowest hand. */
export const CAMBIO_PENALTY = 10;
/** Whether snapping stays live during the final turns after a Cambio call. */
export const SNAP_AFTER_CAMBIO = true;

/**
 * false  — a peek is shown once and then forgotten by the server, so remembering
 *          your cards is the player's job. Refreshing costs you your memory,
 *          which is self-penalising and therefore not exploitable.
 * true   — the server remembers every card you have legitimately seen and keeps
 *          sending it in your view, so a refresh restores it exactly.
 *
 * Both are honest readings of Cambio; `false` preserves the memory challenge,
 * which is most of the game. Flipping this is the only change required, because
 * knowledge is tracked server-side either way.
 */
export const SERVER_REMEMBERS_PEEKS = false;

/** How long a seat is held open for a player who dropped. */
export const RECONNECT_GRACE_IN_GAME_MS = 60_000;
export const RECONNECT_GRACE_LOBBY_MS = 10_000;

/** Round-trip-time sampling, used to compensate the snap race. */
export const RTT_PING_INTERVAL_MS = 2_000;
export const RTT_EWMA_ALPHA = 0.25;
/** RTT assumed for a player who has not yet answered a ping. */
export const RTT_DEFAULT_MS = 80;
/** Ceiling on latency compensation, so a forged-looking RTT cannot buy an edge. */
export const RTT_MAX_COMPENSATION_MS = 150;

/** Room codes omit O/0 and I/1 so they can be read aloud without ambiguity. */
export const ROOM_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const ROOM_CODE_LENGTH = 6;
/** Idle rooms are reaped so the registry cannot grow without bound. */
export const ROOM_REAP_IDLE_MS = 10 * 60_000;

export type RuleConfig = {
  handSize: number;
  initialPeeks: number;
  snapWindowMs: number;
  peekMs: number;
  turnMs: number;
  cambioPenalty: number;
  snapAfterCambio: boolean;
  serverRemembersPeeks: boolean;
};

export const DEFAULT_RULES: RuleConfig = {
  handSize: HAND_SIZE,
  initialPeeks: INITIAL_PEEKS,
  snapWindowMs: SNAP_WINDOW_MS,
  peekMs: PEEK_MS,
  turnMs: TURN_MS,
  cambioPenalty: CAMBIO_PENALTY,
  snapAfterCambio: SNAP_AFTER_CAMBIO,
  serverRemembersPeeks: SERVER_REMEMBERS_PEEKS,
};
