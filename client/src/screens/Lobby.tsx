import { useState } from "react";
import { MAX_PLAYERS, MIN_PLAYERS, type GameView, type PlayerId } from "@cambio/shared";

export type LobbyProps = {
  view: GameView;
  me: PlayerId;
  onKick: (playerId: PlayerId) => void;
  onStart: () => void;
  onLeave: () => void;
};

export function Lobby({ view, me, onKick, onStart, onLeave }: LobbyProps): React.JSX.Element {
  const [copied, setCopied] = useState(false);
  const amHost = view.players.find((p) => p.id === me)?.isHost === true;
  const enough = view.players.length >= MIN_PLAYERS;

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(view.code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1_500);
    } catch {
      /* clipboard access is optional; the code is on screen regardless */
    }
  };

  return (
    <main className="lobby">
      <header className="lobby__head">
        <h1 className="lobby__title">Table</h1>
        <button type="button" className="code" onClick={copy} data-testid="room-code" title="Copy the code">
          <span className="code__value">{view.code}</span>
          <span className="code__hint">{copied ? "copied" : "copy"}</span>
        </button>
      </header>

      <p className="lobby__blurb">
        Share that code. {MIN_PLAYERS}&ndash;{MAX_PLAYERS} players; the host starts the round.
      </p>

      <ul className="lobby__players">
        {view.players.map((player) => (
          <li key={player.id} className="lobby__player" data-testid={`lobby-player-${player.name}`}>
            <span className="lobby__playerName">
              {player.name}
              {player.id === me && <span className="seat__badge">you</span>}
              {player.isHost && <span className="seat__badge seat__badge--host">host</span>}
              {!player.connected && <span className="seat__away">away</span>}
            </span>
            {amHost && player.id !== me && (
              <button
                type="button"
                className="button button--ghost button--small"
                onClick={() => onKick(player.id)}
                data-testid={`kick-${player.name}`}
              >
                Remove
              </button>
            )}
          </li>
        ))}
      </ul>

      <div className="lobby__actions">
        {amHost ? (
          <button
            type="button"
            className="button button--primary"
            disabled={!enough}
            onClick={onStart}
            data-testid="start-button"
          >
            {enough ? "Start the round" : `Waiting for ${MIN_PLAYERS - view.players.length} more`}
          </button>
        ) : (
          <p className="lobby__waiting" data-testid="waiting-for-host">
            Waiting for the host to start&hellip;
          </p>
        )}
        <button type="button" className="button button--ghost" onClick={onLeave} data-testid="leave-button">
          Leave
        </button>
      </div>
    </main>
  );
}
