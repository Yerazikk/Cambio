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
  SnapOutcome,
  TableEventKind,
} from "@cambio/shared";
import type { Flash } from "../components/Card.js";
import { clearToken, connect, readToken, type ConnectionStatus, type Connection } from "../net/socket.js";

/** A card currently face up on this player's screen, and when it flips back. */
export type Reveal = { ownerId: PlayerId; slot: number; card: Card; expiresAt: number };

export type Toast = { id: number; kind: "info" | "good" | "bad"; text: string };

/** A card mid-gesture: flipped, swapped, snapped. Everyone sees the same one. */
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
  /** While armed, clicking any card snaps it instead of playing it. */
  snapArmed: boolean;
  /** Set the instant a snap is sent, for feedback that does not wait for the server. */
  snapPending: boolean;
  pick: PickOne;

  createRoom: (name: string) => void;
  joinRoom: (code: string, name: string) => void;
  leave: () => void;
  kick: (playerId: PlayerId) => void;
  setDecks: (decks: number) => void;
  setBack: (back: string) => void;
  start: () => void;
  restart: () => void;
  act: (action: Action) => void;

  armSnap: (armed: boolean) => void;
  snap: (targetId: PlayerId, slot: number) => void;
  setPick: (pick: PickOne) => void;
  dismissKick: () => void;
  revealFor: (ownerId: PlayerId, slot: number) => Card | null;
  /** The gesture a given card is in the middle of, for everyone watching. */
  flashFor: (ownerId: PlayerId, slot: number) => Flash | null;
  pileFlash: (pile: "deck" | "discard") => boolean;
};

const SNAP_ARM_MS = 3_000;
const TOAST_MS = 3_500;
/** How long a move stays visible as an animation. Long enough to catch across the table. */
const FLASH_MS = 1_100;
/** How many past moves the table log keeps on screen. */
const LOG_LINES = 5;

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
  const [snapArmed, setSnapArmed] = useState(false);
  const [snapPending, setSnapPending] = useState(false);
  const [pick, setPick] = useState<PickOne>(null);

  const connection = useRef<Connection | null>(null);
  const toastId = useRef(0);
  const logId = useRef(0);
  /** The phase we last saw, so a fresh deal can be told from a normal update. */
  const phaseRef = useRef<Phase | null>(null);
  const namesRef = useRef<Map<PlayerId, string>>(new Map());
  /**
   * Our own id, in a ref as well as state.
   *
   * The socket is opened once, so the event handler it is given is captured
   * once too. Reading `me` from state inside that handler would read the value
   * from first render - null - forever, which is how "You snapped" came out as
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
            setLog([]);
          }
          phaseRef.current = event.view.phase;

          setView((previous) => {
            // A view that arrives out of order would rewind the table.
            if (previous !== null && event.view.version < previous.version) return previous;
            return event.view;
          });
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
          pushLog(describeTableEvent(event.kind, event.byId, event.slots, namesRef.current, meRef.current));
          return;
        }

        case "snap.resolved": {
          setSnapPending(false);
          setSnapArmed(false);
          if (event.winnerId !== null && event.outcome !== "noLongerValid") {
            markFlash("snap", [{ ownerId: event.targetId, slot: event.slot }]);
            if (event.outcome !== "wrongRankPenalty") markPile("discard");
          }
          pushToast(...describeSnap(event.outcome, event.winnerId, event.marginMs, namesRef.current, meRef.current));
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
          setSnapPending(false);
          pushToast("bad", event.message);
          return;
        }

        default:
          return;
      }
    },
    [pushToast, markFlash, markPile, pushLog],
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

  /** Snap mode disarms itself, so a stray later click does not snap by accident. */
  useEffect(() => {
    if (!snapArmed) return;
    const timer = setTimeout(() => setSnapArmed(false), SNAP_ARM_MS);
    return () => clearTimeout(timer);
  }, [snapArmed]);

  const send = useCallback((msg: ClientMsg) => connection.current?.send(msg), []);

  const act = useCallback((action: Action) => send({ t: "act", action }), [send]);

  const snap = useCallback(
    (targetId: PlayerId, slot: number) => {
      // Flash locally at once. The server is still the authority, and will
      // correct this with a snap.resolved either way.
      setSnapPending(true);
      setSnapArmed(false);
      setPick(null);
      send({ t: "act", action: { a: "snap", targetId, slot } });
    },
    [send],
  );

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
      snapArmed,
      snapPending,
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
      start: () => send({ t: "lobby.start" }),
      restart: () => send({ t: "lobby.restart" }),
      act,
      armSnap: setSnapArmed,
      snap,
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
      snapArmed,
      snapPending,
      pick,
      send,
      act,
      snap,
      revealFor,
      flashFor,
      pileFlash,
    ],
  );
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

function describeSnap(
  outcome: SnapOutcome,
  winnerId: PlayerId | null,
  marginMs: number | null,
  names: Map<PlayerId, string>,
  me: PlayerId | null,
): [Toast["kind"], string] {
  const winner = winnerId === null ? "nobody" : winnerId === me ? "You" : (names.get(winnerId) ?? "someone");
  const by = marginMs !== null && marginMs > 0 ? ` by ${Math.round(marginMs)}ms` : "";

  switch (outcome) {
    case "ownCardDiscarded":
      return [winnerId === me ? "good" : "info", `${winner} snapped${by}`];
    case "otherCardDiscarded":
      return [winnerId === me ? "good" : "info", `${winner} snapped someone else's card${by}`];
    case "wrongRankPenalty":
      return [winnerId === me ? "bad" : "info", `${winner} snapped wrong and took a card`];
    case "lostRace":
      return ["bad", `Too slow - ${winner} got there first${by}`];
    case "noLongerValid":
      return ["info", "That snap was no longer valid"];
    default:
      return ["info", "Snap"];
  }
}

export type { ErrorCode };
