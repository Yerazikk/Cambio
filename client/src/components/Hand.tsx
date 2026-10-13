import type { Card, PlayerId, PlayerView } from "@cambio/shared";
import { CardFace } from "./Card.js";

export type HandProps = {
  player: PlayerView;
  isYou: boolean;
  isTurn: boolean;
  /** Which slots can be clicked right now, and what the click means. */
  targetable: (slot: number) => "idle" | "targetable" | "selected" | "snap";
  onSlot: (slot: number) => void;
  /** A transient peek, if this player's slot is currently face up for us. */
  revealFor: (ownerId: PlayerId, slot: number) => Card | null;
};

export function Hand({ player, isYou, isTurn, targetable, onSlot, revealFor }: HandProps): React.JSX.Element {
  const classes = ["seat"];
  if (isYou) classes.push("seat--you");
  if (isTurn) classes.push("seat--turn");
  if (!player.connected) classes.push("seat--away");

  return (
    <section className={classes.join(" ")} data-testid={`seat-${player.name}`} aria-label={`${player.name}'s hand`}>
      <header className="seat__head">
        <span className="seat__name">
          {player.name}
          {isYou && <span className="seat__badge">you</span>}
          {player.isHost && <span className="seat__badge seat__badge--host">host</span>}
        </span>
        <span className="seat__meta">
          {!player.connected && <span className="seat__away" data-testid={`away-${player.name}`}>away</span>}
          {player.calledCambio && <span className="seat__called">Cambio!</span>}
          {player.score !== null && (
            <span className="seat__score" data-testid={`score-${player.name}`}>
              {player.score}
            </span>
          )}
        </span>
      </header>

      <div className="seat__cards">
        {player.slots.map((slot, index) => {
          // A slot shows a face from one of two sources: the authoritative view
          // at the final reveal, or a peek we are currently being shown.
          const face: Card | null = slot.known ? slot.card : revealFor(player.id, index);
          return (
            <CardFace
              key={slot.id}
              card={face}
              state={targetable(index)}
              onClick={() => onSlot(index)}
              testId={`slot-${player.name}-${index}`}
              {...(isYou ? { label: String(index + 1) } : {})}
            />
          );
        })}
        {player.slots.length === 0 && <span className="seat__empty">no cards</span>}
      </div>
    </section>
  );
}
