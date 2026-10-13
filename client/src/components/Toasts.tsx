import type { Toast } from "../state/useGame.js";

export function Toasts({ toasts }: { toasts: Toast[] }): React.JSX.Element {
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((toast) => (
        <div key={toast.id} className={`toast toast--${toast.kind}`} data-testid="toast">
          {toast.text}
        </div>
      ))}
    </div>
  );
}
