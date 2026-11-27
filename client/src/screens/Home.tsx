import { useCallback, useEffect, useRef, useState } from "react";
import { makeCard, NUMERIC_RANKS, ROOM_CODE_LENGTH, SUITS, cardLabel, type Card } from "@cambio/shared";
import { CardFace } from "../components/Card.js";

export type HomeProps = {
  onCreate: (name: string) => void;
  onJoin: (code: string, name: string) => void;
  disabled: boolean;
};

/**
 * Where the name you play under is kept between visits.
 *
 * In `localStorage` rather than the `sessionStorage` the seat token uses, and
 * deliberately: a token belongs to one tab, because two tabs are two players,
 * but a name belongs to the person at the keyboard and should still be there
 * tomorrow. It is only ever filled in for them - the field stays editable, so
 * nobody is stuck with a name they typed once.
 */
const NAME_KEY = "cambio.name";

function rememberedName(): string {
  try {
    return localStorage.getItem(NAME_KEY) ?? "";
  } catch {
    // A private window still plays; it just will not recognise you next time.
    return "";
  }
}

function rememberName(name: string): void {
  try {
    localStorage.setItem(NAME_KEY, name);
  } catch {
    /* nothing to do */
  }
}

export function Home({ onCreate, onJoin, disabled }: HomeProps): React.JSX.Element {
  const [name, setName] = useState(rememberedName);
  const [code, setCode] = useState("");

  const trimmed = name.trim();
  const canCreate = trimmed.length > 0 && !disabled;
  const canJoin = canCreate && code.trim().length === ROOM_CODE_LENGTH;

  /** Sitting down is what makes a name worth keeping, so it is kept here. */
  const create = (): void => {
    rememberName(trimmed);
    onCreate(trimmed);
  };
  const join = (): void => {
    rememberName(trimmed);
    onJoin(code, trimmed);
  };

  return (
    <main className="home">
      <Fan />

      <h1 className="home__title">Cambio</h1>
      <p className="home__tagline">
        End the round with the fewest points
      </p>
      <hr className="home__rule" />

      <form
        className="home__form"
        onSubmit={(event) => {
          event.preventDefault();
          if (canJoin) join();
          else if (canCreate) create();
        }}
      >
        {/*
          Two fields, each labelled by what it is waiting for rather than by a
          caption above it. A form this short does not need both, and the
          placeholder is where the eye already is.
        */}
        <label className="field">
          <input
            className="field__input"
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={16}
            placeholder="Your name"
            aria-label="Your name"
            autoFocus
            data-testid="name-input"
          />
        </label>

        <div className="home__actions">
          <button
            type="button"
            className="button button--primary"
            disabled={!canCreate}
            onClick={create}
            data-testid="create-button"
          >
            Create a table
          </button>
        </div>

        <div className="home__divider">
          <span>or join one</span>
        </div>

        <div className="home__join">
          <label className="field">
            <input
              className="field__input field__input--code"
              value={code}
              onChange={(event) => setCode(event.target.value.toUpperCase().slice(0, ROOM_CODE_LENGTH))}
              placeholder="CODE"
              aria-label="Table code"
              data-testid="code-input"
            />
          </label>
          <button type="submit" className="button" disabled={!canJoin} data-testid="join-button">
            Join
          </button>
        </div>
      </form>
    </main>
  );
}

/** How long a turned card stays face up before it turns itself back over. */
const FAN_FACE_MS = 3_000;
/** A pack is 54 cards and two of them are jokers. */
const JOKER_CHANCE = 2 / 54;

/** One card off the top of an imaginary pack. */
function randomCard(id: string): Card {
  if (Math.random() < JOKER_CHANCE) return makeCard("joker", null, id);
  const rank = NUMERIC_RANKS[Math.floor(Math.random() * NUMERIC_RANKS.length)] ?? 1;
  const suit = SUITS[Math.floor(Math.random() * SUITS.length)] ?? "S";
  return makeCard(rank, suit, id);
}

/**
 * Three cards, fanned out above the title.
 *
 * It is the only decoration in the interface, and the only part of it that is
 * not the game - but it is made of the game's own card, so turning one over
 * here turns over exactly as it will at the table, and what you get is a card
 * off a real pack with a real joker in it.
 *
 * Each card keeps its own clock, so you can turn all three over in a second
 * and watch them come back one at a time. A card already face up ignores a
 * second click rather than restarting its three seconds: that way the fan
 * cannot be held open, and it always settles back to a fan.
 */
function Fan(): React.JSX.Element {
  const [faces, setFaces] = useState<(Card | null)[]>([null, null, null]);
  const timers = useRef<(ReturnType<typeof setTimeout> | null)[]>([null, null, null]);

  // A card turning back over on a page that has gone is a React warning and
  // nothing else, but the timer is ours and we clear up after ourselves.
  useEffect(() => {
    const running = timers.current;
    return () => {
      for (const timer of running) if (timer !== null) clearTimeout(timer);
    };
  }, []);

  const turn = useCallback((index: number): void => {
    setFaces((current) => {
      if (current[index] !== undefined && current[index] !== null) return current;

      const existing = timers.current[index];
      if (existing !== null) clearTimeout(existing);
      timers.current[index] = setTimeout(() => {
        setFaces((latest) => latest.map((card, i) => (i === index ? null : card)));
      }, FAN_FACE_MS);

      return current.map((card, i) => (i === index ? randomCard(`fan-${index}-${Date.now()}`) : card));
    });
  }, []);

  return (
    <div className="fan">
      {faces.map((card, index) => (
        <button
          key={index}
          type="button"
          className="fan__card"
          onClick={() => turn(index)}
          aria-label={card === null ? "Turn a card over" : cardLabel(card)}
          data-testid={`fan-card-${index}`}
        >
          <CardFace card={card} />
        </button>
      ))}
    </div>
  );
}
