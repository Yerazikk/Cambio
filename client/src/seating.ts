import type { PlayerId, PlayerView } from "@cambio/shared";

/** Where on the table a seat sits, as a percentage of the table's own box. */
export type Placement = {
  player: PlayerView;
  isYou: boolean;
  /** 0 for you, then one per seat clockwise round the table. */
  turnOffset: number;
  /** Centre of the seat, in percent of the table box. */
  x: number;
  y: number;
  /**
   * The direction the middle of the table lies in from this seat, as a unit
   * vector. Cards are dealt out of the middle, so this is the line they travel
   * in - which means the deal comes out of the piles at every seat without a
   * case per seat.
   */
  inX: number;
  inY: number;
  /** Which side of the table this seat is on, for layout that cannot be angular. */
  side: "bottom" | "left" | "top" | "right";
};

/**
 * How far out from the middle the seats sit. Wider than tall, because screens
 * are: the piles need the space in the centre either way, and an ellipse keeps
 * the left and right seats from crowding them on a laptop.
 */
const RADIUS_X = 39;
const RADIUS_Y = 35;

/**
 * Seat everyone round one table, viewed from above.
 *
 * You are always at the bottom, facing your own hand, and the rest keep the
 * order they have in the player list - so the player who plays after you is on
 * your left and play runs clockwise, exactly as the seating would work if the
 * same people sat down round a real table. Four of you makes a square, five a
 * pentagon, six a hexagon; it is one formula, not a case per table size.
 */
export function seatRing(players: PlayerView[], me: PlayerId): Placement[] {
  const start = players.findIndex((p) => p.id === me);
  const count = players.length;
  if (count === 0) return [];

  const step = 360 / count;

  return players.map((_, index) => {
    // Rotate the list so you are first, then walk it round from the bottom.
    const turnOffset = (index - Math.max(start, 0) + count) % count;
    const player = players[index] as PlayerView;

    // Screen angles run clockwise from 3 o'clock because y grows downwards, so
    // 90deg is the bottom of the table and each step from there goes left.
    const radians = ((90 + turnOffset * step) * Math.PI) / 180;
    const cos = Math.cos(radians);
    const sin = Math.sin(radians);

    // Towards the middle is simply back along the radius the seat sits on.
    const length = Math.hypot(RADIUS_X * cos, RADIUS_Y * sin) || 1;

    return {
      player,
      isYou: player.id === me,
      turnOffset,
      x: 50 + RADIUS_X * cos,
      y: 50 + RADIUS_Y * sin,
      inX: (-RADIUS_X * cos) / length,
      inY: (-RADIUS_Y * sin) / length,
      side: sideFor(cos, sin),
    };
  });
}

/**
 * The quadrant a seat falls in. Used only to decide which way its name tag and
 * drawn card hang, so the vertical halves win ties: a seat just off the bottom
 * of the table still reads as a bottom seat.
 */
function sideFor(cos: number, sin: number): Placement["side"] {
  if (Math.abs(sin) >= Math.abs(cos)) return sin > 0 ? "bottom" : "top";
  return cos > 0 ? "right" : "left";
}
