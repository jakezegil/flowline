/**
 * Small UI pieces the CRM pages share: page header, avatar, badges, a modal dialog on the native
 * `<dialog>`, toasts, empty and error states, and formatters.
 *
 * @module
 */
import { Check, Copy, X } from "lucide-react";
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
import { Link } from "react-router";
import type { User } from "./api";

// ------------------------------------------------------------------ formatting

const money = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});
/** `48000` → `$48,000`. */
export const formatMoney = (n: number): string => money.format(n);

const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
/** `"3 minutes ago"`, `"yesterday"`, ... for an ISO string or epoch ms. */
export function timeAgo(at: string | number, now = Date.now()): string {
  const ms = typeof at === "string" ? Date.parse(at) : at;
  const s = Math.round((ms - now) / 1000);
  const abs = Math.abs(s);
  if (abs < 45) return "just now";
  if (abs < 3600) return rtf.format(Math.round(s / 60), "minute");
  if (abs < 86_400) return rtf.format(Math.round(s / 3600), "hour");
  if (abs < 30 * 86_400) return rtf.format(Math.round(s / 86_400), "day");
  return new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/** Full date and time, for `title` tooltips. */
export const fullTime = (at: string | number): string =>
  new Date(at).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });

/** Re-render every `ms` so relative times stay fresh. */
export function useNow(ms = 30_000): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

// ------------------------------------------------------------------ layout pieces

/** Title row of a page: title, optional count and description, actions on the right. */
export function PageHeader(props: {
  title: string;
  count?: number | undefined;
  description?: ReactNode;
  actions?: ReactNode;
}): JSX.Element {
  return (
    <header className="page-head">
      <div className="page-head__text">
        <h1 className="page-head__title">
          {props.title}
          {props.count !== undefined && <span className="page-head__count">{props.count}</span>}
        </h1>
        {props.description && <p className="page-head__desc">{props.description}</p>}
      </div>
      {props.actions && <div className="page-head__actions">{props.actions}</div>}
    </header>
  );
}

/** Centered message for an empty list, with an optional action. */
export function EmptyState(props: {
  icon: ReactNode;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}): JSX.Element {
  return (
    <div className="empty">
      <div className="empty__icon" aria-hidden>
        {props.icon}
      </div>
      <p className="empty__title">{props.title}</p>
      {props.children && <p className="empty__text">{props.children}</p>}
      {props.action}
    </div>
  );
}

/** A failed load, with a retry button. */
export function ErrorState(props: { message: string; onRetry(): void }): JSX.Element {
  return (
    <div className="empty" role="alert">
      <p className="empty__title">Couldn't load this page</p>
      <p className="empty__text">{props.message}</p>
      <button type="button" className="btn" onClick={props.onRetry}>
        Try again
      </button>
    </div>
  );
}

/** An empty table cell: a quiet dash, read as "None". */
export function Blank(): JSX.Element {
  return (
    <span className="muted">
      <span aria-hidden>–</span>
      <span className="sr-only">None</span>
    </span>
  );
}

/** Placeholder rows while a table loads. */
export function SkeletonRows(props: { rows?: number; cols: number }): JSX.Element {
  return (
    <>
      {Array.from({ length: props.rows ?? 6 }, (_, r) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: static placeholder rows
        <tr key={r} className="skeleton-row" aria-hidden>
          {Array.from({ length: props.cols }, (_, c) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: static placeholder cells
            <td key={c}>
              <span className="skeleton" />
            </td>
          ))}
        </tr>
      ))}
    </>
  );
}

// ------------------------------------------------------------------ people

const AVATAR_HUES = [250, 200, 160, 30, 330, 280, 100];

function hueOf(seed: string): number {
  let h = 0;
  for (const ch of seed) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return AVATAR_HUES[h % AVATAR_HUES.length] ?? 250;
}

/** Initials in a colored circle; the color is stable per `seed`. */
export function Avatar(props: { name: string; seed?: string; size?: number }): JSX.Element {
  const initials = props.name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase())
    .join("");
  const size = props.size ?? 22;
  return (
    <span
      className="avatar"
      aria-hidden
      style={{
        width: size,
        height: size,
        fontSize: Math.round(size * 0.42),
        ["--avatar-h" as string]: hueOf(props.seed ?? props.name),
      }}
    >
      {initials}
    </span>
  );
}

/** A user's avatar and name, or "Unassigned". */
export function UserChip(props: { user: User | undefined; fallback?: string }): JSX.Element {
  if (!props.user) {
    return <span className="muted">{props.fallback ?? "Unassigned"}</span>;
  }
  return (
    <span className="user-chip">
      <Avatar name={props.user.name} seed={props.user.id} />
      <span>{props.user.name}</span>
    </span>
  );
}

// ------------------------------------------------------------------ status

/** Color families shared by badges across the app. */
export type Tone = "neutral" | "accent" | "info" | "warning" | "success" | "danger";

/** A small colored label. `dot` adds a leading status dot (pulsing with `live`). */
export function Badge(props: {
  tone?: Tone;
  dot?: boolean;
  live?: boolean;
  children: ReactNode;
  title?: string;
}): JSX.Element {
  return (
    <span className="badge" data-tone={props.tone ?? "neutral"} title={props.title}>
      {props.dot && <span className="badge__dot" data-live={props.live || undefined} />}
      {props.children}
    </span>
  );
}

const RUN_TONES: Record<string, Tone> = {
  queued: "neutral",
  running: "info",
  waiting: "warning",
  completed: "success",
  failed: "danger",
  cancelled: "neutral",
};

const RUN_LABELS: Record<string, string> = {
  queued: "Queued",
  running: "Running",
  waiting: "Waiting",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
};

/** A run status as a badge, linking to the run. */
export function RunBadge(props: { runId: string; status: string; label?: string }): JSX.Element {
  const live = props.status === "running" || props.status === "queued";
  return (
    <Link to={`/runs/${props.runId}`} className="badge-link" title="Open run">
      <Badge tone={RUN_TONES[props.status] ?? "neutral"} dot live={live}>
        {props.label ?? RUN_LABELS[props.status] ?? props.status}
      </Badge>
    </Link>
  );
}

// ------------------------------------------------------------------ copy

/** An icon button that copies `text` and confirms with a check mark. */
export function CopyButton(props: { text: string; label?: string }): JSX.Element {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(t);
  }, [copied]);
  return (
    <button
      type="button"
      className="icon-btn"
      aria-label={props.label ?? "Copy"}
      title={copied ? "Copied" : (props.label ?? "Copy")}
      onClick={() => {
        void navigator.clipboard?.writeText(props.text).then(() => setCopied(true));
      }}
    >
      {copied ? <Check size={14} aria-hidden /> : <Copy size={14} aria-hidden />}
    </button>
  );
}

// ------------------------------------------------------------------ dialog

/**
 * A modal dialog on the native `<dialog>` (focus trap, Escape and the backdrop come for free).
 * Rendered only while `open`.
 */
export function Dialog(props: {
  open: boolean;
  onClose(): void;
  title: string;
  description?: string;
  children: ReactNode;
  width?: number;
}): JSX.Element | null {
  const ref = useRef<HTMLDialogElement>(null);
  const { open, onClose } = props;
  useEffect(() => {
    const d = ref.current;
    if (open && d && !d.open) d.showModal();
  }, [open]);
  if (!open) return null;
  return (
    <dialog
      ref={ref}
      className="dialog"
      style={{ width: props.width ?? 460 }}
      aria-labelledby="dialog-title"
      onClose={onClose}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onMouseDown={(e) => {
        // A press on the backdrop (the dialog element itself, outside its box) closes it.
        if (e.target === e.currentTarget) {
          const r = e.currentTarget.getBoundingClientRect();
          const inside =
            e.clientX >= r.left &&
            e.clientX <= r.right &&
            e.clientY >= r.top &&
            e.clientY <= r.bottom;
          if (!inside) onClose();
        }
      }}
    >
      <div className="dialog__head">
        <div>
          <h2 id="dialog-title" className="dialog__title">
            {props.title}
          </h2>
          {props.description && <p className="dialog__desc">{props.description}</p>}
        </div>
        <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>
          <X size={16} aria-hidden />
        </button>
      </div>
      {props.children}
    </dialog>
  );
}

// ------------------------------------------------------------------ toasts

interface Toast {
  id: number;
  tone: "success" | "danger" | "neutral";
  title: string;
  detail?: ReactNode | undefined;
}

type ToastInput = Omit<Toast, "id">;

const ToastContext = createContext<(t: ToastInput) => void>(() => {});

/** Show a toast: `toast({ tone: "success", title: "Contact created" })`. */
export const useToast = (): ((t: ToastInput) => void) => useContext(ToastContext);

/** Hosts the toast stack at the bottom right. */
export function ToastProvider(props: { children: ReactNode }): JSX.Element {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const next = useRef(1);
  const dismiss = useCallback((id: number) => setToasts((ts) => ts.filter((t) => t.id !== id)), []);
  const show = useCallback(
    (t: ToastInput) => {
      const id = next.current++;
      setToasts((ts) => [...ts.slice(-3), { ...t, id }]);
      setTimeout(() => dismiss(id), 6000);
    },
    [dismiss],
  );
  const value = useMemo(() => show, [show]);
  return (
    <ToastContext.Provider value={value}>
      {props.children}
      <ol className="toasts" aria-live="polite">
        {toasts.map((t) => (
          <li key={t.id} className="toast" data-tone={t.tone}>
            <div className="toast__body">
              <p className="toast__title">{t.title}</p>
              {t.detail && <div className="toast__detail">{t.detail}</div>}
            </div>
            <button
              type="button"
              className="icon-btn"
              aria-label="Dismiss"
              onClick={() => dismiss(t.id)}
            >
              <X size={14} aria-hidden />
            </button>
          </li>
        ))}
      </ol>
    </ToastContext.Provider>
  );
}
