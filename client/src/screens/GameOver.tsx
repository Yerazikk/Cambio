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
  const amHost = view.players.find((p) => p.id === me)?.isHost === true;

  return (
    <section className="over" data-testid="game-over">
      <h2 className="over__title">
        {view.winnerId === me ? "You win" : `${winner?.name ?? "Nobody"} wins`}
      </h2>

      <ol className="over__scores">
        {ranked.map((player, index) => (
          <li key={player.id} className={player.id === view.winnerId ? "over__row over__row--win" : "over__row"}>
            <span className="over__rank">{index + 1}</span>
            <span className="over__name">
              {player.name}
              {player.calledCambio && <span className="seat__called">called</span>}
            </span>
            <span className="over__cards">
              {player.slots.map((slot) => (slot.known ? labelOf(slot.card.rank) : "?")).join(" ")}
            </span>
            <span className="over__score" data-testid={`final-${player.name}`}>
              {player.score}
            </span>
          </li>
        ))}
      </ol>

      <div className="over__actions">
        {amHost ? (
          <button type="button" className="button button--primary" onClick={onRestart} data-testid="play-again">
            Play again
          </button>
        ) : (
          <p className="over__waiting" data-testid="over-waiting">
            Waiting for the host to play again&hellip;
          </p>
        )}
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
