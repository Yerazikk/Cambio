import { useEffect } from "react";
import type { Action, Card, GameView, PlayerId } from "@cambio/shared";
import { CardFace } from "../components/Card.js";
import { Hand } from "../components/Hand.js";
import { Piles } from "../components/Piles.js";
import { SnapBar } from "../components/SnapBar.js";
import { TurnClock } from "../components/TurnClock.js";
import type { PickOne } from "../state/useGame.js";

export type TableProps = {
  view: GameView;
  me: PlayerId;
  snapArmed: boolean;
  snapPending: boolean;
  pick: PickOne;
  act: (action: Action) => void;
  snap: (targetId: PlayerId, slot: number) => void;
  armSnap: (armed: boolean) => void;
  setPick: (pick: PickOne) => void;
  revealFor: (ownerId: PlayerId, slot: number) => Card | null;
  onLeave: () => void;
};

type SlotState = "idle" | "targetable" | "selected" | "snap";

export function Table(props: TableProps): React.JSX.Element {
  const { view, me, snapArmed, snapPending, pick, act, snap, armSnap, setPick, revealFor, onLeave } = props;

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

    if (pick !== null && mine && pick.mySlot === slot) return "selected";

    if (view.phase === "study") {
      const used = mySeat?.ready === true;
      return mine && !used ? "targetable" : "idle";
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
      case "powerBlindSwap":
        return pick === null ? (mine ? "targetable" : "idle") : mine ? "idle" : "targetable";
      case "powerKing":
        if (!view.kingPeeked) return "targetable";
        return pick === null ? (mine ? "targetable" : "idle") : mine ? "idle" : "targetable";
      default:
        return "idle";
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
      case "powerBlindSwap":
        if (pick === null && mine) setPick({ mySlot: slot });
        else if (pick !== null && !mine) {
          act({ a: "blindSwap", mySlot: pick.mySlot, targetId: ownerId, targetSlot: slot });
          setPick(null);
        }
        return;
      case "powerKing":
        if (!view.kingPeeked) {
          act({ a: "peekOther", playerId: ownerId, slot });
        } else if (pick === null && mine) {
          setPick({ mySlot: slot });
        } else if (pick !== null && !mine) {
          act({ a: "kingSwap", mySlot: pick.mySlot, targetId: ownerId, targetSlot: slot });
          setPick(null);
        }
        return;
      default:
        return;
    }
  };

  const others = view.players.filter((p) => p.id !== me);

  return (
    <main className="table">
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

      <div className="table__opponents">
        {others.map((player) => (
          <Hand
            key={player.id}
            player={player}
            isYou={false}
            isTurn={view.turnPlayerId === player.id}
            targetable={(slot) => slotState(player.id, slot)}
            onSlot={(slot) => onSlot(player.id, slot)}
            revealFor={revealFor}
          />
        ))}
      </div>

      <div className="table__middle">
        <Piles
          deckCount={view.deckCount}
          discardTop={view.discardTop}
          discardCount={view.discardCount}
          canDrawDeck={myTurn && view.phase === "awaitingAction"}
          canDrawDiscard={myTurn && view.phase === "awaitingAction" && view.discardTop !== null}
          snapArmed={snapArmed}
          onDrawDeck={() => act({ a: "drawDeck" })}
          onDrawDiscard={() => act({ a: "drawDiscard" })}
        />

        {view.heldCard !== null && (
          <div className="held" data-testid="held-card">
            <CardFace card={view.heldCard} size="large" label="drawn" />
            <p className="held__hint">
              {view.heldFromDiscard
                ? "Taken from the pile - it must go into your hand."
                : "Click one of your cards to swap, or discard it."}
            </p>
            {!view.heldFromDiscard && (
              <button
                type="button"
                className="button"
                onClick={() => act({ a: "discardDrawn" })}
                data-testid="discard-drawn"
              >
                Discard it
              </button>
            )}
          </div>
        )}
      </div>

      <div className="table__you">
        {mySeat && (
          <Hand
            player={mySeat}
            isYou
            isTurn={myTurn}
            targetable={(slot) => slotState(me, slot)}
            onSlot={(slot) => onSlot(me, slot)}
            revealFor={revealFor}
          />
        )}
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
      : "Look at two of your cards, then hit Ready";
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
      return "Swap it into your hand, or discard it";
    case "powerPeekOwn":
      return "Seven or eight - look at one of your own cards";
    case "powerPeekOther":
      return "Nine or ten - look at an opponent's card";
    case "powerBlindSwap":
      return pick === null
        ? "Jack or queen - pick one of your cards to trade away"
        : "Now pick the opponent's card to take";
    case "powerKing":
      if (!view.kingPeeked) return "King - look at any card on the table";
      return pick === null ? "Now swap a pair, or keep both" : "Pick the opponent's card to take";
    default:
      return "Your turn";
  }
}
