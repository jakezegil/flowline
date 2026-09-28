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
import { type FlowkitNotice, type NotifyHandler, useFlowkitAppearance } from "../provider";

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

/**
 * Hands `notice` to the provider's `onNotify`, if any. `true` when the host took it (so Flowkit
 * shows nothing); `false` when Flowkit should show its own toast.
 */
export function notifyHost(onNotify: NotifyHandler | undefined, notice: FlowkitNotice): boolean {
  return onNotify !== undefined && onNotify(notice) !== false;
}

/**
 * Holds the toast state and renders the toast region after `children`. Notices go to the
 * provider's `onNotify` first; only those it leaves (none, or it returns `false`) show here.
 */
export function ToasterProvider({
  children,
  source = "editor",
}: {
  children: ReactNode;
  /** What `onNotify` is told raised the notices. */
  source?: FlowkitNotice["source"];
}): JSX.Element {
  const { onNotify } = useFlowkitAppearance();
  const notify = useRef(onNotify);
  notify.current = onNotify;
  const [toast, setToast] = useState<ShownToast | null>(null);
  const next = useRef(1);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const show = useCallback(
    (t: ToastInput) => {
      const notice: FlowkitNotice = {
        message: t.message,
        tone: t.tone ?? "neutral",
        source,
        ...(t.action ? { action: t.action } : {}),
      };
      if (notifyHost(notify.current, notice)) return;
      const id = next.current++;
      clearTimeout(timer.current);
      setToast({ ...t, id });
      timer.current = setTimeout(
        () => setToast((cur) => (cur?.id === id ? null : cur)),
        t.tone === "danger" ? TOAST_MS * 2 : TOAST_MS,
      );
    },
    [source],
  );
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
