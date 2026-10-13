import type { Card } from "@cambio/shared";
import { CardFace } from "./Card.js";

export type PilesProps = {
  deckCount: number;
  discardTop: Card | null;
  discardCount: number;
  canDrawDeck: boolean;
  canDrawDiscard: boolean;
  snapArmed: boolean;
  onDrawDeck: () => void;
  onDrawDiscard: () => void;
};

export function Piles({
  deckCount,
  discardTop,
  discardCount,
  canDrawDeck,
  canDrawDiscard,
  snapArmed,
  onDrawDeck,
  onDrawDiscard,
}: PilesProps): React.JSX.Element {
  return (
    <div className="piles">
      <div className="pile">
        <CardFace
          card={null}
          size="large"
          state={canDrawDeck && !snapArmed ? "targetable" : "idle"}
          onClick={onDrawDeck}
          testId="deck"
        />
        <span className="pile__label">
          Deck <strong data-testid="deck-count">{deckCount}</strong>
        </span>
      </div>

      <div className="pile">
        <CardFace
          card={discardTop}
          size="large"
          state={canDrawDiscard && !snapArmed ? "targetable" : "idle"}
          onClick={onDrawDiscard}
          testId="discard"
        />
        <span className="pile__label">
          Discard <strong data-testid="discard-count">{discardCount}</strong>
        </span>
      </div>
    </div>
  );
}
