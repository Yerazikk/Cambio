export type SlapBarProps = {
  open: boolean;
  armed: boolean;
  pending: boolean;
  /** How many cards the player holds, for the numbered fast-path hints. */
  ownSlots: number;
  onArm: (armed: boolean) => void;
};

/**
 * The slap control.
 *
 * Card clicks are already spoken for by whatever the player is in the middle of
 * doing, so slapping gets its own explicit gesture rather than overloading
 * them. Arming is one click and then any card is a slap target; the numbered
 * keys are the fast path for your own cards, which is the common case and the
 * one where milliseconds actually decide the race.
 */
export function SlapBar({ open, armed, pending, ownSlots, onArm }: SlapBarProps): React.JSX.Element {
  const classes = ["slapbar"];
  if (armed) classes.push("slapbar--armed");
  if (pending) classes.push("slapbar--pending");

  return (
    <div className={classes.join(" ")}>
      <button
        type="button"
        className="slapbar__button"
        disabled={!open}
        onClick={() => onArm(!armed)}
        data-testid="slap-button"
        aria-pressed={armed}
      >
        {pending ? "SLAP!" : armed ? "Pick a card" : "SLAP"}
      </button>

      <p className="slapbar__hint">
        {!open ? (
          "Slapping opens once the round is under way."
        ) : armed ? (
          "Click any card to slap it. Esc to cancel."
        ) : (
          <>
            Press <kbd>S</kbd>, or{" "}
            {ownSlots > 0 ? (
              <>
                <kbd>1</kbd>&ndash;<kbd>{ownSlots}</kbd> to slap your own card
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
