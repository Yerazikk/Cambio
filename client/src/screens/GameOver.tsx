import type { GameView, PlayerId } from "@cambio/shared";

export type GameOverProps = {
  view: GameView;
  me: PlayerId;
  onRestart: () => void;
  onLeave: () => void;
};

export function GameOver({ view, me, onRestart, onLeave }: GameOverProps): React.JSX.Element {
  const ranked = [...view.players].sort((a, b) => (a.score ?? 0) - (b.score ?? 0));
  const winner = view.players.find((p) => p.id === view.winnerId);
  const caller = view.players.find((p) => p.calledCambio);

  return (
    <section className="over" data-testid="game-over">
      <h2 className="over__title">{view.winnerId === me ? "You win" : `${winner?.name ?? "Nobody"} wins`}</h2>
      <p className="over__sub">
        {caller === undefined
          ? "The round ended on an empty hand."
          : `${caller.id === me ? "You" : caller.name} called Cambio. Lowest hand wins, and the caller takes ties.`}
      </p>

      <ol className="over__scores">
        {ranked.map((player, index) => (
          <li key={player.id} className={player.id === view.winnerId ? "over__row over__row--win" : "over__row"}>
            <span className="over__rank">{index + 1}</span>
            <span className="over__name">
              {player.name}
              {player.calledCambio && <span className="chip chip--red">Cambié</span>}
              <span className="over__cards">
                {player.slots.map((slot) => (slot.kind === "up" ? labelOf(slot.card.rank) : slot.kind === "gap" ? "-" : "?")).join("  ")}
              </span>
            </span>
            <span className="over__score" data-testid={`final-${player.name}`}>
              {player.score}
            </span>
          </li>
        ))}
      </ol>

      <div className="over__actions">
        {/*
          Anyone may do this, and it goes back to the lobby rather than
          straight into another deal. Between rounds is when a table changes
          its mind - another pack, a different back, somebody joining - and
          it is also where a player who dropped last round is picked back up.
        */}
        <button type="button" className="button button--primary" onClick={onRestart} data-testid="play-again">
          Play again
        </button>
        <button type="button" className="button button--ghost" onClick={onLeave} data-testid="over-leave">
          Leave the table
        </button>
      </div>
    </section>
  );
}

function labelOf(rank: number | "joker"): string {
  if (rank === "joker") return "JK";
  const names: Record<number, string> = { 1: "A", 11: "J", 12: "Q", 13: "K" };
  return names[rank] ?? String(rank);
}
