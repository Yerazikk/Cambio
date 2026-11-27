/** Every tunable the game depends on. Tests override these per-scenario. */

/** Cards dealt to each player at the start of a round. */
export const HAND_SIZE = 4;
/** How many of your own cards you may study before the first turn. */
export const INITIAL_PEEKS = 2;

/**
 * Whether a slot is one of the cards you may study before the first turn.
 *
 * A hand is dealt in columns of two - slots 0 and 1 are the first column, 2
 * and 3 the second - so the bottom row is the odd slots, and at a four-card
 * hand that is the cards labelled 2 and 4. Fixing them by position rather than
 * letting each player choose is what makes the opening the same deal for
 * everyone, and what lets the table say "your bottom two" and mean it: the
 * player looks at the two cards nearest them, which is where a real hand would
 * be tipped up.
 */
export function isInitialPeekSlot(slot: number, handSize: number, initialPeeks: number): boolean {
  if (slot < 0 || slot >= handSize) return false;
  // Bottom row only, and only the leftmost `initialPeeks` of it.
  if (slot % 2 !== 1) return false;
  return (slot - 1) / 2 < initialPeeks;
}

/** The slots `isInitialPeekSlot` admits, in the order they are laid out. */
export function initialPeekSlots(handSize: number, initialPeeks: number): number[] {
  const slots: number[] = [];
  for (let slot = 0; slot < handSize; slot++) {
    if (isInitialPeekSlot(slot, handSize, initialPeeks)) slots.push(slot);
  }
  return slots;
}
/** Table size bounds. */
export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 8;

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
 * How long the holder of the slap lock has to name a card, or 0 for no clock
 * at all - which is what this table plays with.
 *
 * Slapping stops the game and everybody waits while the slapper picks. A clock
 * on that is a clock on the one moment in Cambio that is already frantic, and
 * it was costing people cards for being half a second slow on a gesture they
 * had already committed to. The table waits instead.
 *
 * What stops a stopped table staying stopped for ever is the slapper leaving:
 * a lock whose holder drops is given up on the spot. That is a disconnection
 * being handled, not a clock, and it is the only way out of the pause that
 * does not involve naming a card.
 */
export const SLAP_PICK_MS = 0;

/**
 * How long a peeked card stays face up on the peeker's screen. Cambio is a
 * memory game: the card is shown once and then never re-sent, so this is the
 * only window in which the player can commit it to memory.
 */
export const PEEK_MS = 4_000;

/** Per-turn clock. On expiry the server auto-plays a safe move. */
export const TURN_MS = 45_000;

/**
 * What each step of a turn puts back on that clock.
 *
 * A turn is not one decision, it is a chain of them: draw, then decide what to
 * do with it, then play out whatever power that fired. Running all of those
 * off a single budget punishes the turns that have the most to think about,
 * which are exactly the ones worth thinking about. So every move you actually
 * make buys you more time - the clock is there to move a seat nobody is
 * sitting in along, and a player who is plainly playing is not that seat.
 */
export const TURN_BONUS_MS = 15_000;

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

/**
 * How long a seat is held open for a player who dropped.
 *
 * In a round it is held to the end of it, full stop - there is no number here
 * because there is no timer. Losing your seat mid-round is the worst thing
 * that can happen to you in this game and a flaky connection should not be
 * able to do it, so the seat waits, the turn order steps over it, and the
 * player walks back into it whenever they manage to get back. The host can
 * still remove someone who is plainly gone.
 *
 * In the lobby a seat is cheap to give up and cheap to retake, so a dropped
 * player is cleared after a couple of minutes rather than left as furniture.
 */
export const RECONNECT_GRACE_LOBBY_MS = 120_000;

/** Round-trip-time sampling, used to compensate the slap race. */
export const RTT_PING_INTERVAL_MS = 2_000;
export const RTT_EWMA_ALPHA = 0.25;
/** RTT assumed for a player who has not yet answered a ping. */
export const RTT_DEFAULT_MS = 80;
/** Ceiling on latency compensation, so a forged-looking RTT cannot buy an edge. */
export const RTT_MAX_COMPENSATION_MS = 150;

/** Room codes omit O/0 and I/1 so they can be read aloud without ambiguity. */
export const ROOM_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
/**
 * Four characters, from a 32-letter alphabet: a million codes, which is far
 * more than a table registry that reaps itself will ever hold at once, and two
 * fewer things to read down a phone than six was.
 */
export const ROOM_CODE_LENGTH = 4;
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
  turnBonusMs: number;
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
  turnBonusMs: TURN_BONUS_MS,
  cambioPenalty: CAMBIO_PENALTY,
  optionalPowers: OPTIONAL_POWERS,
  slapAfterCambio: SLAP_AFTER_CAMBIO,
  serverRemembersPeeks: SERVER_REMEMBERS_PEEKS,
};
