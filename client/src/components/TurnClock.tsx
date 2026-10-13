import { useEffect, useState } from "react";

/** Counts the current turn down, so a stalled table is visible to everyone. */
export function TurnClock({ endsAt }: { endsAt: number | null }): React.JSX.Element | null {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (endsAt === null) return;
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, [endsAt]);

  if (endsAt === null) return null;

  const remaining = Math.max(0, endsAt - now);
  const seconds = Math.ceil(remaining / 1000);
  return (
    <span className={`clock${remaining < 10_000 ? " clock--urgent" : ""}`} data-testid="turn-clock">
      {seconds}s
    </span>
  );
}
