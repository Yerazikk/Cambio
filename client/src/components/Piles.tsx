import type { Card } from "@cambio/shared";
import { CardFace } from "./Card.js";

export type PilesProps = {
  deckCount: number;
  discardTop: Card | null;
  discardCount: number;
  canDrawDeck: boolean;
  canDrawDiscard: boolean;
  /**
   * Holding a drawn card: the pile is the second way to throw it away, for
   * anyone who reaches for the table rather than the button.
   */
  canDiscardDrawn: boolean;
  snapArmed: boolean;
  /** Set briefly when a card has just come off or landed on that pile. */
  deckMoved: boolean;
  discardMoved: boolean;
  onDrawDeck: () => void;
  onDrawDiscard: () => void;
  onDiscardDrawn: () => void;
};

/**
 * The middle of the table: the deck to draw from and the pile to snap against.
 *
 * Both are drawn as stacks rather than single cards. It is the one place where
 * depth is information - you can see at a glance that there is still something
 * to draw, and that the discard is a pile with history under its top card.
 */
export function Piles({
  deckCount,
  discardTop,
  discardCount,
  canDrawDeck,
  canDrawDiscard,
  canDiscardDrawn,
  snapArmed,
  deckMoved,
  discardMoved,
  onDrawDeck,
  onDrawDiscard,
  onDiscardDrawn,
}: PilesProps): React.JSX.Element {
  // The two uses of the discard pile never overlap - you are either starting a
  // turn or finishing one - so one click target carries both.
  const discardLive = (canDrawDiscard || canDiscardDrawn) && !snapArmed;

  return (
    <div className="piles">
      <div className={`pile${deckMoved ? " pile--moved" : ""}`}>
        <div className="pile__stack">
          <CardFace
            card={null}
            size="large"
            state={canDrawDeck && !snapArmed ? "targetable" : "idle"}
            onClick={onDrawDeck}
            testId="deck"
          />
        </div>
        <span className="pile__label">
          Deck <strong data-testid="deck-count">{deckCount}</strong>
        </span>
      </div>

      <div className={`pile${discardMoved ? " pile--moved" : ""}`}>
        <div className="pile__stack">
          <CardFace
            card={discardTop}
            size="large"
            state={discardLive ? "targetable" : "idle"}
            onClick={canDiscardDrawn ? onDiscardDrawn : onDrawDiscard}
            testId="discard"
          />
        </div>
        <span className="pile__label">
          Discard <strong data-testid="discard-count">{discardCount}</strong>
        </span>
      </div>
    </div>
  );
}
