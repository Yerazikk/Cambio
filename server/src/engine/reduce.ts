import {
  isInitialPeekSlot,
  powerFor,
  type CardId,
  type EngineAction,
  type ErrorCode,
  type Phase,
  type PlayerId,
  type Power,
  type ServerEvent,
  type SlotRef,
  type TableEventKind,
} from "@cambio/shared";
import { shuffle } from "../deck.js";
import type { Rng } from "../rng.js";
import { settle } from "./score.js";
import { discardTopCard, forgetCard, learn, seatOf, turnSeat, type GameState } from "./state.js";

export type ReduceCtx = { now: number; rng: Rng };

/** An event plus who is entitled to receive it. Peeks go to one player only. */
export type Outbound = { to: PlayerId | "all"; event: ServerEvent };

export type ReduceResult =
  | { ok: true; state: GameState; out: Outbound[] }
  | { ok: false; code: ErrorCode; message: string };

function fail(code: ErrorCode, message: string): ReduceResult {
  return { ok: false, code, message };
}

/**
 * The whole rule surface, as one pure function. It reads no clock and no
 * randomness of its own - both arrive in `ctx` - so every rule below is
 * reproducible in a test without a server, a socket, or a timer.
 */
export function reduce(
  prev: GameState,
  actorId: PlayerId,
  action: EngineAction,
  ctx: ReduceCtx,
): ReduceResult {
  const result = applyAction(prev, actorId, action, ctx);
  // One place to bump the version, so no rule branch can forget to.
  if (result.ok) result.state.version = prev.version + 1;
  return result;
}

function applyAction(
  prev: GameState,
  actorId: PlayerId,
  action: EngineAction,
  ctx: ReduceCtx,
): ReduceResult {
  const state = structuredClone(prev);
  const out: Outbound[] = [];

  // The arbiter speaks for the system rather than for a player, and names its
  // winner in the payload, so this is settled before any actor check. A winner
  // who has since left the table is voided inside resolveSnap.
  if (action.a === "snapResolve") return resolveSnap(state, out, ctx, action);

  const actor = seatOf(state, actorId);
  if (!actor) return fail("sessionInvalid", "you are not seated at this table");

  switch (action.a) {
    /* ------------------------------------------------- pre-round study */

    case "initialPeek": {
      if (state.phase !== "study") return fail("illegalAction", "the study phase is over");
      if (actor.ready) return fail("illegalAction", "you already finished studying");
      if (actor.initialPeeked.length >= state.rules.initialPeeks) {
        return fail("illegalAction", `you may only study ${state.rules.initialPeeks} cards`);
      }
      const cardId = actor.hand[action.slot];
      if (cardId === undefined) return fail("badSlot", `you have no slot ${action.slot}`);
      // Only the bottom row of the hand is yours to study, so every player
      // starts the round knowing the same two positions.
      if (!isInitialPeekSlot(action.slot, actor.hand.length, state.rules.initialPeeks)) {
        return fail("badSlot", "only your bottom cards may be studied");
      }
      if (actor.initialPeeked.includes(action.slot)) {
        return fail("illegalAction", "you have already studied that card");
      }

      actor.initialPeeked.push(action.slot);
      reveal(state, out, actorId, actorId, action.slot, cardId);
      return { ok: true, state, out };
    }

    case "readyUp": {
      if (state.phase !== "study") return fail("illegalAction", "the study phase is over");
      actor.ready = true;
      if (state.seats.every((s) => s.ready)) {
        state.phase = "awaitingAction";
        state.turnIndex = 0;
        state.turnEndsAt = turnDeadline(state, ctx);
      }
      return { ok: true, state, out };
    }

    /* ----------------------------------------------------- turn start */

    case "drawDeck": {
      const guard = requireTurn(state, actorId, "awaitingAction");
      if (guard) return guard;
      if (!refillDeckIfEmpty(state, ctx)) {
        finishRound(state, out);
        return { ok: true, state, out };
      }
      const cardId = state.deck.pop();
      if (cardId === undefined) return fail("illegalAction", "the deck is empty");

      state.held = { cardId, fromDiscard: false };
      state.phase = "holdingCard";
      // You see what you draw, so you know it from here on.
      learn(state, cardId, actorId);
      announce(out, "draw", actorId);
      return { ok: true, state, out };
    }

    case "drawDiscard": {
      const guard = requireTurn(state, actorId, "awaitingAction");
      if (guard) return guard;
      const cardId = state.discard.pop();
      if (cardId === undefined) return fail("illegalAction", "the discard pile is empty");

      state.held = { cardId, fromDiscard: true };
      state.phase = "holdingCard";
      learn(state, cardId, actorId);
      announce(out, "take", actorId);
      return { ok: true, state, out };
    }

    case "callCambio": {
      const guard = requireTurn(state, actorId, "awaitingAction");
      if (guard) return guard;
      if (state.cambioCallerId !== null) return fail("illegalAction", "Cambio has already been called");

      state.cambioCallerId = actorId;
      actor.calledCambio = true;
      // Everyone else gets exactly one more turn. The count is seat count rather
      // than seat count minus one because ending the calling turn immediately
      // below spends one of them, and the caller does not get a final turn.
      state.finalTurnsRemaining = state.seats.length;
      announce(out, "cambio", actorId);
      endTurn(state, out, ctx);
      return { ok: true, state, out };
    }

    /* -------------------------------------------------- holding a card */

    case "swapWithSlot": {
      const guard = requireTurn(state, actorId, "holdingCard");
      if (guard) return guard;
      const held = state.held;
      if (held === null) return fail("illegalAction", "you are not holding a card");
      const displaced = actor.hand[action.slot];
      if (displaced === undefined) return fail("badSlot", `you have no slot ${action.slot}`);

      actor.hand[action.slot] = held.cardId;
      state.discard.push(displaced);
      // The displaced card is now face up for everyone, so per-player knowledge
      // of it stops being meaningful.
      forgetCard(state, displaced);
      state.held = null;
      announce(out, "replace", actorId, [{ ownerId: actorId, slot: action.slot }]);
      endTurn(state, out, ctx);
      return { ok: true, state, out };
    }

    case "discardDrawn": {
      const guard = requireTurn(state, actorId, "holdingCard");
      if (guard) return guard;
      const held = state.held;
      if (held === null) return fail("illegalAction", "you are not holding a card");
      if (held.fromDiscard) {
        return fail("illegalAction", "a card taken from the discard pile must be swapped into your hand");
      }

      state.discard.push(held.cardId);
      forgetCard(state, held.cardId);
      state.held = null;
      announce(out, "discard", actorId);

      const card = state.cards.get(held.cardId);
      const power = card ? powerFor(card.rank) : null;
      if (power === null) {
        endTurn(state, out, ctx);
        return { ok: true, state, out };
      }

      // Only a card discarded straight from the deck triggers its power.
      state.pendingPower = power;
      state.kingPeeked = false;
      state.phase = phaseForPower(power);
      return { ok: true, state, out };
    }

    /* ------------------------------------------------------- powers */

    case "peekOwn": {
      const guard = requireTurn(state, actorId, "powerPeekOwn");
      if (guard) return guard;
      const cardId = actor.hand[action.slot];
      if (cardId === undefined) return fail("badSlot", `you have no slot ${action.slot}`);

      reveal(state, out, actorId, actorId, action.slot, cardId);
      endTurn(state, out, ctx);
      return { ok: true, state, out };
    }

    case "peekOther": {
      const isKing = state.phase === "powerKing";
      const guard = requireTurn(state, actorId, isKing ? "powerKing" : "powerPeekOther");
      if (guard) return guard;
      if (isKing && state.kingPeeked) return fail("illegalAction", "you have already looked; now swap or pass");

      // A nine or ten must target an opponent; a king may look at any card.
      if (!isKing && action.playerId === actorId) {
        return fail("badTarget", "this power looks at another player's card");
      }
      const target = seatOf(state, action.playerId);
      if (!target) return fail("badTarget", "no such player");
      const cardId = target.hand[action.slot];
      if (cardId === undefined) return fail("badSlot", `${target.name} has no slot ${action.slot}`);

      reveal(state, out, actorId, action.playerId, action.slot, cardId);

      if (isKing) {
        state.kingPeeked = true;
        return { ok: true, state, out };
      }
      endTurn(state, out, ctx);
      return { ok: true, state, out };
    }

    case "freeSwap": {
      // A king swaps on the same terms as a jack or queen, so both phases
      // accept this - the king just has to spend its look first.
      const isKing = state.phase === "powerKing";
      const guard = requireTurn(state, actorId, isKing ? "powerKing" : "powerFreeSwap");
      if (guard) return guard;
      if (isKing && !state.kingPeeked) return fail("illegalAction", "look at a card before swapping");

      // Neither end has to be the actor's: two of yours, two of theirs, or one
      // of each. The only pair that cannot be named is one card twice.
      if (action.aId === action.bId && action.aSlot === action.bSlot) {
        return fail("badTarget", "pick two different cards");
      }
      return applySwap(state, out, ctx, actorId, action.aId, action.aSlot, action.bId, action.bSlot);
    }

    case "forfeitPower": {
      // Powers are optional in Cambio, so declining one is a legal move rather
      // than a forced default. It is also what the turn clock plays on timeout.
      if (state.pendingPower === null) return fail("illegalAction", "you have no power to decline");
      if (turnSeat(state)?.id !== actorId) return fail("notYourTurn", "it is not your turn");
      endTurn(state, out, ctx);
      return { ok: true, state, out };
    }

    case "kingSkip": {
      const guard = requireTurn(state, actorId, "powerKing");
      if (guard) return guard;
      if (!state.kingPeeked) return fail("illegalAction", "look at a card before passing");
      endTurn(state, out, ctx);
      return { ok: true, state, out };
    }

    /* --------------------------------------------------------- snapping */

    case "snap": {
      // Snaps never reach the reducer directly: the arbiter races them first and
      // feeds back a single `snapResolve`.
      return fail("illegalAction", "snaps are resolved by the arbiter");
    }

    case "snapGive": {
      if (state.phase !== "snapGiveCard" || state.snapGiveFor === null) {
        return fail("illegalAction", "you do not owe anyone a card");
      }
      if (state.snapGiveFor.snapperId !== actorId) {
        return fail("illegalAction", "you are not the player who owes a card");
      }
      const target = seatOf(state, state.snapGiveFor.targetId);
      if (!target) return fail("badTarget", "no such player");
      const cardId = actor.hand[action.slot];
      if (cardId === undefined) return fail("badSlot", `you have no slot ${action.slot}`);

      actor.hand.splice(action.slot, 1);
      target.hand.push(cardId);
      // The card's new home is what everyone needs to see; the slot it left
      // no longer exists, since the rest of the hand has closed up behind it.
      announce(out, "give", actorId, [{ ownerId: target.id, slot: target.hand.length - 1 }]);
      state.snapGiveFor = null;
      // The snap interrupted a turn in progress; put the table back where it was.
      state.phase = phaseAfterSnapGive(state);

      if (actor.hand.length === 0) finishRound(state, out);
      return { ok: true, state, out };
    }

    default: {
      const never: never = action;
      return fail("malformed", `unknown action: ${JSON.stringify(never)}`);
    }
  }
}

/* --------------------------------------------------------------- helpers */

function requireTurn(state: GameState, actorId: PlayerId, phase: Phase): ReduceResult | null {
  if (state.phase !== phase) {
    return fail("illegalAction", `you cannot do that while the table is "${state.phase}"`);
  }
  if (turnSeat(state)?.id !== actorId) return fail("notYourTurn", "it is not your turn");
  return null;
}

/**
 * Tell the whole table what just happened, in the terms it would have seen
 * across a real one: the gesture, who made it, and which cards it touched.
 * Never a face - those still go only to whoever is entitled to them.
 */
function announce(out: Outbound[], kind: TableEventKind, byId: PlayerId, slots: SlotRef[] = []): void {
  out.push({ to: "all", event: { t: "table.event", kind, byId, slots } });
}

function reveal(
  state: GameState,
  out: Outbound[],
  viewerId: PlayerId,
  ownerId: PlayerId,
  slot: number,
  cardId: CardId,
): void {
  learn(state, cardId, viewerId);
  const card = state.cards.get(cardId);
  if (card) {
    out.push({
      to: viewerId,
      event: { t: "card.revealed", ownerId, slot, card, ttlMs: state.rules.peekMs },
    });
  }
  // Which card was looked at is public even though its face is not - the
  // table watches you pick one up. What you saw stays yours to remember, and
  // `PlayerView.peeked` still keeps your study choices to yourself.
  announce(out, "peek", viewerId, [{ ownerId, slot }]);
}

/**
 * Exchange two cards anywhere on the table. Every swapping power allows any
 * pair, so this only has to find both ends and move them.
 */
function applySwap(
  state: GameState,
  out: Outbound[],
  ctx: ReduceCtx,
  actorId: PlayerId,
  aId: PlayerId,
  aSlot: number,
  bId: PlayerId,
  bSlot: number,
): ReduceResult {
  const a = seatOf(state, aId);
  const b = seatOf(state, bId);
  if (!a || !b) return fail("badTarget", "no such player");

  const aCard = a.hand[aSlot];
  const bCard = b.hand[bSlot];
  if (aCard === undefined) return fail("badSlot", `${a.name} has no slot ${aSlot}`);
  if (bCard === undefined) return fail("badSlot", `${b.name} has no slot ${bSlot}`);

  // Knowledge is keyed on the card, so whoever knew these cards still knows
  // them in their new homes without any bookkeeping here.
  a.hand[aSlot] = bCard;
  b.hand[bSlot] = aCard;

  announce(out, "swap", actorId, [
    { ownerId: aId, slot: aSlot },
    { ownerId: bId, slot: bSlot },
  ]);
  endTurn(state, out, ctx);
  return { ok: true, state, out };
}

function resolveSnap(
  state: GameState,
  out: Outbound[],
  ctx: ReduceCtx,
  action: Extract<EngineAction, { a: "snapResolve" }>,
): ReduceResult {
  const { winnerId, targetId, slot, marginMs } = action;

  const voided = (): ReduceResult => {
    out.push({
      to: "all",
      event: { t: "snap.resolved", winnerId, targetId, slot, outcome: "noLongerValid", marginMs },
    });
    return { ok: true, state, out };
  };

  if (winnerId === null) return voided();

  const winner = seatOf(state, winnerId);
  const target = seatOf(state, targetId);
  const top = discardTopCard(state);
  const cardId = target?.hand[slot];
  const card = cardId === undefined ? undefined : state.cards.get(cardId);

  if (!winner || !target || !top || cardId === undefined || card === undefined) return voided();

  if (card.rank !== top.rank) {
    // A wrong snap costs you a card off the deck, face down - you do not even
    // get to see what you were given.
    if (refillDeckIfEmpty(state, ctx)) {
      const penalty = state.deck.pop();
      if (penalty !== undefined) {
        winner.hand.push(penalty);
        announce(out, "penalty", winnerId, [{ ownerId: winnerId, slot: winner.hand.length - 1 }]);
      }
    }
    out.push({
      to: "all",
      event: { t: "snap.resolved", winnerId, targetId, slot, outcome: "wrongRankPenalty", marginMs },
    });
    return { ok: true, state, out };
  }

  target.hand.splice(slot, 1);
  state.discard.push(cardId);
  forgetCard(state, cardId);

  if (targetId === winnerId) {
    out.push({
      to: "all",
      event: { t: "snap.resolved", winnerId, targetId, slot, outcome: "ownCardDiscarded", marginMs },
    });
    // Emptying your hand ends the round on the spot - nothing beats zero cards.
    if (winner.hand.length === 0) finishRound(state, out);
    return { ok: true, state, out };
  }

  // Snapping someone else's card means handing one of yours over in its place.
  state.snapGiveFor = { snapperId: winnerId, targetId };
  state.phase = "snapGiveCard";
  out.push({
    to: "all",
    event: { t: "snap.resolved", winnerId, targetId, slot, outcome: "otherCardDiscarded", marginMs },
  });
  return { ok: true, state, out };
}

/** The phase a power waits in while the player resolves it. */
function phaseForPower(power: Power): Phase {
  switch (power) {
    case "peekOwn":
      return "powerPeekOwn";
    case "peekOther":
      return "powerPeekOther";
    case "freeSwap":
      return "powerFreeSwap";
    case "king":
      return "powerKing";
  }
}

/** Where the table returns to once a snapper has paid their card. */
function phaseAfterSnapGive(state: GameState): Phase {
  if (state.held !== null) return "holdingCard";
  return state.pendingPower === null ? "awaitingAction" : phaseForPower(state.pendingPower);
}

function turnDeadline(state: GameState, ctx: ReduceCtx): number | null {
  return state.rules.turnMs > 0 ? ctx.now + state.rules.turnMs : null;
}

/**
 * Bring the deck back from the discard pile, keeping the top card face up so a
 * snap target always exists. Returns false when there is nothing left to draw.
 */
function refillDeckIfEmpty(state: GameState, ctx: ReduceCtx): boolean {
  if (state.deck.length > 0) return true;
  if (state.discard.length <= 1) return false;

  const top = state.discard[state.discard.length - 1];
  const rest = state.discard.slice(0, -1);
  state.deck = shuffle(rest, ctx.rng);
  state.discard = top === undefined ? [] : [top];
  for (const id of state.deck) forgetCard(state, id);
  return state.deck.length > 0;
}

function endTurn(state: GameState, out: Outbound[], ctx: ReduceCtx): void {
  state.held = null;
  state.pendingPower = null;
  state.kingPeeked = false;

  if (state.finalTurnsRemaining !== null) {
    state.finalTurnsRemaining -= 1;
    if (state.finalTurnsRemaining <= 0) {
      finishRound(state, out);
      return;
    }
  }

  state.turnIndex = nextSeatIndex(state);
  state.phase = "awaitingAction";
  state.turnEndsAt = turnDeadline(state, ctx);
}

/** Skip players who have dropped, so a disconnect cannot stall the table. */
function nextSeatIndex(state: GameState): number {
  const count = state.seats.length;
  for (let step = 1; step <= count; step++) {
    const index = (state.turnIndex + step) % count;
    if (state.seats[index]?.connected === true) return index;
  }
  return state.turnIndex;
}

function finishRound(state: GameState, out: Outbound[]): void {
  state.phase = "finished";
  state.held = null;
  state.pendingPower = null;
  state.kingPeeked = false;
  state.snapGiveFor = null;
  state.turnEndsAt = null;

  const result = settle(state);
  state.scores = result.scores;
  state.winnerId = result.winnerId;

  out.push({
    to: "all",
    event: {
      t: "game.over",
      winnerId: result.winnerId,
      scores: [...result.scores.entries()].map(([playerId, score]) => ({ playerId, score })),
    },
  });
}
