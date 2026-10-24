import type { Card, PlayerId } from "@cambio/shared";
import { CardFace, type Flash } from "./Card.js";
import type { Placement } from "../seating.js";

export type SeatProps = {
  placement: Placement;
  isTurn: boolean;
  /** Which slots can be clicked right now, and what the click means. */
  targetable: (slot: number) => "idle" | "targetable" | "selected" | "snap";
  onSlot: (slot: number) => void;
  /** A transient peek, if this player's slot is currently face up for us. */
  revealFor: (ownerId: PlayerId, slot: number) => Card | null;
  /** The move this slot is in the middle of, if any. */
  flashFor: (ownerId: PlayerId, slot: number) => Flash | null;
  /** Set while this player has a card off the pile in their hand. */
  holding: boolean;
  /** The held card's face, where this viewer is entitled to it. */
  heldCard: Card | null;
  heldFromDiscard: boolean;
};

/**
 * One player's place at the table: their name plate, their hand, and the card
 * they are holding.
 *
 * The name plate is always on the outside and the hand below it. The card a
 * player has drawn goes where they would actually put it down: below your own
 * hand, so your cards sit above the one you have temporarily picked up, and
 * out towards the middle of the felt for everyone else - which is both where
 * you would see it across a real table and the one part of the table that is
 * always clear, so a seat never grows into its neighbour.
 */
export function Seat({
  placement,
  isTurn,
  targetable,
  onSlot,
  revealFor,
  flashFor,
  holding,
  heldCard,
  heldFromDiscard,
}: SeatProps): React.JSX.Element {
  const { player, isYou, side } = placement;

  const classes = ["seat", `seat--${side}`];
  if (isYou) classes.push("seat--you");
  if (isTurn) classes.push("seat--turn");
  if (!player.connected) classes.push("seat--away");
  if (holding) classes.push("seat--holding");

  /*
   * What the seat needs in order to be dealt to: its place in the deal order,
   * and the direction the middle of the table lies in, so its cards arrive
   * from the piles rather than from nowhere in particular.
   */
  const style = {
    left: `${placement.x}%`,
    top: `${placement.y}%`,
    "--seat-order": placement.turnOffset,
    "--deal-x": `${placement.inX * 46}px`,
    "--deal-y": `${placement.inY * 46}px`,
  } as React.CSSProperties;

  return (
    <section className={classes.join(" ")} style={style} data-testid={`seat-${player.name}`} aria-label={`${player.name}'s hand`}>
      <header className="seat__head">
        <span className="seat__name">
          {player.name}
          {isYou && <span className="chip chip--quiet">you</span>}
          {player.isHost && <span className="chip chip--brass">host</span>}
        </span>
        <span className="seat__meta">
          {!player.connected && (
            <span className="chip chip--quiet" data-testid={`away-${player.name}`}>
              away
            </span>
          )}
          {player.calledCambio && <span className="chip chip--red">Cambio</span>}
          {player.score !== null && (
            <span className="seat__score" data-testid={`score-${player.name}`}>
              {player.score}
            </span>
          )}
        </span>
      </header>

      <div className="seat__play">
        <div className="seat__cards">
          {player.slots.map((slot, index) => {
            // A slot shows a face from one of two sources: the authoritative
            // view at the final reveal, or a peek we are being shown now.
            const face: Card | null = slot.known ? slot.card : revealFor(player.id, index);
            return (
              <CardFace
                key={slot.id}
                card={face}
                state={targetable(index)}
                flash={flashFor(player.id, index)}
                onClick={() => onSlot(index)}
                testId={`slot-${player.name}-${index}`}
                dealIndex={index}
                {...(isYou ? { label: String(index + 1) } : {})}
              />
            );
          })}
          {player.slots.length === 0 && <span className="seat__empty">no cards</span>}
        </div>

        {/*
          Face up only for its owner - or for the whole table when it came off
          the discard pile, which everyone watched go face up on the way out.
        */}
        {holding && (
          <div className="seat__held" data-testid={isYou ? "held-card" : `held-${player.name}`}>
            <CardFace card={heldCard} />
            <span className="seat__heldTag">{heldFromDiscard ? "taken" : "drawn"}</span>
          </div>
        )}
      </div>
    </section>
  );
}
