import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { MAX_PLAYERS, MIN_PLAYERS } from "@cambio/shared";
import { seatTokenKey } from "../net/socket.js";
import type { SeatReport } from "./DevSeat.js";

/**
 * A whole table in one page.
 *
 * Every pane is a real client - its own document, its own socket, its own
 * session token - so what you are looking at is exactly what several people on
 * several machines would see, including the things that only go wrong between
 * clients: a move that animates on one screen and not another, a slap race, a
 * view that arrives out of order, a seat that drops and comes back.
 *
 * The first pane creates the table and reports the code upward; the rest join
 * it. Nothing after that is driven by the harness - you play the panes.
 */

/** Names in seat order. Short, so a seat label never wraps. */
const NAMES = ["Ana", "Ben", "Cleo", "Dev", "Eve", "Finn"] as const;

/** The viewport each pane gets. The app is responsive, so this is a real choice. */
const SIZES = {
  desktop: { label: "Desktop", width: 1280, height: 820 },
  laptop: { label: "Laptop", width: 1000, height: 680 },
  phone: { label: "Phone", width: 390, height: 780 },
} as const;

type SizeId = keyof typeof SIZES;

/** Gap between panes, and the chrome a pane wears around its screen. */
const GAP = 14;
const BAR_H = 30;
const BORDER = 1;

export function Harness(): React.JSX.Element {
  const [count, setCount] = useState(4);
  const [size, setSize] = useState<SizeId>("laptop");
  /** Bumped on reset: remounts every pane against a freshly cleared token. */
  const [generation, setGeneration] = useState(0);
  const [code, setCode] = useState<string | null>(null);
  const [reports, setReports] = useState<Record<string, SeatReport>>({});
  /** Panes the user has pulled the plug on, to watch the table cope. */
  const [down, setDown] = useState<readonly number[]>([]);
  /** Bumped per seat to reload just that pane, token intact, so it resumes. */
  const [reloads, setReloads] = useState<Record<number, number>>({});
  const [focus, setFocus] = useState<number | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const onMessage = (event: MessageEvent): void => {
      if (event.origin !== location.origin) return;
      const data = event.data as Partial<SeatReport> | null;
      if (data === null || typeof data !== "object" || data.source !== "cambio-dev") return;
      const report = data as SeatReport;
      setReports((current) => ({ ...current, [report.seat]: report }));
      if (report.code !== null) setCode(report.code);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  const reset = useCallback(() => {
    // A pane resumes whatever seat its token names, which is what makes a
    // single reload a reconnection test. Opening a new table therefore means
    // forgetting the old tokens first, or six players would come back from
    // the dead into a room that no longer exists.
    for (let seat = 0; seat < MAX_PLAYERS; seat += 1) {
      try {
        sessionStorage.removeItem(seatTokenKey(String(seat)));
      } catch {
        /* storage blocked: the panes simply start fresh anyway */
      }
    }
    setCode(null);
    setReports({});
    setDown([]);
    setReloads({});
    setFocus(null);
    setGeneration((g) => g + 1);
  }, []);

  const seats = useMemo(() => Array.from({ length: count }, (_, index) => index), [count]);
  const shown = focus === null ? seats : seats.filter((seat) => seat === focus);

  const stage = useRef<HTMLDivElement>(null);
  const scale = useFitScale(stage, shown.length, SIZES[size]);

  const copy = async (): Promise<void> => {
    if (code === null) return;
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1_500);
    } catch {
      /* the code is on screen regardless */
    }
  };

  return (
    <div className="harness">
      <header className="harness__bar">
        <h1 className="harness__title">
          Cambio <span className="harness__titleTag">harness</span>
        </h1>

        <div className="harness__group">
          <span className="harness__label">Players</span>
          <div className="harness__seg" role="group">
            {Array.from({ length: MAX_PLAYERS - MIN_PLAYERS + 1 }, (_, i) => i + MIN_PLAYERS).map((n) => (
              <button
                key={n}
                type="button"
                className={`harness__segItem${n === count ? " is-on" : ""}`}
                aria-pressed={n === count}
                onClick={() => setCount(n)}
              >
                {n}
              </button>
            ))}
          </div>
        </div>

        <div className="harness__group">
          <span className="harness__label">Pane</span>
          <div className="harness__seg" role="group">
            {(Object.keys(SIZES) as SizeId[]).map((id) => (
              <button
                key={id}
                type="button"
                className={`harness__segItem${id === size ? " is-on" : ""}`}
                aria-pressed={id === size}
                onClick={() => setSize(id)}
              >
                {SIZES[id].label}
              </button>
            ))}
          </div>
        </div>

        <div className="harness__group">
          <span className="harness__label">Code</span>
          <button
            type="button"
            className="harness__code"
            onClick={copy}
            disabled={code === null}
            title="Copy it, to join from a real tab"
          >
            {code ?? "……"}
            {code !== null && <span className="harness__codeHint">{copied ? "copied" : "copy"}</span>}
          </button>
        </div>

        <div className="harness__spacer" />

        {focus !== null && (
          <button type="button" className="harness__button" onClick={() => setFocus(null)}>
            Show all
          </button>
        )}
        <a className="harness__button" href="/" target="_blank" rel="noreferrer">
          Plain tab
        </a>
        <button type="button" className="harness__button harness__button--go" onClick={reset}>
          New table
        </button>
      </header>

      <div className="harness__stage" ref={stage}>
        <div className="harness__grid" style={{ gap: `${GAP}px` }}>
          {shown.map((seat) => {
            const name = NAMES[seat] ?? `P${seat + 1}`;
            const report = reports[String(seat)];
            const isDown = down.includes(seat);
            const waiting = seat !== 0 && code === null;
            const screenW = SIZES[size].width * scale;
            const screenH = SIZES[size].height * scale;

            return (
              <section className="pane" key={`${generation}:${seat}`} style={{ width: screenW + 2 * BORDER }}>
                <header className="pane__bar" style={{ height: BAR_H }}>
                  <span className="pane__name">{name}</span>
                  {seat === 0 && <span className="pane__chip pane__chip--host">host</span>}
                  <span className="pane__chip">{phaseLabel(report, isDown, waiting)}</span>
                  <span className="pane__spacer" />
                  <button
                    type="button"
                    className="pane__action"
                    onClick={() => setFocus(focus === seat ? null : seat)}
                  >
                    {focus === seat ? "Shrink" : "Expand"}
                  </button>
                  <button
                    type="button"
                    className="pane__action"
                    disabled={isDown || waiting}
                    onClick={() => setReloads((current) => ({ ...current, [seat]: (current[seat] ?? 0) + 1 }))}
                    title="Reload this client; it resumes the same seat"
                  >
                    Reload
                  </button>
                  <button
                    type="button"
                    className="pane__action"
                    onClick={() =>
                      setDown((current) =>
                        current.includes(seat) ? current.filter((s) => s !== seat) : [...current, seat],
                      )
                    }
                    title={isDown ? "Reconnect this client" : "Pull the plug on this client"}
                  >
                    {isDown ? "Reconnect" : "Disconnect"}
                  </button>
                </header>

                <div className="pane__screen" style={{ height: screenH }}>
                  {isDown ? (
                    <p className="pane__note">Disconnected. The seat is held for its grace period.</p>
                  ) : waiting ? (
                    <p className="pane__note">Waiting for {NAMES[0]} to open the table&hellip;</p>
                  ) : (
                    <iframe
                      key={reloads[seat] ?? 0}
                      className="pane__frame"
                      title={`${name}'s screen`}
                      src={seatUrl(seat, name, code)}
                      style={{
                        width: SIZES[size].width,
                        height: SIZES[size].height,
                        transform: `scale(${scale})`,
                      }}
                    />
                  )}
                </div>
              </section>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/** The real client, told by its URL which player to be. */
function seatUrl(seat: number, name: string, code: string | null): string {
  const query = new URLSearchParams({ seat: String(seat), name });
  if (seat === 0) query.set("act", "create");
  else if (code !== null) query.set("code", code);
  return `/seat.html?${query.toString()}`;
}

function phaseLabel(report: SeatReport | undefined, isDown: boolean, waiting: boolean): string {
  if (isDown) return "offline";
  if (waiting) return "waiting";
  if (report === undefined) return "loading";
  if (report.status !== "open") return report.status;
  if (!report.seated) return "sitting down";
  return report.phase ?? "lobby";
}

/**
 * The largest scale at which every pane still fits the stage.
 *
 * Panes are laid out at a real viewport size and then scaled as a unit, so
 * each one reports the width the app's own breakpoints were written against -
 * shrinking the frames instead would have four panes all rendering the layout
 * meant for a phone.
 */
function useFitScale(
  stage: React.RefObject<HTMLDivElement | null>,
  panes: number,
  pane: { width: number; height: number },
): number {
  const [scale, setScale] = useState(0.5);

  useLayoutEffect(() => {
    const element = stage.current;
    if (element === null) return;

    const measure = (): void => {
      // The content box, not `clientHeight` - that includes the stage's own
      // padding, and counting it as room for panes is a row clipped off the
      // bottom of the screen.
      const style = getComputedStyle(element);
      const width = element.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
      const height = element.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
      if (width <= 0 || height <= 0 || panes === 0) return;

      // Try every column count and keep whichever fits largest: with six
      // panes, three columns of two beats two columns of three on a wide
      // screen and loses on a tall one, and there is no need to guess which.
      let best = 0;
      for (let columns = 1; columns <= panes; columns += 1) {
        const rows = Math.ceil(panes / columns);
        const cellWidth = (width - GAP * (columns - 1)) / columns - 2 * BORDER;
        const cellHeight = (height - GAP * (rows - 1)) / rows - BAR_H - 2 * BORDER;
        best = Math.max(best, Math.min(cellWidth / pane.width, cellHeight / pane.height));
      }
      setScale(Math.min(1, Math.max(0.18, best)));
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [stage, panes, pane.width, pane.height]);

  return scale;
}
