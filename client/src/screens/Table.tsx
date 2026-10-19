import { useEffect } from "react";
import { INITIAL_PEEKS, isInitialPeekSlot, type Action, type Card, type GameView, type PlayerId } from "@cambio/shared";
import type { Flash } from "../components/Card.js";
import { Piles } from "../components/Piles.js";
import { Seat } from "../components/Seat.js";
import { SnapBar } from "../components/SnapBar.js";
import { TableLog } from "../components/TableLog.js";
import { TurnClock } from "../components/TurnClock.js";
import { seatRing } from "../seating.js";
import type { LogLine, PickOne } from "../state/useGame.js";

export type TableProps = {
  view: GameView;
  me: PlayerId;
  snapArmed: boolean;
  snapPending: boolean;
  pick: PickOne;
  log: LogLine[];
  act: (action: Action) => void;
  snap: (targetId: PlayerId, slot: number) => void;
  armSnap: (armed: boolean) => void;
  setPick: (pick: PickOne) => void;
  revealFor: (ownerId: PlayerId, slot: number) => Card | null;
  flashFor: (ownerId: PlayerId, slot: number) => Flash | null;
  pileFlash: (pile: "deck" | "discard") => boolean;
  onLeave: () => void;
};

type SlotState = "idle" | "targetable" | "selected" | "snap";

export function Table(props: TableProps): React.JSX.Element {
  const { view, me, snapArmed, snapPending, pick, log, act, snap, armSnap, setPick } = props;
  const { revealFor, flashFor, pileFlash, onLeave } = props;

  const myTurn = view.turnPlayerId === me;
  const mySeat = view.players.find((p) => p.id === me);
  const ownSlots = mySeat?.slots.length ?? 0;
  const iOweACard = view.snapDebt?.snapperId === me;

  /**
   * Keyboard is the fast path that makes the race winnable: S arms snapping and
   * the number keys snap your own cards outright, with no second click.
   */
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.target instanceof HTMLInputElement) return;

      if (event.key === "Escape") {
        armSnap(false);
        setPick(null);
        return;
      }
      if (event.key === "s" || event.key === "S") {
        if (view.snapOpen) armSnap(!snapArmed);
        return;
      }
      const digit = Number.parseInt(event.key, 10);
      if (!Number.isNaN(digit) && digit >= 1 && digit <= ownSlots && view.snapOpen) {
        snap(me, digit - 1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [view.snapOpen, snapArmed, ownSlots, me, armSnap, setPick, snap]);

  /** What clicking a given slot would mean right now. */
  const slotState = (ownerId: PlayerId, slot: number): SlotState => {
    if (snapArmed && view.snapOpen) return "snap";
    const mine = ownerId === me;

    if (pick !== null && pick.ownerId === ownerId && pick.slot === slot) return "selected";

    if (view.phase === "study") {
      if (!mine || mySeat === undefined || mySeat.ready) return "idle";
      // Only the bottom row is studiable, and only once each.
      const studiable = isInitialPeekSlot(slot, mySeat.slots.length, INITIAL_PEEKS);
      return studiable && !mySeat.peeked.includes(slot) ? "targetable" : "idle";
    }
    if (view.phase === "snapGiveCard") return iOweACard && mine ? "targetable" : "idle";
    if (!myTurn) return "idle";

    switch (view.phase) {
      case "holdingCard":
        return mine ? "targetable" : "idle";
      case "powerPeekOwn":
        return mine ? "targetable" : "idle";
      case "powerPeekOther":
        return mine ? "idle" : "targetable";
      // Every swapping power takes any two cards on the table, so every card
      // is live at every step of them.
      case "powerFreeSwap":
      case "powerKing":
        return "targetable";
      default:
        return "idle";
    }
  };

  /** The two clicks a swapping power takes: choose a card, then its partner. */
  const chooseForSwap = (ownerId: PlayerId, slot: number): void => {
    if (pick === null) {
      setPick({ ownerId, slot });
    } else if (pick.ownerId === ownerId && pick.slot === slot) {
      // Clicking the chosen card again lets the player change their mind.
      setPick(null);
    } else {
      act({ a: "freeSwap", aId: pick.ownerId, aSlot: pick.slot, bId: ownerId, bSlot: slot });
      setPick(null);
    }
  };

  const onSlot = (ownerId: PlayerId, slot: number): void => {
    if (snapArmed && view.snapOpen) {
      snap(ownerId, slot);
      return;
    }
    const mine = ownerId === me;

    if (view.phase === "study" && mine) {
      act({ a: "initialPeek", slot });
      return;
    }
    if (view.phase === "snapGiveCard") {
      if (iOweACard && mine) act({ a: "snapGive", slot });
      return;
    }
    if (!myTurn) return;

    switch (view.phase) {
      case "holdingCard":
        if (mine) act({ a: "swapWithSlot", slot });
        return;
      case "powerPeekOwn":
        if (mine) act({ a: "peekOwn", slot });
        return;
      case "powerPeekOther":
        if (!mine) act({ a: "peekOther", playerId: ownerId, slot });
        return;
      case "powerFreeSwap":
        chooseForSwap(ownerId, slot);
        return;
      case "powerKing":
        // The look comes first; after that a king swaps like a jack or queen.
        if (!view.kingPeeked) act({ a: "peekOther", playerId: ownerId, slot });
        else chooseForSwap(ownerId, slot);
        return;
      default:
        return;
    }
  };

  // Everyone round one table, you at the bottom, in the order they would sit.
  const ring = seatRing(view.players, me);

  return (
    <main className="table" data-players={view.players.length}>
      <header className="table__bar">
        <span className="table__code">{view.code}</span>
        <span className="table__status" data-testid="prompt">
          {prompt(view, me, pick, iOweACard)}
        </span>
        <span className="table__right">
          <TurnClock endsAt={view.turnEndsAt} />
          <button type="button" className="button button--ghost button--small" onClick={onLeave}>
            Leave
          </button>
        </span>
      </header>

      <div className="felt">
        <div className="felt__surface" aria-hidden="true" />

        <div className="felt__middle">
          <Piles
            deckCount={view.deckCount}
            discardTop={view.discardTop}
            discardCount={view.discardCount}
            canDrawDeck={myTurn && view.phase === "awaitingAction"}
            canDrawDiscard={myTurn && view.phase === "awaitingAction" && view.discardTop !== null}
            snapArmed={snapArmed}
            deckMoved={pileFlash("deck")}
            discardMoved={pileFlash("discard")}
            onDrawDeck={() => act({ a: "drawDeck" })}
            onDrawDiscard={() => act({ a: "drawDiscard" })}
          />
        </div>

        {ring.map((placement) => (
          <Seat
            key={placement.player.id}
            placement={placement}
            isTurn={view.turnPlayerId === placement.player.id}
            targetable={(slot) => slotState(placement.player.id, slot)}
            onSlot={(slot) => onSlot(placement.player.id, slot)}
            revealFor={revealFor}
            flashFor={flashFor}
            holding={view.heldBy === placement.player.id}
            heldCard={view.heldBy === placement.player.id ? view.heldCard : null}
            heldFromDiscard={view.heldFromDiscard}
          />
        ))}

        <TableLog lines={log} />
      </div>

      <footer className="table__controls">
        <SnapBar
          open={view.snapOpen}
          armed={snapArmed}
          pending={snapPending}
          ownSlots={ownSlots}
          onArm={armSnap}
        />

        <div className="table__buttons">
          {view.phase === "study" && mySeat?.ready !== true && (
            <button
              type="button"
              className="button button--primary"
              onClick={() => act({ a: "readyUp" })}
              data-testid="ready-button"
            >
              Ready
            </button>
          )}

          {myTurn && view.phase === "awaitingAction" && view.finalTurnsRemaining === null && (
            <button
              type="button"
              className="button button--danger"
              onClick={() => act({ a: "callCambio" })}
              data-testid="cambio-button"
            >
              Call Cambio
            </button>
          )}

          {/*
            The drawn card itself sits at your seat, above your hand; only the
            choice of what to do with it belongs down here with the rest of the
            turn's buttons.
          */}
          {myTurn && view.phase === "holdingCard" && !view.heldFromDiscard && (
            <button
              type="button"
              className="button"
              onClick={() => act({ a: "discardDrawn" })}
              data-testid="discard-drawn"
            >
              Discard it
            </button>
          )}

          {myTurn && view.pendingPower !== null && (
            <button
              type="button"
              className="button button--ghost"
              onClick={() => {
                setPick(null);
                act({ a: "forfeitPower" });
              }}
              data-testid="skip-power"
            >
              Skip the power
            </button>
          )}

          {myTurn && view.phase === "powerKing" && view.kingPeeked && (
            <button type="button" className="button" onClick={() => act({ a: "kingSkip" })} data-testid="king-pass">
              Keep both cards
            </button>
          )}
        </div>
      </footer>
    </main>
  );
}

/** One line telling the player exactly what the table is waiting for. */
function prompt(view: GameView, me: PlayerId, pick: PickOne, iOweACard: boolean): string {
  const mySeat = view.players.find((p) => p.id === me);
  const turnName = view.players.find((p) => p.id === view.turnPlayerId)?.name ?? "someone";

  if (view.phase === "finished") {
    const winner = view.players.find((p) => p.id === view.winnerId)?.name ?? "nobody";
    return `Round over - ${winner} wins`;
  }
  if (view.phase === "study") {
    return mySeat?.ready === true
      ? "Waiting for the others to finish studying..."
      : "Look at your two bottom cards, then hit Ready";
  }
  if (view.phase === "snapGiveCard") {
    const owed = view.players.find((p) => p.id === view.snapDebt?.targetId)?.name ?? "them";
    return iOweACard ? `Pick a card to give ${owed}` : "Waiting for a card to change hands...";
  }
  if (view.turnPlayerId !== me) {
    return `${turnName}'s turn${view.finalTurnsRemaining !== null ? " - final turns" : ""}`;
  }

  switch (view.phase) {
    case "awaitingAction":
      return "Your turn - draw from the deck or the pile";
    case "holdingCard":
      return view.heldFromDiscard
        ? "Taken from the pile - it must go into your hand"
        : "Swap it into your hand, or discard it";
    case "powerPeekOwn":
      return "Seven or eight - look at one of your own cards";
    case "powerPeekOther":
      return "Nine or ten - look at an opponent's card";
    case "powerFreeSwap":
      return pick === null
        ? "Jack or queen - pick any card on the table"
        : "Now pick the card to swap it with - either hand will do";
    case "powerKing":
      if (!view.kingPeeked) return "King - look at any card on the table";
      return pick === null
        ? "Now pick any card to swap, or keep both as they are"
        : "Now pick the card to swap it with - either hand will do";
    default:
      return "Your turn";
  }
}
