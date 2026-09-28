import { X } from "lucide-react";
import { useCanvasUi, useLabels } from "./canvas-context";

/** The canvas' toast region (bottom center), announced politely to screen readers. */
export function Toasts() {
  const toasts = useCanvasUi((s) => s.toasts);
  const dismiss = useCanvasUi((s) => s.dismissToast);
  const labels = useLabels();
  return (
    <div className="fl-toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className="fl-toast">
          <span>{t.message}</span>
          {t.action && (
            <button
              type="button"
              className="fl-toast__action"
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
            className="fl-toast__close"
            aria-label={labels.dismiss}
            onClick={() => dismiss(t.id)}
          >
            <X size={14} aria-hidden />
          </button>
        </div>
      ))}
    </div>
  );
}
