import { useCallback, useEffect } from "react";

/**
 * The rule book, one keystroke away.
 *
 * Cambio is a memory game with a race bolted on, and both halves have rules
 * people forget mid-round - what a nine does, what a king is worth, what
 * happens when two people slap at once. A player who has to leave the table to
 * look that up has lost their turn, so it lives here: a mark in the corner of
 * the screen, `i` to open it, `Esc` to put it away.
 *
 * What it holds is the two lookups and nothing else that can be cut. The
 * tables at the top - what each card does, what each card costs - are the only
 * things anyone actually opens this for mid-round, so they come first and the
 * prose comes after, three or four lines of it. `docs/RULES.md` is where the
 * long version lives.
 *
 * Open or shut is the caller's state rather than this component's, because the
 * table has to know: the keys that slap are live on every screen, and reading
 * the rules must not be a way to play your hand by accident.
 */
export type RulesHelpProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * Whether this table lets a power be declined. It is the host's choice and
   * it changes what a turn is, so the rule book has to say which game is
   * actually being played rather than describing a default.
   */
  optionalPowers: boolean;
};

export function RulesHelp({ open, onOpenChange, optionalPowers }: RulesHelpProps): React.JSX.Element {
  const close = useCallback(() => onOpenChange(false), [onOpenChange]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      // Never while someone is typing their name or a room code.
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
      if (event.key === "i" || event.key === "I") {
        onOpenChange(!open);
        return;
      }
      if (event.key === "Escape") onOpenChange(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onOpenChange]);

  return (
    <>
      {open && <div className="help__scrim" onClick={close} aria-hidden="true" />}

      <div className="help">
        {open && (
          <section className="help__panel" role="dialog" aria-label="How to play" data-testid="rules-panel">
            <header className="help__head">
              <h2 className="help__title">How to play</h2>
              <button type="button" className="button button--ghost button--small" onClick={close}>
                Close
              </button>
            </header>

            <div className="help__body">
              <Rules optionalPowers={optionalPowers} />
            </div>
          </section>
        )}

        <button
          type="button"
          className="help__button"
          onClick={() => onOpenChange(!open)}
          aria-expanded={open}
          aria-label="How to play"
          title="How to play (i)"
          data-testid="rules-button"
        >
          i
        </button>
      </div>
    </>
  );
}

function Rules({ optionalPowers }: { optionalPowers: boolean }): React.JSX.Element {
  return (
    <>
      <h3 className="help__h">Powers</h3>
      <p className="help__lede" data-testid="powers-rule">
        Discard a card straight from the deck and it does this.{" "}
        {optionalPowers ? (
          "Optional, every time - you can wave it away."
        ) : (
          <strong>Not optional: you trigger it, you use it.</strong>
        )}
      </p>
      <dl className="help__pairs">
        <dt>7 8</dt>
        <dd>Look at one of your own cards</dd>
        <dt>9 10</dt>
        <dd>Look at someone else&rsquo;s card</dd>
        <dt>J Q</dt>
        <dd>Swap any two cards on the table</dd>
        <dt>K</dt>
        <dd>Look at any card, then swap any two{optionalPowers ? " \u2014 or pass" : ""}</dd>
      </dl>

      <h3 className="help__h">Points</h3>
      <p className="help__lede">Lowest hand wins the round.</p>
      <dl className="help__pairs help__pairs--tight">
        <dt>A</dt>
        <dd>1</dd>
        <dt>2&ndash;10</dt>
        <dd>Face value</dd>
        <dt>J Q</dt>
        <dd>10</dd>
        <dt>
          K<span className="help__suit help__suit--black">&spades;&clubs;</span>
        </dt>
        <dd>13</dd>
        <dt>
          K<span className="help__suit help__suit--red">&hearts;&diams;</span>
        </dt>
        <dd>&minus;1</dd>
        <dt>Joker</dt>
        <dd>0</dd>
      </dl>

      <h3 className="help__h">Your turn</h3>
      <ul className="help__list">
        <li>Draw from the deck, or take the face-up discard.</li>
        <li>A drawn card goes into your hand, or onto the pile &mdash; where it fires its power.</li>
        <li>A taken card must go into your hand, and fires nothing.</li>
      </ul>

      <h3 className="help__h">Slapping</h3>
      <ul className="help__list">
        <li>
          Any time, anyone: hit <strong>SLAP</strong> if a card matches the rank of the discard top.
        </li>
        <li>
          <strong>The table stops until you turn a card over.</strong> Nobody plays, and the clock on the turn you
          interrupted is held where it was.
        </li>
        <li>Right, and your card goes. Right on somebody else&rsquo;s, and you owe them one of yours.</li>
        <li>Wrong, or too slow to pick, and you take a card.</li>
        <li>Empty your hand and the round ends on the spot.</li>
      </ul>

      <h3 className="help__h">Slapping at the same moment</h3>
      <ul className="help__list">
        <li>It is a queue, not a duel. Being second never costs you anything by itself.</li>
        <li>
          The first slap is played. <strong>If it was right, the queue stops</strong> and everyone behind it walks away
          clean.
        </li>
        <li>If it was wrong, that player takes a card and the next in the queue has to turn one over.</li>
      </ul>

      <h3 className="help__h">Calling Cambio</h3>
      <ul className="help__list">
        <li>Call it instead of drawing. It is your whole turn.</li>
        <li>Everyone else gets one more turn, then every hand is turned face up.</li>
        <li>Lowest total wins, and you win ties. Call without the lowest and it costs you ten.</li>
      </ul>

      <h3 className="help__h">Keys</h3>
      <dl className="help__pairs help__pairs--tight">
        <dt>
          <kbd>S</kbd>
        </dt>
        <dd>Slap, then click the card</dd>
        <dt>
          <kbd>1</kbd>&ndash;<kbd>4</kbd>
        </dt>
        <dd>Slap your own card in that slot outright</dd>
        <dt>
          <kbd>I</kbd>
        </dt>
        <dd>Open and close this</dd>
      </dl>
    </>
  );
}
