/**
 * A small toaster for the editor and run viewer: one notice at a time, bottom-center, announced
 * politely (errors assertively) to screen readers.
 *
 * @module
 */

import { CircleAlert, CircleCheck, X } from "lucide-react";
import {
  createContext,
  type JSX,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useFlowkitAppearance } from "../provider";

/** What a toast looks like: neutral, a success, or an error. */
export type ToastTone = "neutral" | "success" | "danger";

/** A notice to show. */
export interface ToastInput {
  message: string;
  tone?: ToastTone;
  action?: { label: string; run(): void };
}

interface ShownToast extends ToastInput {
  id: number;
}

/** How long a toast stays up (errors stay twice as long). */
const TOAST_MS = 5000;

const ToasterContext = createContext<((t: ToastInput) => void) | null>(null);

/** Shows a toast from anywhere inside a {@link ToasterProvider}. */
export function useToast(): (t: ToastInput) => void {
  const show = useContext(ToasterContext);
  if (!show) throw new Error("useToast must be used inside <ToasterProvider>");
  return show;
}

/** Holds the toast state and renders the toast region after `children`. */
export function ToasterProvider({ children }: { children: ReactNode }): JSX.Element {
  const [toast, setToast] = useState<ShownToast | null>(null);
  const next = useRef(1);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const show = useCallback((t: ToastInput) => {
    const id = next.current++;
    clearTimeout(timer.current);
    setToast({ ...t, id });
    timer.current = setTimeout(
      () => setToast((cur) => (cur?.id === id ? null : cur)),
      t.tone === "danger" ? TOAST_MS * 2 : TOAST_MS,
    );
  }, []);
  useEffect(() => () => clearTimeout(timer.current), []);
  const value = useMemo(() => show, [show]);
  return (
    <ToasterContext.Provider value={value}>
      {children}
      <ToastRegion toast={toast} onDismiss={() => setToast(null)} />
    </ToasterContext.Provider>
  );
}

function ToastRegion({ toast, onDismiss }: { toast: ShownToast | null; onDismiss(): void }) {
  const { labels } = useFlowkitAppearance();
  const danger = toast?.tone === "danger";
  return (
    <div
      className="fk-toasts fk-toasts--app"
      role="status"
      aria-live={danger ? "assertive" : "polite"}
    >
      {toast && (
        <div key={toast.id} className="fk-toast" data-tone={toast.tone ?? "neutral"}>
          {toast.tone === "success" && (
            <CircleCheck size={15} className="fk-toast__icon" aria-hidden />
          )}
          {danger && <CircleAlert size={15} className="fk-toast__icon" aria-hidden />}
          <span className="fk-toast__message">{toast.message}</span>
          {toast.action && (
            <button
              type="button"
              className="fk-toast__action"
              onClick={() => {
                toast.action?.run();
                onDismiss();
              }}
            >
              {toast.action.label}
            </button>
          )}
          <button
            type="button"
            className="fk-toast__close"
            aria-label={labels.dismiss}
            onClick={onDismiss}
          >
            <X size={14} aria-hidden />
          </button>
        </div>
      )}
    </div>
  );
}
