import { useCallback, useEffect } from "react";

/**
 * The rule book, one keystroke away.
 *
 * Cambio is a memory game with a race bolted on, and both halves have rules
 * people forget mid-round - what a nine does, what happens when two people
 * slap at once. A player who has to leave the table to look that up has lost
 * their turn, so it lives here: a mark in the corner of the screen, `i` to
 * open it, `Esc` to put it away.
 *
 * It is the same rule book as `docs/RULES.md`, in the shorter form you want
 * while the round is still running.
 *
 * Open or shut is the caller's state rather than this component's, because the
 * table has to know: the keys that slap are live on every screen, and reading
 * the rules must not be a way to play your hand by accident.
 */
export type RulesHelpProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

export function RulesHelp({ open, onOpenChange }: RulesHelpProps): React.JSX.Element {
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
              <Rules />
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

function Rules(): React.JSX.Element {
  return (
    <>
      <h3 className="help__h">The aim</h3>
      <p>
        End the round with the fewest points. You hold four cards face down and you may study two of them before play
        starts. After that, remembering them is your problem - a card is shown once and never again.
      </p>

      <h3 className="help__h">Scoring</h3>
      <dl className="help__pairs">
        <dt>Ace</dt>
        <dd>1</dd>
        <dt>2&ndash;10</dt>
        <dd>Face value</dd>
        <dt>Jack, Queen</dt>
        <dd>10</dd>
        <dt>Black King</dt>
        <dd>13</dd>
        <dt>Red King</dt>
        <dd>&minus;1</dd>
        <dt>Joker</dt>
        <dd>0</dd>
      </dl>

      <h3 className="help__h">Your turn</h3>
      <p>
        Draw from the deck, take the face-up discard, or call Cambio. A card drawn from the deck can be swapped into
        your hand or discarded, and discarding it triggers its power. A card taken off the discard pile grants no power
        and must go into your hand.
      </p>

      <h3 className="help__h">Powers</h3>
      <dl className="help__pairs">
        <dt>7, 8</dt>
        <dd>Look at one of your own cards</dd>
        <dt>9, 10</dt>
        <dd>Look at one of another player&rsquo;s cards</dd>
        <dt>J, Q</dt>
        <dd>Swap any two cards on the table</dd>
        <dt>K</dt>
        <dd>Look at any card, then swap any two &ndash; or pass</dd>
      </dl>
      <p className="help__aside">Powers are optional. Everyone sees which cards you touch, never their faces.</p>

      <h3 className="help__h">Slapping</h3>
      <p>
        At any time, if a card in any hand matches the <em>rank</em> of the discard top, you can slap it. Slap your own
        and it leaves your hand. Slap someone else&rsquo;s and theirs is discarded, but you owe them one of yours. Get
        the rank wrong and you take a penalty card, face down. Empty your hand and the round ends on the spot.
      </p>

      <h3 className="help__h">Slapping at the same moment</h3>
      <p>
        Two people going for the same card is a queue, not a duel. A faster slap does not cancel a slower one &ndash; it
        only goes first.
      </p>
      <ol className="help__steps">
        <li>Slaps made in the same instant are put in order, earliest first.</li>
        <li>The first one is played out.</li>
        <li>
          <strong>If it was right, the queue stops.</strong> Everyone behind it keeps their card and pays nothing.
        </li>
        <li>
          <strong>If it was wrong</strong>, that player takes a penalty card and the next slap in the queue is played
          out &ndash; then the third, and so on.
        </li>
      </ol>
      <p className="help__aside">
        So slapping just after someone else is never punished for being late. It is only ever a bet that the player
        ahead of you got it wrong. A double-tap counts once.
      </p>

      <h3 className="help__h">Calling Cambio</h3>
      <p>
        Instead of drawing, call Cambio. Everyone else takes one final turn, then every hand is revealed. Lowest total
        wins and the caller takes ties &ndash; but call without the lowest hand and you take ten points. Slapping stays
        live through the final turns.
      </p>

      <h3 className="help__h">Keys</h3>
      <dl className="help__pairs">
        <dt>
          <kbd>S</kbd>
        </dt>
        <dd>Arm slapping, then click any card to slap it</dd>
        <dt>
          <kbd>1</kbd>&ndash;<kbd>4</kbd>
        </dt>
        <dd>Slap your own card in that slot outright</dd>
        <dt>
          <kbd>Esc</kbd>
        </dt>
        <dd>Cancel slapping, or a half-made choice</dd>
        <dt>
          <kbd>I</kbd>
        </dt>
        <dd>Open and close this help</dd>
      </dl>
    </>
  );
}
