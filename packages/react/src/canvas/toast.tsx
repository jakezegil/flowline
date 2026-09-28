import { X } from "lucide-react";
import { useCanvasUi } from "./canvas-context";

/** The canvas' toast region (bottom center), announced politely to screen readers. */
export function Toasts() {
  const toasts = useCanvasUi((s) => s.toasts);
  const dismiss = useCanvasUi((s) => s.dismissToast);
  return (
    <div className="fk-toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className="fk-toast">
          <span>{t.message}</span>
          {t.action && (
            <button
              type="button"
              className="fk-toast__action"
              onClick={() => {
                t.action?.run();
                dismiss(t.id);
              }}
            >
              {t.action.label}
            </button>
          )}
          <button
            type="button"
            className="fk-toast__close"
            aria-label="Dismiss"
            onClick={() => dismiss(t.id)}
          >
            <X size={14} aria-hidden />
          </button>
        </div>
      ))}
    </div>
  );
}
