/** Every tunable the game depends on. Tests override these per-scenario. */

/** Cards dealt to each player at the start of a round. */
export const HAND_SIZE = 4;
/** How many of your own cards you may study before the first turn. */
export const INITIAL_PEEKS = 2;

/**
 * Whether a slot is one of the cards you may study before the first turn.
 *
 * Hands are laid out two to a row, and the studiable cards are the bottom row -
 * the last `initialPeeks` slots. Fixing them by position rather than letting
 * each player choose is what makes the opening the same deal for everyone, and
 * what lets the table say "your bottom two" and mean something.
 */
export function isInitialPeekSlot(slot: number, handSize: number, initialPeeks: number): boolean {
  return slot >= handSize - initialPeeks && slot < handSize;
}
/** Table size bounds. */
export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 6;

/**
 * How many packs the table plays with, and the range the host may pick from.
 * More packs means more of every rank in play, so slaps come up far more often
 * and the deck runs down more slowly.
 */
export const CARDS_PER_DECK = 54;
export const DECKS = 1;
export const MIN_DECKS = 1;
export const MAX_DECKS = 4;

/** The deck counts a host may choose between, for a picker to render. */
export const DECK_CHOICES: readonly number[] = [1, 2, 3, 4];

/**
 * The card backs on offer. Purely cosmetic - the back is the same for every
 * card on the table, so it gives nothing away - but it is table-wide state, so
 * the host picks it and everyone sees the same deck.
 *
 * `id` is both the choice sent over the wire and the artwork's filename under
 * the client's `backs/` folder. Adding a back is a new SVG there plus a line
 * here; nothing else needs to know.
 */
export type CardBack = { id: string; label: string };

export const CARD_BACKS: readonly CardBack[] = [
  { id: "navy-geometric", label: "Navy geometric" },
  { id: "blue-celestial", label: "Blue celestial" },
  { id: "purple-floral", label: "Purple floral" },
  { id: "teal-floral", label: "Teal floral" },
  { id: "red-grid", label: "Red grid" },
  { id: "pink-hearts", label: "Pink hearts" },
  { id: "gold-ornament", label: "Gold ornament" },
  { id: "yellow-diamonds", label: "Yellow diamonds" },
];

/** The back a new table starts with. */
export const DEFAULT_BACK = "navy-geometric";

export function isCardBack(id: string): boolean {
  return CARD_BACKS.some((back) => back.id === id);
}

/**
 * How long the arbiter waits, after the first slap lands, before deciding the
 * race. Must comfortably exceed the spread in players' one-way latency, or
 * well-connected players win purely on network position.
 */
export const SLAP_WINDOW_MS = 200;

/**
 * How long the holder of the slap lock has to name a card before the table
 * takes one off them and moves on.
 *
 * Slapping stops the game: everybody waits while the slapper picks. That is
 * the rule, so it needs a clock - and it needs a cost on the far side of it,
 * or pressing SLAP would be a free way to freeze the table.
 */
export const SLAP_PICK_MS = 8_000;

/**
 * How long a peeked card stays face up on the peeker's screen. Cambio is a
 * memory game: the card is shown once and then never re-sent, so this is the
 * only window in which the player can commit it to memory.
 */
export const PEEK_MS = 4_000;

/** Per-turn clock. On expiry the server auto-plays a safe move. */
export const TURN_MS = 45_000;

/**
 * Whether a power may be declined.
 *
 * false — the default, and the game as it is meant to be played. Discarding a
 *         card straight from the deck fires its power and you resolve it:
 *         you look, or you swap. A seven you did not want is part of the
 *         price of discarding a seven.
 * true  — powers are offered rather than imposed, and may be waved away.
 *
 * The host chooses in the lobby, before the round. It changes how the turn
 * plays more than any other setting, so it is table-wide and fixed for the
 * round rather than something a player decides each time.
 */
export const OPTIONAL_POWERS = false;

/** Added to the caller's score when they call Cambio without the lowest hand. */
export const CAMBIO_PENALTY = 10;
/** Whether slapping stays live during the final turns after a Cambio call. */
export const SLAP_AFTER_CAMBIO = true;

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

/** Round-trip-time sampling, used to compensate the slap race. */
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
  decks: number;
  handSize: number;
  initialPeeks: number;
  slapWindowMs: number;
  slapPickMs: number;
  peekMs: number;
  turnMs: number;
  cambioPenalty: number;
  optionalPowers: boolean;
  slapAfterCambio: boolean;
  serverRemembersPeeks: boolean;
};

export const DEFAULT_RULES: RuleConfig = {
  decks: DECKS,
  handSize: HAND_SIZE,
  initialPeeks: INITIAL_PEEKS,
  slapWindowMs: SLAP_WINDOW_MS,
  slapPickMs: SLAP_PICK_MS,
  peekMs: PEEK_MS,
  turnMs: TURN_MS,
  cambioPenalty: CAMBIO_PENALTY,
  optionalPowers: OPTIONAL_POWERS,
  slapAfterCambio: SLAP_AFTER_CAMBIO,
  serverRemembersPeeks: SERVER_REMEMBERS_PEEKS,
};
