import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  Action,
  Card,
  ClientMsg,
  ErrorCode,
  GameView,
  PlayerId,
  ServerEvent,
  SnapOutcome,
} from "@cambio/shared";
import { clearToken, connect, readToken, type ConnectionStatus, type Connection } from "../net/socket.js";

/** A card currently face up on this player's screen, and when it flips back. */
export type Reveal = { ownerId: PlayerId; slot: number; card: Card; expiresAt: number };

export type Toast = { id: number; kind: "info" | "good" | "bad"; text: string };

/** Two-step powers need somewhere to hold the first click. */
export type PickOne = { mySlot: number } | null;

export type GameStore = {
  status: ConnectionStatus;
  view: GameView | null;
  me: PlayerId | null;
  kicked: string | null;
  toasts: Toast[];
  reveals: Reveal[];
  /** While armed, clicking any card snaps it instead of playing it. */
  snapArmed: boolean;
  /** Set the instant a snap is sent, for feedback that does not wait for the server. */
  snapPending: boolean;
  pick: PickOne;

  createRoom: (name: string) => void;
  joinRoom: (code: string, name: string) => void;
  leave: () => void;
  kick: (playerId: PlayerId) => void;
  start: () => void;
  restart: () => void;
  act: (action: Action) => void;

  armSnap: (armed: boolean) => void;
  snap: (targetId: PlayerId, slot: number) => void;
  setPick: (pick: PickOne) => void;
  dismissKick: () => void;
  revealFor: (ownerId: PlayerId, slot: number) => Card | null;
};

const SNAP_ARM_MS = 3_000;
const TOAST_MS = 3_500;

export function useGame(): GameStore {
  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  const [view, setView] = useState<GameView | null>(null);
  const [me, setMe] = useState<PlayerId | null>(null);
  const [kicked, setKicked] = useState<string | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [reveals, setReveals] = useState<Reveal[]>([]);
  const [snapArmed, setSnapArmed] = useState(false);
  const [snapPending, setSnapPending] = useState(false);
  const [pick, setPick] = useState<PickOne>(null);

  const connection = useRef<Connection | null>(null);
  const toastId = useRef(0);
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

        case "snap.resolved": {
          setSnapPending(false);
          setSnapArmed(false);
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
    [pushToast],
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

  return useMemo<GameStore>(
    () => ({
      status,
      view,
      me,
      kicked,
      toasts,
      reveals,
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
      start: () => send({ t: "lobby.start" }),
      restart: () => send({ t: "lobby.restart" }),
      act,
      armSnap: setSnapArmed,
      snap,
      setPick,
      dismissKick: () => setKicked(null),
      revealFor,
    }),
    [status, view, me, kicked, toasts, reveals, snapArmed, snapPending, pick, send, act, snap, revealFor],
  );
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
