export type SnapBarProps = {
  open: boolean;
  armed: boolean;
  pending: boolean;
  /** How many cards the player holds, for the numbered fast-path hints. */
  ownSlots: number;
  onArm: (armed: boolean) => void;
};

/**
 * The snap control.
 *
 * Card clicks are already spoken for by whatever the player is in the middle of
 * doing, so snapping gets its own explicit gesture rather than overloading
 * them. Arming is one click and then any card is a snap target; the numbered
 * keys are the fast path for your own cards, which is the common case and the
 * one where milliseconds actually decide the race.
 */
export function SnapBar({ open, armed, pending, ownSlots, onArm }: SnapBarProps): React.JSX.Element {
  const classes = ["snapbar"];
  if (armed) classes.push("snapbar--armed");
  if (pending) classes.push("snapbar--pending");

  return (
    <div className={classes.join(" ")}>
      <button
        type="button"
        className="snapbar__button"
        disabled={!open}
        onClick={() => onArm(!armed)}
        data-testid="snap-button"
        aria-pressed={armed}
      >
        {pending ? "SNAP!" : armed ? "Pick a card" : "SNAP"}
      </button>

      <p className="snapbar__hint">
        {!open ? (
          "Snapping opens once the round is under way."
        ) : armed ? (
          "Click any card to snap it. Esc to cancel."
        ) : (
          <>
            Press <kbd>S</kbd>, or{" "}
            {ownSlots > 0 ? (
              <>
                <kbd>1</kbd>&ndash;<kbd>{ownSlots}</kbd> to snap your own card
              </>
            ) : (
              "arm it above"
            )}
            .
          </>
        )}
      </p>
    </div>
  );
}
