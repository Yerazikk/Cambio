import { backImageUrl } from "./backs.js";
import { GameOver } from "./screens/GameOver.js";
import { Home } from "./screens/Home.js";
import { Lobby } from "./screens/Lobby.js";
import { Table } from "./screens/Table.js";
import { Toasts } from "./components/Toasts.js";
import { useGame } from "./state/useGame.js";

export function App(): React.JSX.Element {
  const game = useGame();
  const { view, me, status } = game;

  // The back is one table-wide setting, so it rides down as a custom property
  // rather than threading a prop through every card on screen.
  const backStyle = { "--card-back": `url("${backImageUrl(view?.back)}")` } as React.CSSProperties;

  return (
    <div className="app" style={backStyle}>
      {status !== "open" && (
        <div className="banner" data-testid="connection-banner">
          {status === "connecting" ? "Connecting…" : "Connection lost — retrying…"}
        </div>
      )}

      {game.kicked !== null && (
        <div className="banner banner--bad" data-testid="kicked-banner">
          {game.kicked}
          <button type="button" className="button button--small" onClick={game.dismissKick}>
            Dismiss
          </button>
        </div>
      )}

      {view === null || me === null ? (
        <Home onCreate={game.createRoom} onJoin={game.joinRoom} disabled={status !== "open"} />
      ) : view.phase === "lobby" ? (
        <Lobby
          view={view}
          me={me}
          onKick={game.kick}
          onDecks={game.setDecks}
          onBack={game.setBack}
          onStart={game.start}
          onLeave={game.leave}
        />
      ) : view.phase === "finished" ? (
        <GameOver view={view} me={me} onRestart={game.restart} onLeave={game.leave} />
      ) : (
        <Table
          view={view}
          me={me}
          snapArmed={game.snapArmed}
          snapPending={game.snapPending}
          dealing={game.dealing}
          pick={game.pick}
          log={game.log}
          act={game.act}
          snap={game.snap}
          armSnap={game.armSnap}
          setPick={game.setPick}
          revealFor={game.revealFor}
          flashFor={game.flashFor}
          pileFlash={game.pileFlash}
          onLeave={game.leave}
        />
      )}

      <Toasts toasts={game.toasts} />
    </div>
  );
}
