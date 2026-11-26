export type SlapBarProps = {
  open: boolean;
  /** The table is stopped on me: it is waiting for the card I meant. */
  picking: boolean;
  /** I am in the queue behind somebody else's slap, waiting my go. */
  queued: boolean;
  pending: boolean;
  onClaim: () => void;
};

/**
 * The slap control.
 *
 * Pressing it is the slap. It stops the table there and then - nobody takes a
 * turn until the queue it opened has emptied - and what it then waits for is
 * the card you meant. So it is a commitment rather than a mode: there is no
 * cancelling it, and the only way out is to turn a card over.
 *
 * Card clicks are already spoken for by whatever the player is in the middle
 * of doing, which is why slapping gets its own gesture rather than overloading
 * them. The numbered keys are the fast path for your own cards - one keystroke
 * that both claims and answers - and that is the common case, the one where
 * milliseconds actually decide the race.
 */
export function SlapBar({ open, picking, queued, pending, onClaim }: SlapBarProps): React.JSX.Element {
  const classes = ["slapbar"];
  if (picking) classes.push("slapbar--armed");
  if (queued) classes.push("slapbar--queued");
  if (pending) classes.push("slapbar--pending");

  const label = pending ? "SLAP!" : picking ? "Pick a card" : queued ? "Waiting" : "SLAP";

  return (
    <div className={classes.join(" ")}>
      <button
        type="button"
        className="slapbar__button"
        disabled={!open || queued}
        onClick={onClaim}
        data-testid="slap-button"
        aria-pressed={picking}
      >
        {label}
      </button>
    </div>
  );
}
