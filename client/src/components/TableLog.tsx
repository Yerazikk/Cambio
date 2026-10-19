import type { LogLine } from "../state/useGame.js";

export type TableLogProps = { lines: LogLine[] };

/**
 * The last few moves, in words.
 *
 * The animations on the cards say what happened the moment it happens; this is
 * for the half-second after, when you looked away or two things landed at once
 * and you want to know which card someone just turned over.
 */
export function TableLog({ lines }: TableLogProps): React.JSX.Element | null {
  if (lines.length === 0) return null;

  return (
    <ol className="tablelog" data-testid="table-log" aria-live="polite" aria-label="recent moves">
      {lines.map((line, index) => (
        <li key={line.id} className={`tablelog__line${index === lines.length - 1 ? " tablelog__line--latest" : ""}`}>
          {line.text}
        </li>
      ))}
    </ol>
  );
}
