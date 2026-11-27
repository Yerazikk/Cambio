import {
  isInitialPeekSlot,
  powerFor,
  type Card,
  type CardId,
  type EngineAction,
  type ErrorCode,
  type Phase,
  type PlayerId,
  type Power,
  type ServerEvent,
  type SlapOutcome,
  type SlotRef,
  type TableEventKind,
} from "@cambio/shared";
import { shuffle } from "../deck.js";
import type { Rng } from "../rng.js";
import { settle } from "./score.js";
import {
  discardTopCard,
  forgetCard,
  handIsEmpty,
  isLocked,
  learn,
  seatOf,
  turnSeat,
  type GameState,
  type Seat,
} from "./state.js";

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

  // The arbiter speaks for the system rather than for a player, and names the
  // slapper in the payload, so this is settled before any actor check. A
  // slapper who has since left the table is voided inside resolveSlap.
  if (action.a === "slapResolve") return resolveSlap(state, out, ctx, action);
  if (action.a === "slapForfeit") return forfeitSlap(state, out, ctx, action);
  /*
   * Only the turn clock sends this, and it is the one thing that may walk away
   * from a power the rules say is compulsory. A seat nobody is sitting in
   * would otherwise hold the table for the rest of the round.
   */
  if (action.a === "powerTimeout") {
    if (state.pendingPower === null) return fail("illegalAction", "there is no power to time out");
    endTurn(state, out, ctx);
    return { ok: true, state, out };
  }

  const actor = seatOf(state, actorId);
  if (!actor) return fail("sessionInvalid", "you are not seated at this table");

  /*
   * A slap stops the table. Nothing but another slap is legal until the queue
   * has emptied, which is what makes "the game pauses while you pick" a rule
   * rather than a hint - the slapper is not racing the turn they interrupted.
   */
  if (isLocked(state) && !SLAP_ACTIONS.has(action.a)) {
    return fail("illegalAction", "the table is stopped while a slap is settled");
  }

  switch (action.a) {
    /* ------------------------------------------------- pre-round study */

    case "initialPeek": {
      if (state.phase !== "study") return fail("illegalAction", "the study phase is over");
      if (actor.ready) return fail("illegalAction", "you already finished studying");
      if (actor.initialPeeked.length >= state.rules.initialPeeks) {
        return fail("illegalAction", `you may only study ${state.rules.initialPeeks} cards`);
      }
      const cardId = heldInSlot(actor, action.slot);
      if (cardId === null) return fail("badSlot", `you have no card in slot ${action.slot}`);
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
      /*
       * You cannot call yourself ready without having looked. The two cards
       * you start the round knowing are not an optional extra, they are the
       * hand you play from - so a player who hit Ready before finding out
       * what they held had thrown the round away before the first turn.
       */
      if (actor.initialPeeked.length < state.rules.initialPeeks) {
        return fail("illegalAction", `look at your ${state.rules.initialPeeks} bottom cards first`);
      }
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
      extendTurn(state, ctx);
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
      extendTurn(state, ctx);
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
      const displaced = heldInSlot(actor, action.slot);
      if (displaced === null) return fail("badSlot", `you have no card in slot ${action.slot}`);

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
      state.kingPicks = [];
      state.phase = phaseForPower(power);
      // A power is a second decision, so it gets its own time to make it in.
      extendTurn(state, ctx);
      return { ok: true, state, out };
    }

    /* ------------------------------------------------------- powers */

    case "peekOwn": {
      const guard = requireTurn(state, actorId, "powerPeekOwn");
      if (guard) return guard;
      const cardId = heldInSlot(actor, action.slot);
      if (cardId === null) return fail("badSlot", `you have no card in slot ${action.slot}`);

      reveal(state, out, actorId, actorId, action.slot, cardId);
      endTurn(state, out, ctx);
      return { ok: true, state, out };
    }

    case "peekOther": {
      const guard = requireTurn(state, actorId, "powerPeekOther");
      if (guard) return guard;

      // A nine or ten must target an opponent.
      if (action.playerId === actorId) {
        return fail("badTarget", "this power looks at another player's card");
      }
      const target = seatOf(state, action.playerId);
      if (!target) return fail("badTarget", "no such player");
      const cardId = heldInSlot(target, action.slot);
      if (cardId === null) return fail("badSlot", `${target.name} has no card in slot ${action.slot}`);

      reveal(state, out, actorId, action.playerId, action.slot, cardId);
      endTurn(state, out, ctx);
      return { ok: true, state, out };
    }

    /* ---------------------------------------------------------------- king */

    /*
     * A king names two cards, is shown both at once, and only then decides
     * whether to trade them.
     *
     * Looking at one and having to commit before seeing the other was never
     * the bargain: the whole value of a king is that it gets to compare, and
     * comparing means both faces up at the same moment.
     */
    case "kingPick": {
      const guard = requireTurn(state, actorId, "powerKing");
      if (guard) return guard;
      if (state.kingPicks.length >= 2) return fail("illegalAction", "you have already named two cards");

      const target = seatOf(state, action.playerId);
      if (!target) return fail("badTarget", "no such player");
      const cardId = heldInSlot(target, action.slot);
      if (cardId === null) return fail("badSlot", `${target.name} has no card in slot ${action.slot}`);
      if (state.kingPicks.some((p) => p.ownerId === action.playerId && p.slot === action.slot)) {
        return fail("badTarget", "pick two different cards");
      }

      state.kingPicks.push({ ownerId: action.playerId, slot: action.slot });
      // Naming a card is public, the way any card being touched is. Nothing
      // is shown until both are named: the two faces go up together, or the
      // comparison the king is for does not happen.
      announce(out, "peek", actorId, [{ ownerId: action.playerId, slot: action.slot }]);

      if (state.kingPicks.length < 2) {
        extendTurn(state, ctx);
        return { ok: true, state, out };
      }

      for (const pick of state.kingPicks) {
        const seat = seatOf(state, pick.ownerId);
        const id = seat === undefined ? null : heldInSlot(seat, pick.slot);
        if (id !== null) reveal(state, out, actorId, pick.ownerId, pick.slot, id, false);
      }
      state.phase = "powerKingChoice";
      extendTurn(state, ctx);
      return { ok: true, state, out };
    }

    case "kingSwap": {
      const guard = requireTurn(state, actorId, "powerKingChoice");
      if (guard) return guard;
      const [a, b] = state.kingPicks;
      if (a === undefined || b === undefined) return fail("illegalAction", "name two cards first");
      return applySwap(state, out, ctx, actorId, a.ownerId, a.slot, b.ownerId, b.slot);
    }

    case "freeSwap": {
      // Jacks and queens only. A king swaps the two cards it looked at, which
      // it already knows, so it has its own move rather than naming them again.
      const guard = requireTurn(state, actorId, "powerFreeSwap");
      if (guard) return guard;

      // Neither end has to be the actor's: two of yours, two of theirs, or one
      // of each. The only pair that cannot be named is one card twice.
      if (action.aId === action.bId && action.aSlot === action.bSlot) {
        return fail("badTarget", "pick two different cards");
      }
      return applySwap(state, out, ctx, actorId, action.aId, action.aSlot, action.bId, action.bSlot);
    }

    case "forfeitPower": {
      /*
       * A power you triggered is a power you use. Discarding a seven from the
       * deck is a decision with a consequence, and being able to shrug it off
       * would take the consequence away - so declining is only a move at a
       * table whose host has chosen to allow it.
       */
      if (!state.rules.optionalPowers) {
        return fail("illegalAction", "this table plays powers out - you have to use it");
      }
      if (state.pendingPower === null) return fail("illegalAction", "you have no power to decline");
      if (turnSeat(state)?.id !== actorId) return fail("notYourTurn", "it is not your turn");
      endTurn(state, out, ctx);
      return { ok: true, state, out };
    }

    case "kingSkip": {
      const guard = requireTurn(state, actorId, "powerKingChoice");
      if (guard) return guard;
      /*
       * Keeping both cards is not declining the king's power - it is the
       * power. A king buys you a look at two cards and the right to decide
       * about them, and deciding to leave them is one of the two answers, so
       * it is legal at every table whatever the host set Powers to.
       */
      endTurn(state, out, ctx);
      return { ok: true, state, out };
    }

    /* --------------------------------------------------------- slapping */

    case "slap":
    case "slapClaim": {
      // Slaps never reach the reducer directly: the arbiter orders them into a
      // queue and feeds back a `slapResolve` for each one the queue reaches.
      return fail("illegalAction", "slaps are resolved by the arbiter");
    }

    case "slapGive": {
      if (state.phase !== "slapGiveCard" || state.slapGiveFor === null) {
        return fail("illegalAction", "you do not owe anyone a card");
      }
      if (state.slapGiveFor.slapperId !== actorId) {
        return fail("illegalAction", "you are not the player who owes a card");
      }
      const target = seatOf(state, state.slapGiveFor.targetId);
      if (!target) return fail("badTarget", "no such player");
      const cardId = heldInSlot(actor, action.slot);
      if (cardId === null) return fail("badSlot", `you have no card in slot ${action.slot}`);

      /*
       * The card goes into the hole the slap just made, rather than onto the
       * end of the hand. That is the place it is owed for, and it keeps every
       * other card in that hand where its owner last saw it.
       */
      const into = state.slapGiveFor.slot;
      actor.hand[action.slot] = null;
      target.hand[into] = cardId;
      // Both ends are worth watching: the hole one card left, and the hole
      // the other one filled.
      announce(out, "give", actorId, [
        { ownerId: actorId, slot: action.slot },
        { ownerId: target.id, slot: into },
      ]);
      state.slapGiveFor = null;
      // The slap interrupted a turn in progress; put the table back where it was.
      state.phase = phaseAfterSlapGive(state);

      if (handIsEmpty(actor)) finishRound(state, out);
      return { ok: true, state, out };
    }

    default: {
      const never: never = action;
      return fail("malformed", `unknown action: ${JSON.stringify(never)}`);
    }
  }
}

/* --------------------------------------------------------------- helpers */

/** The only moves a stopped table still accepts. */
const SLAP_ACTIONS: ReadonlySet<string> = new Set(["slap", "slapClaim", "slapGive"]);

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

/**
 * Show one card to one player.
 *
 * `tell` is what the rest of the table is told. It is normally on - which card
 * you looked at is public even though its face is not, because everyone
 * watches you pick one up - and off only where the gesture has already been
 * announced, as it has for each of a king's two picks.
 */
function reveal(
  state: GameState,
  out: Outbound[],
  viewerId: PlayerId,
  ownerId: PlayerId,
  slot: number,
  cardId: CardId,
  tell = true,
): void {
  learn(state, cardId, viewerId);
  const card = state.cards.get(cardId);
  if (card) {
    out.push({
      to: viewerId,
      event: { t: "card.revealed", ownerId, slot, card, ttlMs: state.rules.peekMs },
    });
  }
  // What you saw stays yours to remember, and `PlayerView.peeked` still keeps
  // your study choices to yourself.
  if (tell) announce(out, "peek", viewerId, [{ ownerId, slot }]);
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

  const aCard = heldInSlot(a, aSlot);
  const bCard = heldInSlot(b, bSlot);
  if (aCard === null) return fail("badSlot", `${a.name} has no card in slot ${aSlot}`);
  if (bCard === null) return fail("badSlot", `${b.name} has no card in slot ${bSlot}`);

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

/**
 * Play out one slap.
 *
 * The arbiter feeds these in queue order and stops at the first that lands, so
 * this only ever sees a slap it is genuinely that player's turn to make.
 */
function resolveSlap(
  state: GameState,
  out: Outbound[],
  ctx: ReduceCtx,
  action: Extract<EngineAction, { a: "slapResolve" }>,
): ReduceResult {
  const { slapperId, targetId, slot, marginMs } = action;
  /*
   * `card` goes to the whole table, not just the slapper. The card was turned
   * face up in front of everyone and put on the pile, so there is nothing left
   * to hide about it - and watching someone else's slap land is most of the
   * fun of not having made it yourself.
   */
  const resolved = (outcome: SlapOutcome, card: Card | null = null): Outbound => ({
    to: "all",
    event: { t: "slap.resolved", slapperId, targetId, slot, outcome, card, endedById: null, marginMs },
  });

  const slapper = seatOf(state, slapperId);
  const target = seatOf(state, targetId);
  const top = discardTopCard(state);
  const cardId = target === undefined ? null : heldInSlot(target, slot);
  const card = cardId === null ? undefined : state.cards.get(cardId);

  if (!slapper || !target || !top || cardId === null || card === undefined) {
    out.push(resolved("noLongerValid"));
    return { ok: true, state, out };
  }

  if (card.rank !== top.rank) {
    // A wrong slap costs you a card off the deck, face down - you do not even
    // get to see what you were given - and hands the slap on to whoever is
    // next in the queue.
    dealPenalty(state, out, ctx, slapper);
    out.push(resolved("wrongRankPenalty"));
    return { ok: true, state, out };
  }

  // The card leaves a hole rather than closing the hand up behind it.
  target.hand[slot] = null;
  state.discard.push(cardId);
  forgetCard(state, cardId);

  if (targetId === slapperId) {
    out.push(resolved("ownCardDiscarded", card));
    // Emptying your hand ends the round on the spot - nothing beats zero cards.
    if (handIsEmpty(slapper)) finishRound(state, out);
    return { ok: true, state, out };
  }

  // Slapping someone else's card means handing one of yours over in its place,
  // and it goes into the hole this slap just made.
  state.slapGiveFor = { slapperId, targetId, slot };
  state.phase = "slapGiveCard";
  out.push(resolved("otherCardDiscarded", card));
  return { ok: true, state, out };
}

/**
 * The holder of the lock ran out of time without naming a card.
 *
 * It costs exactly what a wrong slap costs. Stopping the table is the slap's
 * privilege; keeping it stopped for nothing is not.
 */
function forfeitSlap(
  state: GameState,
  out: Outbound[],
  ctx: ReduceCtx,
  action: Extract<EngineAction, { a: "slapForfeit" }>,
): ReduceResult {
  const { slapperId } = action;
  const slapper = seatOf(state, slapperId);
  if (!slapper) {
    out.push({
      to: "all",
      event: {
        t: "slap.resolved",
        slapperId,
        targetId: slapperId,
        slot: 0,
        outcome: "noLongerValid",
        card: null,
        endedById: null,
        marginMs: null,
      },
    });
    return { ok: true, state, out };
  }

  dealPenalty(state, out, ctx, slapper);
  out.push({
    to: "all",
    event: {
      t: "slap.resolved",
      slapperId,
      targetId: slapperId,
      slot: 0,
      outcome: "noPickPenalty",
      card: null,
      endedById: null,
      marginMs: null,
    },
  });
  return { ok: true, state, out };
}

/** Whether a settled slap was right, and so ends the queue behind it. */
export function slapLanded(outcome: SlapOutcome): boolean {
  return outcome === "ownCardDiscarded" || outcome === "otherCardDiscarded";
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

/** The card in a slot, or null for a hole or for no such slot at all. */
function heldInSlot(seat: Seat, slot: number): CardId | null {
  return seat.hand[slot] ?? null;
}

/**
 * Deal a card off the deck as a penalty, face down. It goes on the end of the
 * hand rather than into a hole: a penalty is a card you have been given, not
 * one you have got back, and the holes stay where they are.
 */
function dealPenalty(state: GameState, out: Outbound[], ctx: ReduceCtx, seat: Seat): void {
  if (!refillDeckIfEmpty(state, ctx)) return;
  const penalty = state.deck.pop();
  if (penalty === undefined) return;
  seat.hand.push(penalty);
  announce(out, "penalty", seat.id, [{ ownerId: seat.id, slot: seat.hand.length - 1 }]);
}

/**
 * Put more time on the current turn's clock.
 *
 * Called for each step of a turn that does not end it. The clock exists to
 * move along a seat nobody is sitting in, and somebody who has just drawn a
 * card and is deciding what to do with it is plainly not that seat - so the
 * decision they are in the middle of gets its own budget rather than eating
 * the one the turn started with.
 */
function extendTurn(state: GameState, ctx: ReduceCtx): void {
  if (state.turnEndsAt === null || state.rules.turnBonusMs <= 0) return;
  /*
   * Added to what is left, not set as a floor under it. A player who has
   * spent forty of their forty-five seconds deciding and then draws has
   * earned the fifteen as much as one who answered at once - more, if
   * anything - and a floor would quietly give them nothing.
   *
   * It cannot run away: a turn is at most a draw, what to do with it, and a
   * power, so there are only ever a few of these in a row.
   */
  state.turnEndsAt = Math.max(state.turnEndsAt, ctx.now) + state.rules.turnBonusMs;
}

/** Where the table returns to once a slapper has paid their card. */
function phaseAfterSlapGive(state: GameState): Phase {
  if (state.held !== null) return "holdingCard";
  if (state.pendingPower === null) return "awaitingAction";
  // A king that had already named both cards goes back to its choice, not to
  // the start of its picking.
  if (state.pendingPower === "king" && state.kingPicks.length >= 2) return "powerKingChoice";
  return phaseForPower(state.pendingPower);
}

function turnDeadline(state: GameState, ctx: ReduceCtx): number | null {
  return state.rules.turnMs > 0 ? ctx.now + state.rules.turnMs : null;
}

/**
 * Bring the deck back from the discard pile, keeping the top card face up so a
 * slap target always exists. Returns false when there is nothing left to draw.
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
  state.kingPicks = [];

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
  state.kingPicks = [];
  state.slapGiveFor = null;
  state.slapLock = null;
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
