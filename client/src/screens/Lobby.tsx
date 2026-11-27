import {
  CARDS_PER_DECK,
  CARD_BACKS,
  DECK_CHOICES,
  MIN_PLAYERS,
  type GameView,
  type PlayerId,
} from "@cambio/shared";
import { backImageUrl } from "../backs.js";
import { Crowned } from "../components/Crown.js";

export type LobbyProps = {
  view: GameView;
  me: PlayerId;
  onKick: (playerId: PlayerId) => void;
  onDecks: (decks: number) => void;
  onBack: (back: string) => void;
  onPowers: (optional: boolean) => void;
  onStart: () => void;
  onLeave: () => void;
  /** Says the code has been copied, in the place every other notice appears. */
  onNotify: (text: string) => void;
};

export function Lobby({
  view,
  me,
  onKick,
  onDecks,
  onBack,
  onPowers,
  onStart,
  onLeave,
  onNotify,
}: LobbyProps): React.JSX.Element {
  const amHost = view.players.find((p) => p.id === me)?.isHost === true;
  const enough = view.players.length >= MIN_PLAYERS;

  /**
   * The capsule is a button and the code is all that is printed in it, so
   * what it does has to be said when it is pressed rather than labelled.
   * Silence on failure would be worse than useless - the player would be
   * pasting nothing - so a refused clipboard says so.
   */
  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(view.code);
      onNotify("Copied to clipboard");
    } catch {
      onNotify("Could not copy - the code is on screen");
    }
  };

  return (
    <main className="lobby">
      <header className="lobby__head">
        <h1 className="lobby__title">Table</h1>
        <button type="button" className="code" onClick={copy} data-testid="room-code" title="Copy the code">
          <span className="code__value">{view.code}</span>
        </button>
      </header>

      <p className="lobby__blurb">Share the code.</p>

      <ul className="lobby__players">
        {view.players.map((player) => (
          <li key={player.id} className="lobby__player" data-testid={`lobby-player-${player.name}`}>
            <span className="lobby__playerName">
              <Crowned name={player.name} isHost={player.isHost} />
              {player.id === me && <span className="chip chip--quiet">you</span>}
              {!player.connected && <span className="chip chip--quiet">away</span>}
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

      <section className="setting" aria-label="Decks in play">
        <span className="setting__label">Decks</span>
        <div className="decks__choices" role="group">
          {DECK_CHOICES.map((count) => {
            const chosen = view.decks === count;
            return (
              <button
                key={count}
                type="button"
                className={`decks__choice${chosen ? " decks__choice--on" : ""}`}
                aria-pressed={chosen}
                disabled={!amHost}
                onClick={() => onDecks(count)}
                data-testid={`decks-${count}`}
              >
                {count}
              </button>
            );
          })}
        </div>
        <p className="setting__hint" data-testid="decks-hint">
          {view.decks * CARDS_PER_DECK} cards
        </p>
      </section>

      {/*
        Whether a power you trigger is a power you have to use. It is the one
        setting that changes how a turn is played rather than what the table
        looks like, so it says what each choice means rather than leaving the
        host to find out mid-round.
      */}
      <section className="setting setting--said" aria-label="Powers">
        <span className="setting__label">Powers</span>
        <div className="decks__choices" role="group">
          <button
            type="button"
            className={`decks__choice decks__choice--wide${view.optionalPowers ? "" : " decks__choice--on"}`}
            aria-pressed={!view.optionalPowers}
            disabled={!amHost}
            onClick={() => onPowers(false)}
            data-testid="powers-required"
          >
            Must use
          </button>
          <button
            type="button"
            className={`decks__choice decks__choice--wide${view.optionalPowers ? " decks__choice--on" : ""}`}
            aria-pressed={view.optionalPowers}
            disabled={!amHost}
            onClick={() => onPowers(true)}
            data-testid="powers-optional"
          >
            Optional
          </button>
        </div>
        <p className="setting__hint" data-testid="powers-hint">
          {view.optionalPowers
            ? "A power you trigger may be waved away"
            : "Discard from the deck and you use what the card does"}
        </p>
      </section>

      <section className="backs" aria-label="Card back">
        <span className="setting__label">Cards</span>
        <div className="backs__choices" role="group">
          {CARD_BACKS.map((back) => {
            const chosen = view.back === back.id;
            return (
              <button
                key={back.id}
                type="button"
                className={`backs__choice${chosen ? " backs__choice--on" : ""}`}
                style={{ backgroundImage: `url("${backImageUrl(back.id)}")` }}
                aria-pressed={chosen}
                aria-label={back.label}
                title={back.label}
                disabled={!amHost}
                onClick={() => onBack(back.id)}
                data-testid={`back-${back.id}`}
              />
            );
          })}
        </div>
      </section>

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
