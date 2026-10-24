import { useState } from "react";

export type HomeProps = {
  onCreate: (name: string) => void;
  onJoin: (code: string, name: string) => void;
  disabled: boolean;
};

export function Home({ onCreate, onJoin, disabled }: HomeProps): React.JSX.Element {
  const [name, setName] = useState("");
  const [code, setCode] = useState("");

  const trimmed = name.trim();
  const canCreate = trimmed.length > 0 && !disabled;
  const canJoin = canCreate && code.trim().length === 6;

  return (
    <main className="home">
      {/*
        Three cards, fanned. The only decoration in the whole interface, and it
        is the thing the game is made of - it also shows the back this table
        will play with before anyone has to choose one.
      */}
      <div className="fan" aria-hidden="true">
        <span />
        <span />
        <span />
      </div>

      <h1 className="home__title">Cambio</h1>
      <p className="home__tagline">
        Lowest hand wins &mdash; if you can remember what you are holding. Snap a match the moment you see it.
      </p>
      <hr className="home__rule" />

      <form
        className="home__form"
        onSubmit={(event) => {
          event.preventDefault();
          if (canJoin) onJoin(code, trimmed);
          else if (canCreate) onCreate(trimmed);
        }}
      >
        <label className="field">
          <span className="field__label">Your name</span>
          <input
            className="field__input"
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={16}
            placeholder="Ana"
            autoFocus
            data-testid="name-input"
          />
        </label>

        <div className="home__actions">
          <button
            type="button"
            className="button button--primary"
            disabled={!canCreate}
            onClick={() => onCreate(trimmed)}
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
            <span className="field__label">Table code</span>
            <input
              className="field__input field__input--code"
              value={code}
              onChange={(event) => setCode(event.target.value.toUpperCase().slice(0, 6))}
              placeholder="ABC234"
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
