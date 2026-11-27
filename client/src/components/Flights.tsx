import { useLayoutEffect, useRef, useState } from "react";
import type { Card } from "@cambio/shared";
import { CardFace } from "./Card.js";

/**
 * A card crossing the table, so a move can be watched rather than deduced.
 *
 * Cambio is played face down, which means almost nothing about a turn is
 * visible on the cards themselves. A ring round a slot says *that* something
 * happened to it; it does not say what came from where. A card that actually
 * travels does: you see the drawn card go into the hand and the one it
 * displaced leave for the pile, you see two cards cross on a swap, you see
 * the card you slapped go to the discard.
 *
 * Nothing here is authoritative. Flights are drawn over a table that has
 * already updated, purely so the eye can follow what the state just did, and
 * a flight that cannot find both ends of its trip is dropped rather than
 * guessed at.
 */

/** One end of a trip, named by `data-anchor` on the element that holds it. */
export type Anchor = string;

/**
 * What is printed on a card while it flies.
 *
 * Mostly nothing: a face-down card crossing the table is still face down.
 * The two exceptions are the ends of a trip that are public anyway - a card
 * landing on the discard pile, and one coming off it - which is why those are
 * named rather than carried: they are read off the view at the moment the
 * flight starts.
 */
export type FlightFace = "down" | "discardTop" | "heldCard" | Card;

export type Flight = {
  id: number;
  /**
   * Where the card starts and ends, each in order of preference. A trip can
   * begin somewhere that no longer exists by the time it is drawn - the drawn
   * card is gone the instant it is played - so the seat it belonged to stands
   * in behind it.
   */
  from: Anchor[];
  to: Anchor[];
  face: FlightFace;
};

export type FlightsProps = {
  flights: Flight[];
  /** The pile's top card, for a flight that is on its way to or from it. */
  discardTop: Card | null;
  /** The card in somebody's hand, likewise. */
  heldCard: Card | null;
  /** Called once a flight has landed, so it can be forgotten. */
  onLanded: (id: number) => void;
};

/** How long a card takes to cross the table. */
const FLIGHT_MS = 520;

export function Flights({ flights, discardTop, heldCard, onLanded }: FlightsProps): React.JSX.Element {
  const layer = useRef<HTMLDivElement>(null);

  return (
    <div className="flights" ref={layer} aria-hidden="true">
      {flights.map((flight) => (
        <FlightCard
          key={flight.id}
          flight={flight}
          layer={layer}
          discardTop={discardTop}
          heldCard={heldCard}
          onLanded={onLanded}
        />
      ))}
    </div>
  );
}

type Trip = { x0: number; y0: number; x1: number; y1: number };

function FlightCard({
  flight,
  layer,
  discardTop,
  heldCard,
  onLanded,
}: {
  flight: Flight;
  layer: React.RefObject<HTMLDivElement | null>;
  discardTop: Card | null;
  heldCard: Card | null;
  onLanded: (id: number) => void;
}): React.JSX.Element | null {
  const [trip, setTrip] = useState<Trip | null>(null);

  /*
   * The face is settled once, on the way out, and then held.
   *
   * A flight outlives the move that started it by half a second, and in a
   * fast exchange the pile can have changed again underneath it. Freezing the
   * face here means a card always lands showing what it actually was, not
   * whatever is on top of the pile by the time it gets there.
   */
  const [face] = useState<Card | null>(() => {
    if (flight.face === "down") return null;
    if (flight.face === "discardTop") return discardTop;
    if (flight.face === "heldCard") return heldCard;
    return flight.face;
  });

  /*
   * Measured in a layout effect rather than on render: both ends have to be
   * read off a table that has already been laid out, and this is the first
   * moment that is true.
   */
  useLayoutEffect(() => {
    const box = layer.current?.getBoundingClientRect();
    const from = centreOf(flight.from, box);
    const to = centreOf(flight.to, box);

    // A trip with an end missing is not drawn at all. The ring on the slot
    // has already said what happened; an invented path would say something
    // that did not.
    if (box === undefined || from === null || to === null) {
      onLanded(flight.id);
      return;
    }
    setTrip({ x0: from.x, y0: from.y, x1: to.x, y1: to.y });
    // Measured once, for one flight, which never changes after it is made.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (trip === null) return null;

  const style = {
    "--fx0": `${trip.x0}px`,
    "--fy0": `${trip.y0}px`,
    "--fx1": `${trip.x1}px`,
    "--fy1": `${trip.y1}px`,
    "--fdur": `${FLIGHT_MS}ms`,
  } as React.CSSProperties;

  return (
    <div className="flight" style={style} onAnimationEnd={() => onLanded(flight.id)}>
      <CardFace card={face} />
    </div>
  );
}

/**
 * The middle of the first of these anchors that is actually on screen, in the
 * flight layer's own coordinates.
 *
 * Centres rather than corners, because a hand is turned to face whoever is
 * sitting at it: a rotated card's bounding box is the wrong shape, but its
 * middle is still its middle.
 */
function centreOf(anchors: Anchor[], box: DOMRect | undefined): { x: number; y: number } | null {
  if (box === undefined) return null;
  for (const anchor of anchors) {
    const element = document.querySelector(`[data-anchor="${CSS.escape(anchor)}"]`);
    if (element === null) continue;
    const rect = element.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) continue;
    return { x: rect.left + rect.width / 2 - box.left, y: rect.top + rect.height / 2 - box.top };
  }
  return null;
}
