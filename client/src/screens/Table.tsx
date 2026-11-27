import { useEffect } from "react";
import { INITIAL_PEEKS, isInitialPeekSlot, type Action, type Card, type GameView, type PlayerId } from "@cambio/shared";
import { CardFace, type Flash } from "../components/Card.js";
import { Flights, type Flight } from "../components/Flights.js";
import { Piles } from "../components/Piles.js";
import { Seat } from "../components/Seat.js";
import { SlapBar } from "../components/SlapBar.js";
import { TableLog } from "../components/TableLog.js";
import { TurnClock } from "../components/TurnClock.js";
import { seatRing } from "../seating.js";
import type { LogLine, PickOne } from "../state/useGame.js";

export type TableProps = {
  view: GameView;
  me: PlayerId;
  slapArmed: boolean;
  slapPending: boolean;
  /** True while the table is still flashing red from a slap that landed. */
  slapPulse: boolean;
  /** True while something is covering the table - the rule book - so its keys stand down. */
  keysHeld: boolean;
  /** Set while a fresh hand is on its way out to the seats. */
  dealing: boolean;
  pick: PickOne;
  log: LogLine[];
  /** Cards crossing the table, so a move can be watched rather than deduced. */
  flights: Flight[];
  landed: (id: number) => void;
  act: (action: Action) => void;
  slap: (targetId: PlayerId, slot: number) => void;
  /** Press SLAP: claims a place in the queue and stops the table. */
  claimSlap: () => void;
  setPick: (pick: PickOne) => void;
  revealFor: (ownerId: PlayerId, slot: number) => Card | null;
  flashFor: (ownerId: PlayerId, slot: number) => Flash | null;
  pileFlash: (pile: "deck" | "discard") => boolean;
  onLeave: () => void;
};

type SlotState = "idle" | "targetable" | "selected" | "slap";

export function Table(props: TableProps): React.JSX.Element {
  const { view, me, slapArmed, slapPending, slapPulse, keysHeld, dealing, pick, log, act, slap, claimSlap, setPick } = props;
  const { revealFor, flashFor, pileFlash, flights, landed, onLeave } = props;

  const myTurn = view.turnPlayerId === me;
  const mySeat = view.players.find((p) => p.id === me);
  const ownSlots = mySeat?.slots.length ?? 0;
  const iOweACard = view.slapDebt?.slapperId === me;
  /** You cannot call yourself ready before you know what you are holding. */
  const studied = (mySeat?.peeked.length ?? 0) >= INITIAL_PEEKS;

  /*
   * A slap stops the table. Whoever holds the lock owes it a card and nothing
   * else can happen until they turn one over; everyone behind them is already
   * committed and waits their go.
   */
  const lock = view.slapLock;
  const iHoldTheLock = lock !== null && lock.holderId === me;
  const iAmQueued = lock !== null && lock.waiting.includes(me);
  /** Clicking a card means slapping it: either I hold the lock, or I just pressed SLAP. */
  const slapping = iHoldTheLock || (slapArmed && lock === null);
  /** A card drawn from the deck can be thrown away - from the button or the pile. */
  const canDiscardDrawn = myTurn && view.phase === "holdingCard" && !view.heldFromDiscard;

  /**
   * Keyboard is the fast path that makes the race winnable: S arms slapping and
   * the number keys slap your own cards outright, with no second click.
   *
   * Which is exactly why they go quiet while the rule book is open. A player
   * reading about slapping is not making one, and a keystroke there must not
   * cost them a card.
   */
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.target instanceof HTMLInputElement || keysHeld) return;

      // Escape drops a half-made choice. It no longer unslaps: once the table
      // has stopped on you there is nothing to back out of.
      if (event.key === "Escape") {
        setPick(null);
        return;
      }
      if (event.key === "s" || event.key === "S") {
        if (view.slapOpen && !slapping && !iAmQueued) claimSlap();
        return;
      }
      const digit = Number.parseInt(event.key, 10);
      if (!Number.isNaN(digit) && digit >= 1 && digit <= ownSlots && view.slapOpen && !iAmQueued) {
        slap(me, digit - 1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [view.slapOpen, slapping, iAmQueued, keysHeld, ownSlots, me, claimSlap, setPick, slap]);

  /** What clicking a given slot would mean right now. */
  const slotState = (ownerId: PlayerId, slot: number): SlotState => {
    if (slapping && view.slapOpen) return "slap";
    // Nothing on a stopped table is clickable except the slap it is stopped on.
    if (lock !== null) return "idle";
    const mine = ownerId === me;

    if (pick !== null && pick.ownerId === ownerId && pick.slot === slot) return "selected";
    // A king's picks are recorded server-side, so they survive a refresh and
    // light up on everyone's screen rather than only on the king's.
    if (view.kingPicks.some((p) => p.ownerId === ownerId && p.slot === slot)) return "selected";

    // A hole is not a card, so nothing can be done to it.
    const here = view.players.find((p) => p.id === ownerId)?.slots[slot];
    if (here === undefined || here.kind === "gap") return "idle";

    if (view.phase === "study") {
      if (!mine || mySeat === undefined || mySeat.ready) return "idle";
      // Only the bottom row is studiable, and only once each.
      const studiable = isInitialPeekSlot(slot, mySeat.slots.length, INITIAL_PEEKS);
      return studiable && !mySeat.peeked.includes(slot) ? "targetable" : "idle";
    }
    if (view.phase === "slapGiveCard") return iOweACard && mine ? "targetable" : "idle";
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
        return "targetable";
      // A king is naming the two cards it will look at. Once it has both, the
      // table goes quiet and the choice moves to the buttons.
      case "powerKing":
        return view.kingPicks.length < 2 ? "targetable" : "idle";
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
    if (slapping && view.slapOpen) {
      slap(ownerId, slot);
      return;
    }
    if (lock !== null) return;
    const mine = ownerId === me;

    if (view.phase === "study" && mine) {
      act({ a: "initialPeek", slot });
      return;
    }
    if (view.phase === "slapGiveCard") {
      if (iOweACard && mine) act({ a: "slapGive", slot });
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
        // A king names both cards before it sees either. The swap-or-keep
        // question comes afterwards, as two buttons, not as a third click.
        if (view.kingPicks.length < 2) act({ a: "kingPick", playerId: ownerId, slot });
        return;
      default:
        return;
    }
  };

  // Everyone round one table, you at the bottom, in the order they would sit.
  const ring = seatRing(view.players, me);

  return (
    <main
      className="table"
      data-testid="table"
      data-players={view.players.length}
      data-dealing={dealing ? "" : undefined}
      /*
       * Whose turn it is, as a fact about the table rather than a sentence on
       * it. The prompt used to carry this and no longer does - "your turn" is
       * said by the piles lighting up, which is quicker to read and does not
       * cost the table a line of furniture.
       */
      data-my-turn={myTurn ? "" : undefined}
      data-stopped={view.slapLock !== null ? "" : undefined}
      /*
       * A slap that landed, said in the one colour the table does not
       * otherwise use. The felt takes it rather than any one card, because a
       * slap is not a thing that happened to a card, it is a thing that
       * happened to the game - everything stopped.
       */
      data-slapped={slapPulse ? "" : undefined}
    >
      <header className="table__bar">
        <span className="table__code">{view.code}</span>
        <span className="table__status" data-testid="prompt">
          {prompt(view, me, pick, iOweACard, iHoldTheLock, iAmQueued)}
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
            canDrawDeck={myTurn && view.phase === "awaitingAction" && lock === null}
            canDrawDiscard={myTurn && view.phase === "awaitingAction" && view.discardTop !== null && lock === null}
            canDiscardDrawn={canDiscardDrawn && lock === null}
            slapArmed={slapping}
            deckMoved={pileFlash("deck")}
            discardMoved={pileFlash("discard")}
            onDrawDeck={() => act({ a: "drawDeck" })}
            onDrawDiscard={() => act({ a: "drawDiscard" })}
            onDiscardDrawn={() => act({ a: "discardDrawn" })}
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

        {/*
          The card in your own hand. Everyone else's sits on the felt at their
          seat, but yours is not on the table at all - you are holding it, so
          it comes up in front of you, tilted towards your eye and big enough
          to read at a glance, the way the card you are deciding about should
          be the loudest thing on the screen.
        */}
        {view.heldBy === me && (
          <div className="hand" data-testid="held-card">
            <CardFace card={view.heldCard} anchor={`held:${me}`} />
            <span className="hand__tag">{view.heldFromDiscard ? "taken" : "drawn"}</span>
          </div>
        )}

        {/*
          Over everything on the felt, because a card in the air is above the
          table. It is the last thing in here so it is the last thing painted.
        */}
        <Flights
          flights={flights}
          discardTop={view.discardTop}
          heldCard={view.heldCard}
          onLanded={landed}
        />

        <TableLog lines={log} />
      </div>

      <footer className="table__controls">
        <SlapBar
          open={view.slapOpen}
          picking={slapping}
          queued={iAmQueued}
          pending={slapPending}
          onClaim={claimSlap}
        />

        <div className="table__buttons">
          {view.phase === "study" && mySeat?.ready !== true && (
            <button
              type="button"
              className="button button--primary"
              disabled={!studied}
              onClick={() => act({ a: "readyUp" })}
              data-testid="ready-button"
            >
              {studied ? "Ready" : `Look at your ${INITIAL_PEEKS} bottom cards`}
            </button>
          )}

          {myTurn && view.phase === "awaitingAction" && view.finalTurnsRemaining === null && lock === null && (
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
          {canDiscardDrawn && (
            <button
              type="button"
              className="button"
              onClick={() => act({ a: "discardDrawn" })}
              data-testid="discard-drawn"
            >
              Discard it
            </button>
          )}

          {myTurn && view.pendingPower !== null && view.optionalPowers && view.phase !== "powerKingChoice" && (
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

          {/*
            The king's question, once both its cards are face up. Deciding is
            the power rather than a way out of it, so these are here at every
            table, whatever the host set Powers to.
          */}
          {myTurn && view.phase === "powerKingChoice" && (
            <>
              <button
                type="button"
                className="button button--primary"
                onClick={() => act({ a: "kingSwap" })}
                data-testid="king-swap"
              >
                Swap them
              </button>
              <button type="button" className="button" onClick={() => act({ a: "kingSkip" })} data-testid="king-pass">
                Keep both
              </button>
            </>
          )}
        </div>
      </footer>
    </main>
  );
}

/**
 * One line telling the player what the table is waiting for - and nothing when
 * it is waiting for the obvious. Your own turn starting needs no caption: the
 * piles light up, which says it better than a sentence does.
 */
function prompt(
  view: GameView,
  me: PlayerId,
  pick: PickOne,
  iOweACard: boolean,
  iHoldTheLock: boolean,
  iAmQueued: boolean,
): string {
  const mySeat = view.players.find((p) => p.id === me);
  const turnName = view.players.find((p) => p.id === view.turnPlayerId)?.name ?? "someone";

  // A slap outranks everything: the table has stopped, and that is the only
  // thing anyone needs to be told until it starts again.
  if (view.slapLock !== null) {
    if (iHoldTheLock) return "Flip a card to slap";
    const holder = view.players.find((p) => p.id === view.slapLock?.holderId)?.name ?? "someone";
    return iAmQueued ? `${holder} slaps first - you are next` : `${holder} is slapping`;
  }

  if (view.phase === "finished") {
    const winner = view.players.find((p) => p.id === view.winnerId)?.name ?? "nobody";
    return `Round over - ${winner} wins`;
  }
  if (view.phase === "study") {
    if (mySeat?.ready === true) return "Waiting for the others to finish studying...";
    const left = INITIAL_PEEKS - (mySeat?.peeked.length ?? 0);
    if (left <= 0) return "Remember them, then hit Ready";
    // Said as a count, because the point of the line is how many are left.
    return left === 1
      ? "Look at your other bottom card"
      : `Look at your ${left} bottom cards - the ones nearest you`;
  }
  if (view.phase === "slapGiveCard") {
    const owed = view.players.find((p) => p.id === view.slapDebt?.targetId)?.name ?? "them";
    return iOweACard ? `Pick a card to give ${owed}` : "Waiting for a card to change hands...";
  }
  if (view.turnPlayerId !== me) {
    return `${turnName}'s turn${view.finalTurnsRemaining !== null ? " - final turns" : ""}`;
  }

  switch (view.phase) {
    case "awaitingAction":
      return "";
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
      return view.kingPicks.length === 0
        ? "King - pick any two cards on the table"
        : "Now pick the second card - either hand will do";
    case "powerKingChoice":
      return "Swap these two, or keep them where they are?";
    default:
      return "Your turn";
  }
}
