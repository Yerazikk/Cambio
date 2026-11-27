import { useCallback, useState } from "react";

/**
 * A name, with a crown on it if it belongs to the host.
 *
 * The crown sits on the first letter rather than beside the name, which is
 * what a crown does - it is worn, not carried. That is also why it replaced a
 * chip: at a table of eight, a word after every name is eight words of
 * furniture, where a mark on one of them is read without being read.
 *
 * Sitting it on the letter is exact rather than approximate, because the
 * interface is set in a monospace face: every glyph is one character wide, so
 * the middle of the first letter is at `0.5ch` and the CSS can simply say so.
 *
 * It says "host" when you point at it, for anyone who does not take the
 * meaning from a crown, and it hops when you press it, for no reason at all.
 */
export type CrownedProps = {
  name: string;
  isHost: boolean;
};

export function Crowned({ name, isHost }: CrownedProps): React.JSX.Element {
  const [hopping, setHopping] = useState(false);

  /*
   * Clearing the class and setting it again on the next frame is what lets a
   * second press restart a hop that is still running. Setting it twice in one
   * frame would be no change at all, and the crown would sit still.
   */
  const hop = useCallback(() => {
    setHopping(false);
    requestAnimationFrame(() => setHopping(true));
  }, []);

  if (!isHost) return <>{name}</>;

  return (
    <span className="crowned">
      {name}
      <button
        type="button"
        className={`crown${hopping ? " crown--bob" : ""}`}
        onClick={hop}
        onAnimationEnd={() => setHopping(false)}
        aria-label={`${name} is the host`}
        data-testid="host-crown"
      >
        <svg className="crown__art" viewBox="0 0 24 16" aria-hidden="true" focusable="false">
          <path className="crown__body" d="M1 15V2l6.5 5L12 0.6 16.5 7 23 2v13Z" />
        </svg>
        <span className="crown__say">host</span>
      </button>
    </span>
  );
}
