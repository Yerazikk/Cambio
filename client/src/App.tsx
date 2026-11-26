import { useState } from "react";
import { backImageUrl } from "./backs.js";
import { GameOver } from "./screens/GameOver.js";
import { Home } from "./screens/Home.js";
import { Lobby } from "./screens/Lobby.js";
import { Table } from "./screens/Table.js";
import { RulesHelp } from "./components/RulesHelp.js";
import { Toasts } from "./components/Toasts.js";
import { useGame, type GameStore } from "./state/useGame.js";

export function App(): React.JSX.Element {
  const game = useGame();
  return <Game game={game} />;
}

/**
 * The whole interface, over a store handed to it rather than one it opens for
 * itself. The seam exists for the dev harness, which drives the seat it is
 * rendering - every other caller is `App` above.
 */
export function Game({ game }: { game: GameStore }): React.JSX.Element {
  const { view, me, status } = game;
  /**
   * The rule book lives up here rather than inside its own component because
   * the table listens for the same keys that slap, and must stand down while
   * somebody is reading.
   */
  const [helpOpen, setHelpOpen] = useState(false);

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
          onPowers={game.setPowers}
          onStart={game.start}
          onLeave={game.leave}
          onNotify={game.notify}
        />
      ) : view.phase === "finished" ? (
        <GameOver view={view} me={me} onRestart={game.restart} onLeave={game.leave} />
      ) : (
        <Table
          view={view}
          me={me}
          slapArmed={game.slapArmed}
          slapPending={game.slapPending}
          keysHeld={helpOpen}
          dealing={game.dealing}
          pick={game.pick}
          log={game.log}
          act={game.act}
          slap={game.slap}
          claimSlap={game.claimSlap}
          setPick={game.setPick}
          revealFor={game.revealFor}
          flashFor={game.flashFor}
          pileFlash={game.pileFlash}
          onLeave={game.leave}
        />
      )}

      <Toasts toasts={game.toasts} />

      {/* The rule book sits in the corner of every screen, lobby included. */}
      <RulesHelp open={helpOpen} onOpenChange={setHelpOpen} optionalPowers={view?.optionalPowers ?? false} />
    </div>
  );
}
