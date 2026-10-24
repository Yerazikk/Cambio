import { useEffect, useState } from "react";
import { cardLabel, isRed, rankLabel, suitSymbol, type Card } from "@cambio/shared";

/**
 * A move this card is in the middle of, played as an animation. These are the
 * table's body language: everyone sees the same lift, trade or slap at the
 * same moment, which is the only way a face-down game stays legible.
 */
export type Flash = "peek" | "swap" | "replace" | "give" | "penalty" | "snap";

export type CardFaceProps = {
  card: Card | null;
  /** How this card should read: a live target, a chosen one, or just scenery. */
  state?: "idle" | "targetable" | "selected" | "snap";
  size?: "normal" | "small" | "large";
  label?: string;
  /** What just happened to this card, if anything. */
  flash?: Flash | null;
  onClick?: () => void;
  testId?: string;
  /** Where this card sits in its hand, which is the order it is dealt in. */
  dealIndex?: number;
};

/**
 * How long the face a card is turning away from stays rendered. It has to
 * outlast the flip itself - a card whose face vanished the instant its peek
 * expired would turn over with nothing printed on it - and it must not outlast
 * it by much, because what is in the DOM is readable, and the whole game rests
 * on a peeked card being gone the moment its time is up.
 */
const FLIP_MS = 560;

/**
 * One card, as an object with two sides.
 *
 * Face up or face down is a class on the frame; the two faces sit back to back
 * inside it on a plane that turns. So a card is never swapped for a different
 * card - it is the same card, turned over - and every reveal in the game (your
 * own study, a seven, a nine played across the table, the final show) is the
 * same half-second flip.
 *
 * A null card is face down, which is the normal case in Cambio: you do not
 * know your own hand.
 */
export function CardFace({
  card,
  state = "idle",
  size = "normal",
  label,
  flash = null,
  onClick,
  testId,
  dealIndex,
}: CardFaceProps): React.JSX.Element {
  /*
   * The face to print on the front, which outlives the card by one flip. The
   * server shows a peeked card once and then takes it away; without this the
   * card would turn back over blank, and the turn is half the point of it.
   */
  const [printed, setPrinted] = useState<Card | null>(card);
  useEffect(() => {
    if (card !== null) {
      setPrinted(card);
      return;
    }
    const timer = setTimeout(() => setPrinted(null), FLIP_MS);
    return () => clearTimeout(timer);
  }, [card]);

  const face = card ?? printed;

  const classes = ["card", `card--${size}`, `card--${state}`, card === null ? "card--down" : "card--up"];
  if (face !== null && isRed(face.suit)) classes.push("card--red");
  if (flash !== null) classes.push(`card--did-${flash}`);

  const interactive = onClick !== undefined && (state === "targetable" || state === "snap" || state === "selected");
  const described = card === null ? "face-down card" : `${cardLabel(card)}, worth ${card.points}`;

  const inside = (
    <>
      <span className="card__inner">
        <span className="card__face card__face--front">
          {face === null ? null : face.rank === "joker" ? (
            <span className="card__joker">JOKER</span>
          ) : (
            <>
              <span className="card__rank">{rankLabel(face.rank)}</span>
              <span className="card__suit">{face.suit ? suitSymbol(face.suit) : ""}</span>
            </>
          )}
        </span>
        <span className="card__face card__face--back">
          <span className="card__art" aria-hidden="true" />
        </span>
      </span>
      {label !== undefined && <span className="card__tag">{label}</span>}
    </>
  );

  // The deal runs round the table in turn order, so each card needs to know
  // where it sits in the hand to take its place in the queue.
  const style = dealIndex === undefined ? undefined : ({ "--slot-i": dealIndex } as React.CSSProperties);

  if (!interactive) {
    return (
      <div className={classes.join(" ")} data-testid={testId} aria-label={described} style={style}>
        {inside}
      </div>
    );
  }

  return (
    <button
      type="button"
      className={classes.join(" ")}
      data-testid={testId}
      onClick={onClick}
      style={style}
      aria-label={`${described} - ${state === "snap" ? "snap this card" : "choose this card"}`}
    >
      {inside}
    </button>
  );
}
