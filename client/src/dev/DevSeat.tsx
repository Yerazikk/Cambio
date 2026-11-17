import { useEffect, useMemo, useRef } from "react";
import { Game } from "../App.js";
import { readToken } from "../net/socket.js";
import { useGame } from "../state/useGame.js";

/**
 * One seat of the dev harness: the real client, in a real browsing context of
 * its own, told by its URL which player to be.
 *
 * Nothing here is a simulation. The pane opens its own socket, holds its own
 * session token and is seen by the server as a separate person - the only
 * thing the harness adds is that it types the name and presses the button for
 * you, so a four-handed table is one page load instead of four.
 */

/**
 * How long a pane carrying a stored token waits for its resume to land before
 * concluding the seat is gone and taking a fresh one. A reload of a single
 * pane is meant to come back to the same seat, which is the whole point of
 * being able to reload one.
 */
const RESUME_GRACE_MS = 1_200;

export type SeatParams = {
  /** Namespaces this pane's session token; see `seatTokenKey`. */
  seat: string;
  name: string;
  /** This pane creates the table; every other one joins the code it reports. */
  create: boolean;
  code: string | null;
};

export function readSeatParams(search: string): SeatParams {
  const query = new URLSearchParams(search);
  return {
    seat: query.get("seat") ?? "0",
    name: query.get("name") ?? "Player",
    create: query.get("act") === "create",
    code: query.get("code"),
  };
}

/** What a pane tells the harness about itself, whenever any of it changes. */
export type SeatReport = {
  source: "cambio-dev";
  seat: string;
  name: string;
  status: string;
  code: string | null;
  phase: string | null;
  players: number;
  seated: boolean;
};

export function DevSeat(): React.JSX.Element {
  const game = useGame();
  const { seat, name, create, code } = useMemo(() => readSeatParams(location.search), []);

  /** Set once this pane holds a seat, so leaving is not undone by re-joining. */
  const taken = useRef(false);
  const gameRef = useRef(game);
  gameRef.current = game;

  useEffect(() => {
    if (game.me !== null) taken.current = true;
  }, [game.me]);

  // Take the seat: create the table, or join the one the creator reported.
  useEffect(() => {
    if (taken.current || game.status !== "open" || game.me !== null) return;
    const timer = setTimeout(
      () => {
        if (gameRef.current.me !== null) return;
        taken.current = true;
        if (create) gameRef.current.createRoom(name);
        else if (code !== null) gameRef.current.joinRoom(code, name);
      },
      readToken() !== null ? RESUME_GRACE_MS : 0,
    );
    return () => clearTimeout(timer);
  }, [game.status, game.me, create, code, name]);

  // Report upwards, so the harness can show the code, the phase and who is
  // still connected without reaching into the pane's DOM.
  const phase = game.view?.phase ?? null;
  const roomCode = game.view?.code ?? null;
  const players = game.view?.players.length ?? 0;
  useEffect(() => {
    const report: SeatReport = {
      source: "cambio-dev",
      seat,
      name,
      status: game.status,
      code: roomCode,
      phase,
      players,
      seated: game.me !== null,
    };
    window.parent.postMessage(report, location.origin);
  }, [seat, name, game.status, roomCode, phase, players, game.me]);

  return <Game game={game} />;
}
