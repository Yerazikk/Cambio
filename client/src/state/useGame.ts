import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  Action,
  Card,
  ClientMsg,
  ErrorCode,
  GameView,
  Phase,
  PlayerId,
  ServerEvent,
  SlotRef,
  TableEventKind,
} from "@cambio/shared";
import type { Flash } from "../components/Card.js";
import type { Flight } from "../components/Flights.js";
import { clearToken, connect, readToken, type ConnectionStatus, type Connection } from "../net/socket.js";

/** A card currently face up on this player's screen, and when it flips back. */
export type Reveal = { ownerId: PlayerId; slot: number; card: Card; expiresAt: number };

export type Toast = { id: number; kind: "info" | "good" | "bad"; text: string };

/** A card mid-gesture: flipped, swapped, slapped. Everyone sees the same one. */
export type SlotFlash = { ownerId: PlayerId; slot: number; kind: Flash; expiresAt: number };

/** Which pile just moved, so it can pulse along with the hands. */
export type PileFlash = { pile: "deck" | "discard"; expiresAt: number };

/** One line of the table's running account of itself. */
export type LogLine = { id: number; text: string };

/**
 * Two-step powers need somewhere to hold the first click. A queen's first click
 * can land on anyone's card, so the owner is part of the pick rather than
 * assumed to be you.
 */
export type PickOne = { ownerId: PlayerId; slot: number } | null;

export type GameStore = {
  status: ConnectionStatus;
  view: GameView | null;
  me: PlayerId | null;
  kicked: string | null;
  toasts: Toast[];
  reveals: Reveal[];
  /** The last few moves, in the words everyone at the table would use. */
  log: LogLine[];
  /** Set for as long as a fresh hand is being dealt out to the seats. */
  dealing: boolean;
  /** Cards currently crossing the table, so a move can be watched happening. */
  flights: Flight[];
  /** Drop a flight that has landed. */
  landed: (id: number) => void;
  /**
   * Set between pressing SLAP and the server confirming the table has stopped
   * on you. Local, and optimistic: once the lock arrives in the view, that is
   * the authority on who is picking.
   */
  slapArmed: boolean;
  /** Set the instant a slap is sent, for feedback that does not wait for the server. */
  slapPending: boolean;
  /** True while the table is still flashing red from a slap that landed. */
  slapPulse: boolean;
  pick: PickOne;

  createRoom: (name: string) => void;
  joinRoom: (code: string, name: string) => void;
  leave: () => void;
  kick: (playerId: PlayerId) => void;
  setDecks: (decks: number) => void;
  setBack: (back: string) => void;
  /** Host only, lobby only: whether a triggered power may be declined. */
  setPowers: (optional: boolean) => void;
  start: () => void;
  restart: () => void;
  act: (action: Action) => void;
  /** Say something in passing, in the same place every other notice appears. */
  notify: (text: string) => void;

  /** Press SLAP: claims a place in the queue and stops the table. */
  claimSlap: () => void;
  slap: (targetId: PlayerId, slot: number) => void;
  setPick: (pick: PickOne) => void;
  dismissKick: () => void;
  revealFor: (ownerId: PlayerId, slot: number) => Card | null;
  /** The gesture a given card is in the middle of, for everyone watching. */
  flashFor: (ownerId: PlayerId, slot: number) => Flash | null;
  pileFlash: (pile: "deck" | "discard") => boolean;
};

const TOAST_MS = 3_500;
/**
 * How long a move stays visible as an animation.
 *
 * Generous, on purpose. This is the only way anyone finds out what another
 * player just did: the game is face down, so a card lighting up for a moment
 * is the entire report. A flash short enough to miss while you were looking
 * at your own hand may as well not have happened.
 */
const FLASH_MS = 2_600;
/**
 * How long a slapped card stays face up for the whole table.
 *
 * It went onto the pile in front of everyone, so there is nothing left to
 * hide - and a slap is the one moment in the game worth watching land.
 */
const SLAP_REVEAL_MS = 2_600;
/** How many past moves the table log keeps on screen. */
const LOG_LINES = 5;
/**
 * How long the deal takes to reach every seat. Long enough to cover the last
 * card of a six-handed table, which goes out last.
 */
const DEAL_MS = 1_400;

export function useGame(): GameStore {
  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  const [view, setView] = useState<GameView | null>(null);
  const [me, setMe] = useState<PlayerId | null>(null);
  const [kicked, setKicked] = useState<string | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [reveals, setReveals] = useState<Reveal[]>([]);
  const [flashes, setFlashes] = useState<SlotFlash[]>([]);
  const [piles, setPiles] = useState<PileFlash[]>([]);
  const [log, setLog] = useState<LogLine[]>([]);
  const [dealing, setDealing] = useState(false);
  const [flights, setFlights] = useState<Flight[]>([]);
  const [slapArmed, setSlapArmed] = useState(false);
  const [slapPending, setSlapPending] = useState(false);
  /** When the red the table flashes on a landed slap finishes fading. */
  const [slapPulse, setSlapPulse] = useState(0);
  const [pick, setPick] = useState<PickOne>(null);

  const connection = useRef<Connection | null>(null);
  const toastId = useRef(0);
  const flightId = useRef(0);
  const logId = useRef(0);
  /** The phase we last saw, so a fresh deal can be told from a normal update. */
  const phaseRef = useRef<Phase | null>(null);
  const namesRef = useRef<Map<PlayerId, string>>(new Map());
  /**
   * Our own id, in a ref as well as state.
   *
   * The socket is opened once, so the event handler it is given is captured
   * once too. Reading `me` from state inside that handler would read the value
   * from first render - null - forever, which is how "You slapped" came out as
   * the player's own name.
   */
  const meRef = useRef<PlayerId | null>(null);

  const pushToast = useCallback((kind: Toast["kind"], text: string) => {
    const id = ++toastId.current;
    setToasts((current) => [...current, { id, kind, text }]);
    setTimeout(() => setToasts((current) => current.filter((t) => t.id !== id)), TOAST_MS);
  }, []);

  /** Start the animation for a move, on every card it touched. */
  const markFlash = useCallback((kind: Flash, slots: readonly SlotRef[]) => {
    if (slots.length === 0) return;
    const expiresAt = Date.now() + FLASH_MS;
    setFlashes((current) => [
      // A card can only be doing one thing at a time; the newest move wins.
      ...current.filter((f) => !slots.some((s) => s.ownerId === f.ownerId && s.slot === f.slot)),
      ...slots.map((s) => ({ ownerId: s.ownerId, slot: s.slot, kind, expiresAt })),
    ]);
  }, []);

  const markPile = useCallback((pile: PileFlash["pile"]) => {
    const expiresAt = Date.now() + FLASH_MS;
    setPiles((current) => [...current.filter((p) => p.pile !== pile), { pile, expiresAt }]);
  }, []);

  /**
   * Hold a card's trip until the table it crosses has caught up.
   *
   * A move arrives as two messages - what happened, and then the new state -
   * and they are separate socket events, so they are separate renders. A
   * flight drawn on the first of them measures a table that has not moved
   * yet and reads a discard pile whose top card is still the old one, which
   * is how a card on its way to the pile came out printed as the card
   * already lying on it.
   *
   * So trips are queued here and let go in `flush`, on the state that
   * follows. Every path on the server broadcasts state after its events, so
   * one always does - and `flush` is called on a timer as well, in case a
   * day comes when one does not.
   */
  const pending = useRef<Omit<Flight, "id">[]>([]);

  const flush = useCallback(() => {
    const trips = pending.current;
    if (trips.length === 0) return;
    pending.current = [];
    setFlights((current) => [...current, ...trips.map((trip) => ({ ...trip, id: ++flightId.current }))]);
  }, []);

  const fly = useCallback(
    (trips: Omit<Flight, "id">[]) => {
      if (trips.length === 0) return;
      // A table with motion turned off gets none of this. The rings still say
      // what happened; they just say it without anything moving.
      if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
      pending.current.push(...trips);
      setTimeout(flush, 120);
    },
    [flush],
  );

  const landed = useCallback((id: number) => {
    setFlights((current) => current.filter((f) => f.id !== id));
  }, []);

  const pushLog = useCallback((text: string) => {
    const id = ++logId.current;
    setLog((current) => [...current, { id, text }].slice(-LOG_LINES));
  }, []);

  const onEvent = useCallback(
    (event: ServerEvent) => {
      switch (event.t) {
        case "hello": {
          meRef.current = event.playerId;
          setMe(event.playerId);
          setKicked(null);
          return;
        }

        case "game.state": {
          // A fresh deal wipes the slate: last round's peeks, animations and
          // log lines describe cards that are no longer on the table.
          if (phaseRef.current !== "study" && event.view.phase === "study") {
            setReveals([]);
            setFlashes([]);
            setPiles([]);
            setFlights([]);
            pending.current = [];
            setLog([]);
            // A new hand is on its way out to the seats.
            setDealing(true);
          }
          phaseRef.current = event.view.phase;

          setView((previous) => {
            // A view that arrives out of order would rewind the table.
            if (previous !== null && event.view.version < previous.version) return previous;
            return event.view;
          });
          // The table has moved, so whatever was waiting to cross it can go.
          flush();
          for (const player of event.view.players) namesRef.current.set(player.id, player.name);
          return;
        }

        case "card.revealed": {
          // Peeks are transient by design: this is the only time the server
          // sends this face, so remembering it is the player's job.
          setReveals((current) => [
            ...current.filter((r) => !(r.ownerId === event.ownerId && r.slot === event.slot)),
            { ownerId: event.ownerId, slot: event.slot, card: event.card, expiresAt: Date.now() + event.ttlMs },
          ]);
          return;
        }

        case "table.event": {
          // Everything the table would have watched happen, replayed on every
          // screen at once: the card that was flipped, the two that changed
          // places, the pile that moved.
          const flash = FLASH_FOR[event.kind];
          if (flash !== null) markFlash(flash, event.slots);
          const pile = PILE_FOR[event.kind];
          if (pile !== null) markPile(pile);
          fly(tripsFor(event.kind, event.byId, event.slots));
          pushLog(describeTableEvent(event.kind, event.byId, event.slots, namesRef.current, meRef.current));
          return;
        }

        case "slap.resolved": {
          // A contested race arrives as several of these, one per slap the
          // queue reached. Only the one about my own slap settles my pending
          // flash; the rest are other people's slaps, to watch and be told of.
          if (event.slapperId === meRef.current) {
            setSlapPending(false);
            setSlapArmed(false);
          }
          if (event.outcome !== "noLongerValid" && event.outcome !== "lostRace") {
            markFlash("slap", [{ ownerId: event.targetId, slot: event.slot }]);
            if (event.outcome !== "wrongRankPenalty") markPile("discard");
          }
          /*
           * A slap that landed turns its card face up for everybody, in the
           * place it was slapped out of, before the hole it left settles.
           * The server sends the face to the whole table for exactly this:
           * the card is on the discard pile now, so it is nobody's secret,
           * and watching it turn over is the point of someone else slapping.
           */
          if (event.card !== null) {
            const card = event.card;
            // And it crosses the table to the pile it is now on top of.
            fly([
              {
                from: [`slot:${event.targetId}:${event.slot}`, `seat:${event.targetId}`],
                to: ["discard"],
                face: card,
              },
            ]);
            setReveals((current) => [
              ...current.filter((r) => !(r.ownerId === event.targetId && r.slot === event.slot)),
              { ownerId: event.targetId, slot: event.slot, card, expiresAt: Date.now() + SLAP_REVEAL_MS },
            ]);
            setSlapPulse(Date.now() + SLAP_REVEAL_MS);
          }
          pushToast(...describeSlap(event, namesRef.current, meRef.current));
          return;
        }

        case "game.over": {
          const winner = namesRef.current.get(event.winnerId) ?? "someone";
          const mine = event.winnerId === meRef.current;
          pushToast(mine ? "good" : "info", mine ? "You win the round" : `${winner} wins the round`);
          return;
        }

        case "kicked": {
          clearToken();
          meRef.current = null;
          setKicked(event.reason);
          setView(null);
          setMe(null);
          return;
        }

        case "error": {
          if (event.code === "sessionInvalid" && readToken() !== null) {
            // A stale token from a finished or reaped game: forget it quietly
            // rather than showing the player an error they cannot act on.
            clearToken();
            return;
          }
          setSlapPending(false);
          pushToast("bad", event.message);
          return;
        }

        default:
          return;
      }
    },
    [pushToast, markFlash, markPile, pushLog, fly, flush],
  );

  useEffect(() => {
    const conn = connect({ onEvent, onStatus: setStatus });
    connection.current = conn;
    return () => {
      conn.close();
      connection.current = null;
    };
    // One connection for the life of the component: `onEvent` depends only on
    // `pushToast`, which is stable, so this never needs to reconnect.
  }, [onEvent]);

  /** Drop reveals whose time is up, which is what flips the card back over. */
  useEffect(() => {
    if (reveals.length === 0) return;
    const soonest = Math.min(...reveals.map((r) => r.expiresAt));
    const timer = setTimeout(
      () => setReveals((current) => current.filter((r) => r.expiresAt > Date.now())),
      Math.max(50, soonest - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [reveals]);

  /** Animations are transient; drop them once they have played out. */
  useEffect(() => {
    if (flashes.length === 0) return;
    const soonest = Math.min(...flashes.map((f) => f.expiresAt));
    const timer = setTimeout(
      () => setFlashes((current) => current.filter((f) => f.expiresAt > Date.now())),
      Math.max(50, soonest - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [flashes]);

  useEffect(() => {
    if (piles.length === 0) return;
    const soonest = Math.min(...piles.map((p) => p.expiresAt));
    const timer = setTimeout(
      () => setPiles((current) => current.filter((p) => p.expiresAt > Date.now())),
      Math.max(50, soonest - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [piles]);

  /** The red fades on its own; this is what takes the class back off. */
  useEffect(() => {
    if (slapPulse <= Date.now()) return;
    const timer = setTimeout(() => setSlapPulse(0), slapPulse - Date.now());
    return () => clearTimeout(timer);
  }, [slapPulse]);

  /** The deal is over once the last card has reached the last seat. */
  useEffect(() => {
    if (!dealing) return;
    const timer = setTimeout(() => setDealing(false), DEAL_MS);
    return () => clearTimeout(timer);
  }, [dealing]);

  /*
   * Once the table has actually stopped on the slap, the view is the authority
   * on who is picking and the optimistic flag has done its job. It is dropped
   * rather than left to time out: a claimed slap is not a mode you can fall
   * out of, you owe the table a card either way.
   */
  useEffect(() => {
    if (!slapArmed) return;
    if (view?.slapLock != null) setSlapArmed(false);
  }, [slapArmed, view?.slapLock]);

  const send = useCallback((msg: ClientMsg) => connection.current?.send(msg), []);

  const act = useCallback((action: Action) => send({ t: "act", action }), [send]);

  const slap = useCallback(
    (targetId: PlayerId, slot: number) => {
      // Flash locally at once. The server is still the authority, and will
      // correct this with a slap.resolved either way.
      setSlapPending(true);
      setSlapArmed(false);
      setPick(null);
      send({ t: "act", action: { a: "slap", targetId, slot } });
    },
    [send],
  );

  /**
   * Press SLAP without naming a card yet.
   *
   * This is the gesture that stops the table: from here the game waits on you
   * until you flip a card over, so there is nothing to cancel and nothing to
   * time out locally - the server is holding the queue.
   */
  const claimSlap = useCallback(() => {
    setSlapArmed(true);
    setPick(null);
    send({ t: "act", action: { a: "slapClaim" } });
  }, [send]);

  const revealFor = useCallback(
    (ownerId: PlayerId, slot: number): Card | null =>
      reveals.find((r) => r.ownerId === ownerId && r.slot === slot)?.card ?? null,
    [reveals],
  );

  const flashFor = useCallback(
    (ownerId: PlayerId, slot: number): Flash | null =>
      flashes.find((f) => f.ownerId === ownerId && f.slot === slot)?.kind ?? null,
    [flashes],
  );

  const pileFlash = useCallback(
    (pile: PileFlash["pile"]): boolean => piles.some((p) => p.pile === pile),
    [piles],
  );

  return useMemo<GameStore>(
    () => ({
      status,
      view,
      me,
      kicked,
      toasts,
      reveals,
      log,
      dealing,
      flights,
      landed,
      slapArmed,
      slapPending,
      slapPulse: slapPulse > Date.now(),
      pick,
      createRoom: (name) => send({ t: "room.create", name }),
      joinRoom: (code, name) => send({ t: "room.join", code: code.trim().toUpperCase(), name }),
      leave: () => {
        clearToken();
        send({ t: "room.leave" });
        meRef.current = null;
        setView(null);
        setMe(null);
      },
      kick: (playerId) => send({ t: "lobby.kick", playerId }),
      setDecks: (decks) => send({ t: "lobby.decks", decks }),
      setBack: (back) => send({ t: "lobby.back", back }),
      setPowers: (optional) => send({ t: "lobby.powers", optional }),
      start: () => send({ t: "lobby.start" }),
      restart: () => send({ t: "lobby.restart" }),
      act,
      notify: (text) => pushToast("info", text),
      claimSlap,
      slap,
      setPick,
      dismissKick: () => setKicked(null),
      revealFor,
      flashFor,
      pileFlash,
    }),
    [
      status,
      view,
      me,
      kicked,
      toasts,
      reveals,
      log,
      dealing,
      flights,
      landed,
      slapArmed,
      slapPending,
      slapPulse,
      pick,
      send,
      act,
      pushToast,
      slap,
      claimSlap,
      revealFor,
      flashFor,
      pileFlash,
    ],
  );
}

/**
 * Which cards a move sends across the table, and between where.
 *
 * Every end is a list, because a trip can start somewhere that has stopped
 * existing by the time it is drawn: the card somebody has drawn is gone from
 * the table the instant they play it, so the seat it was held at stands in
 * behind it.
 *
 * `peek` and `cambio` send nothing. Nothing moved - a look is a look - and a
 * card gliding about to say otherwise would be a lie about the state.
 */
function tripsFor(kind: TableEventKind, byId: PlayerId, slots: readonly SlotRef[]): Omit<Flight, "id">[] {
  const held = [`held:${byId}`, `seat:${byId}`];
  const at = (ref: SlotRef): string[] => [`slot:${ref.ownerId}:${ref.slot}`, `seat:${ref.ownerId}`];
  const [a, b] = slots;

  switch (kind) {
    case "draw":
      return [{ from: ["deck"], to: held, face: "down" }];
    // Face up both ways: it was the top of the pile, so the table read it on
    // the way out and there is nothing to hide on the way across.
    case "take":
      return [{ from: ["discard"], to: held, face: "heldCard" }];
    case "discard":
      return [{ from: held, to: ["discard"], face: "discardTop" }];
    /*
     * Two cards, in opposite directions: the drawn one going into the hand,
     * and the one it displaces leaving for the pile. Both ends of the trade
     * are the same slot, which is exactly what the move is.
     */
    case "replace":
      return a === undefined
        ? []
        : [
            { from: held, to: at(a), face: "down" },
            { from: at(a), to: ["discard"], face: "discardTop" },
          ];
    case "swap":
      return a === undefined || b === undefined
        ? []
        : [
            { from: at(a), to: at(b), face: "down" },
            { from: at(b), to: at(a), face: "down" },
          ];
    case "give":
      return a === undefined || b === undefined ? [] : [{ from: at(a), to: at(b), face: "down" }];
    case "penalty":
      return a === undefined ? [] : [{ from: ["deck"], to: at(a), face: "down" }];
    case "peek":
    case "cambio":
      return [];
    default:
      return [];
  }
}

/** The animation each move plays on the cards it touched. */
const FLASH_FOR: Record<TableEventKind, Flash | null> = {
  draw: null,
  take: null,
  discard: null,
  replace: "replace",
  peek: "peek",
  swap: "swap",
  give: "give",
  penalty: "penalty",
  cambio: null,
};

/** The pile each move makes move, so it pulses at the same time. */
const PILE_FOR: Record<TableEventKind, PileFlash["pile"] | null> = {
  draw: "deck",
  take: "discard",
  discard: "discard",
  replace: "discard",
  peek: null,
  swap: null,
  give: null,
  penalty: "deck",
  cambio: null,
};

/**
 * A move in one line, the way a player at the table would say it. Written
 * from the reader's point of view, so your own moves read as "You".
 */
function describeTableEvent(
  kind: TableEventKind,
  byId: PlayerId,
  slots: readonly SlotRef[],
  names: Map<PlayerId, string>,
  me: PlayerId | null,
): string {
  const who = byId === me ? "You" : (names.get(byId) ?? "Someone");
  const verb = (plural: string, singular: string): string => (byId === me ? plural : singular);
  /** A card's owner, possessively, collapsing to "their own" for the mover. */
  const owner = (id: PlayerId): string =>
    id === byId ? (byId === me ? "your own" : "their own") : id === me ? "your" : `${names.get(id) ?? "someone"}'s`;

  switch (kind) {
    case "draw":
      return `${who} ${verb("draw", "draws")} from the deck`;
    case "take":
      return `${who} ${verb("take", "takes")} the discard`;
    case "discard":
      return `${who} ${verb("discard", "discards")} the drawn card`;
    case "replace":
      return `${who} ${verb("swap", "swaps")} it into ${byId === me ? "your" : "their"} hand`;
    case "peek": {
      const target = slots[0];
      return target === undefined
        ? `${who} ${verb("look", "looks")} at a card`
        : `${who} ${verb("look", "looks")} at ${owner(target.ownerId)} card`;
    }
    case "swap": {
      const [a, b] = slots;
      if (a === undefined || b === undefined) return `${who} ${verb("swap", "swaps")} two cards`;
      return a.ownerId === b.ownerId
        ? `${who} ${verb("swap", "swaps")} two of ${owner(a.ownerId)} cards`
        : `${who} ${verb("swap", "swaps")} ${owner(a.ownerId)} card with ${owner(b.ownerId)}`;
    }
    case "give": {
      const target = slots[0];
      const to = target === undefined || target.ownerId === me ? "you" : (names.get(target.ownerId) ?? "them");
      return `${who} ${verb("hand", "hands")} ${to} a card`;
    }
    case "penalty":
      return `${who} ${verb("take", "takes")} a penalty card`;
    case "cambio":
      return `${who} ${verb("call", "calls")} Cambio`;
    default:
      return "";
  }
}

function describeSlap(
  event: Extract<ServerEvent, { t: "slap.resolved" }>,
  names: Map<PlayerId, string>,
  me: PlayerId | null,
): [Toast["kind"], string] {
  const mine = event.slapperId === me;
  const nameOf = (id: PlayerId): string => (id === me ? "You" : (names.get(id) ?? "someone"));
  const slapper = nameOf(event.slapperId);
  const by = event.marginMs !== null && event.marginMs > 0 ? ` by ${Math.round(event.marginMs)}ms` : "";

  switch (event.outcome) {
    case "ownCardDiscarded":
      return [mine ? "good" : "info", `${slapper} slapped${by}`];
    case "otherCardDiscarded":
      return [mine ? "good" : "info", `${slapper} slapped someone else's card${by}`];
    case "wrongRankPenalty":
      return [mine ? "bad" : "info", `${slapper} slapped wrong and took a card`];
    case "noPickPenalty":
      return [
        mine ? "bad" : "info",
        mine ? "You ran out of time to pick and took a card" : `${slapper} never picked and took a card`,
      ];
    case "lostRace":
      // Being behind in the queue is a reprieve, not a loss: the slap ahead of
      // yours was right, so yours never had to be played.
      return event.endedById === null
        ? ["info", "Your slap was too late"]
        : ["info", `${nameOf(event.endedById)} got there first - your slap was not played`];
    case "noLongerValid":
      return ["info", "That slap was no longer valid"];
    default:
      return ["info", "Slap"];
  }
}

export type { ErrorCode };
