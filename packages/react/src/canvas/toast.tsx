import { X } from "lucide-react";
import { useEditorStore } from "../hooks";
import { useCanvasUi, useLabels } from "./canvas-context";

/** The canvas' toast region (bottom center), announced politely to screen readers. */
export function Toasts() {
  const toasts = useCanvasUi((s) => s.toasts);
  const dismiss = useCanvasUi((s) => s.dismissToast);
  const labels = useLabels();
  const readOnly = useEditorStore((s) => s.readOnly);
  const announcement = useCanvasUi((s) => s.announcement);
  return (
    <div className="fl-toasts" role="status" aria-live="polite">
      {announcement && (
        <span key={announcement.id} className="fl-sr-only" data-announcement>
          {announcement.message}
        </span>
      )}
      {toasts.map((t) => (
        <div key={t.id} className="fl-toast">
          <span>{t.message}</span>
          {t.action && !(readOnly && t.action.edits) && (
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
