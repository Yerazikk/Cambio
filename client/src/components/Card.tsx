import { cardLabel, isRed, rankLabel, suitSymbol, type Card } from "@cambio/shared";

/**
 * A move this card is in the middle of, played as an animation. These are the
 * table's body language: everyone sees the same flip, slide or snap at the
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
};

/**
 * One card. A null card renders face down, which is the normal case in Cambio -
 * you do not know your own hand.
 */
export function CardFace({
  card,
  state = "idle",
  size = "normal",
  label,
  flash = null,
  onClick,
  testId,
}: CardFaceProps): React.JSX.Element {
  const classes = ["card", `card--${size}`, `card--${state}`, card === null ? "card--down" : "card--up"];
  if (card !== null && isRed(card.suit)) classes.push("card--red");
  if (flash !== null) classes.push(`card--did-${flash}`);

  const interactive = onClick !== undefined && (state === "targetable" || state === "snap" || state === "selected");

  const content =
    card === null ? (
      <span className="card__art" aria-hidden="true" />
    ) : card.rank === "joker" ? (
      <span className="card__joker">JOKER</span>
    ) : (
      <>
        <span className="card__rank">{rankLabel(card.rank)}</span>
        <span className="card__suit">{card.suit ? suitSymbol(card.suit) : ""}</span>
      </>
    );

  const described = card === null ? "face-down card" : `${cardLabel(card)}, worth ${card.points}`;

  if (!interactive) {
    return (
      <div className={classes.join(" ")} data-testid={testId} aria-label={described}>
        {content}
        {label !== undefined && <span className="card__tag">{label}</span>}
      </div>
    );
  }

  return (
    <button
      type="button"
      className={classes.join(" ")}
      data-testid={testId}
      onClick={onClick}
      aria-label={`${described} - ${state === "snap" ? "snap this card" : "choose this card"}`}
    >
      {content}
      {label !== undefined && <span className="card__tag">{label}</span>}
    </button>
  );
}
