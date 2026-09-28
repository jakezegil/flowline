/**
 * The CRM shell: sidebar navigation, theme switch and demo reset, around the routed pages.
 *
 * @module
 */
import { FlowlineProvider, type FlowlineTheme, useRunChanges } from "@flowline/react";
import {
  Activity,
  BadgeCheck,
  Blocks,
  Building2,
  CalendarClock,
  Contact,
  Handshake,
  Inbox,
  LogIn,
  Monitor,
  Moon,
  PanelLeft,
  RotateCcw,
  Route as RouteIcon,
  Sun,
  Users,
  Webhook,
  Workflow,
} from "lucide-react";
import { type JSX, type ReactNode, useEffect, useMemo, useState } from "react";
import { Navigate, NavLink, Route, Routes, useLocation } from "react-router";
import { api, flowline, invalidate, useQuery } from "./api";
import { ApprovalsPage } from "./pages/approvals";
import { ContactsPage } from "./pages/contacts";
import { DealsPage } from "./pages/deals";
import { OutboxPage } from "./pages/outbox";
import { RunsPage } from "./pages/runs";
import { WebhookTesterPage } from "./pages/webhook-tester";
import { WidgetHarnessPage } from "./pages/widget-harness";
import { WorkflowEditPage } from "./pages/workflow-edit";
import { WorkflowsPage } from "./pages/workflows";
import { Dialog, ToastProvider, useToast } from "./ui";
import { UserSelect } from "./widgets/user-select";

/** Custom config field widgets, by the `x-flowline.widget` name the server's plugin uses. */
const WIDGETS = { "crm.userSelect": UserSelect };

/**
 * Icons the manifest names that Flowline doesn't bundle (it bundles a common Lucide set and shows
 * a neutral box for anything else).
 */
const ICONS = {
  "badge-check": BadgeCheck,
  blocks: Blocks,
  "building-2": Building2,
  "calendar-clock": CalendarClock,
  contact: Contact,
  "log-in": LogIn,
  route: RouteIcon,
};

type ThemePref = "system" | "light" | "dark";
const THEME_KEY = "mini-crm:theme";

function readTheme(): ThemePref {
  try {
    const t = localStorage.getItem(THEME_KEY);
    return t === "light" || t === "dark" ? t : "system";
  } catch {
    return "system";
  }
}

/** The theme preference, applied to `<html data-theme>` and remembered per browser. */
function useThemePref(): [ThemePref, (t: ThemePref) => void] {
  const [pref, setPref] = useState<ThemePref>(readTheme);
  useEffect(() => {
    const root = document.documentElement;
    if (pref === "system") delete root.dataset.theme;
    else root.dataset.theme = pref;
    try {
      if (pref === "system") localStorage.removeItem(THEME_KEY);
      else localStorage.setItem(THEME_KEY, pref);
    } catch {
      // Storage can be unavailable (private mode); the choice then lasts for this visit.
    }
  }, [pref]);
  return [pref, setPref];
}

const THEME_OPTIONS: { value: ThemePref; label: string; icon: ReactNode }[] = [
  { value: "light", label: "Light", icon: <Sun size={14} aria-hidden /> },
  { value: "dark", label: "Dark", icon: <Moon size={14} aria-hidden /> },
  { value: "system", label: "System", icon: <Monitor size={14} aria-hidden /> },
];

function ThemeSwitch(props: { value: ThemePref; onChange(t: ThemePref): void }): JSX.Element {
  return (
    <fieldset className="theme-switch">
      <legend className="sr-only">Theme</legend>
      {THEME_OPTIONS.map((o) => (
        <label key={o.value} title={o.label} data-checked={props.value === o.value || undefined}>
          <input
            type="radio"
            name="theme"
            value={o.value}
            checked={props.value === o.value}
            onChange={() => props.onChange(o.value)}
            className="sr-only"
          />
          {o.icon}
          <span className="sr-only">{o.label}</span>
        </label>
      ))}
    </fieldset>
  );
}

function NavItem(props: {
  to: string;
  icon: ReactNode;
  label: string;
  count?: number | undefined;
}): JSX.Element {
  return (
    <NavLink to={props.to} className="nav__item" title={props.label}>
      <span className="nav__icon">{props.icon}</span>
      <span className="nav__label">{props.label}</span>
      {props.count ? (
        <span className="nav__count">
          {props.count}
          <span className="sr-only"> pending</span>
        </span>
      ) : null}
    </NavLink>
  );
}

function ResetDemo(): JSX.Element {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  return (
    <>
      <button
        type="button"
        className="nav__item nav__button"
        title="Reset demo data"
        onClick={() => setOpen(true)}
      >
        <span className="nav__icon">
          <RotateCcw size={16} aria-hidden />
        </span>
        <span className="nav__label">Reset demo data</span>
      </button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title="Reset demo data?"
        description="Cancels unfinished runs and restores the seed contacts and deals. The outbox and approvals are emptied. Workflows and past runs are kept."
      >
        <div className="dialog__foot">
          <button type="button" className="btn" onClick={() => setOpen(false)}>
            Keep data
          </button>
          <button
            type="button"
            className="btn btn--danger"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await api.reset();
                invalidate("all");
                toast({ tone: "success", title: "Demo data reset" });
                setOpen(false);
              } catch (err) {
                toast({ tone: "danger", title: "Couldn't reset", detail: String(err) });
              } finally {
                setBusy(false);
              }
            }}
          >
            Reset data
          </button>
        </div>
      </Dialog>
    </>
  );
}

function Sidebar(props: {
  theme: ThemePref;
  onTheme(t: ThemePref): void;
  collapsed: boolean;
  /** False when the rail is forced (editor, narrow window): no toggle then. */
  canExpand: boolean;
  onToggle(): void;
}): JSX.Element {
  const approvals = useQuery("approvals", api.listApprovals, 5000);
  // A run that starts or stops waiting (resumes, is cancelled or ends) changes the count: recount
  // at once. A first sighting (opening a run) is not a change.
  useRunChanges((run, previous) => {
    if (previous !== undefined && (previous === "waiting") !== (run.status === "waiting")) {
      invalidate("approvals");
    }
  });
  const pending = approvals.data?.filter((a) => a.status === "pending").length;
  return (
    <nav className="sidebar" aria-label="Main">
      <div className="sidebar__brand">
        <span className="brand-mark" aria-hidden>
          <svg viewBox="0 0 32 32" width="28" height="28" aria-hidden="true">
            <rect width="32" height="32" rx="8" fill="currentColor" />
            <path
              d="M9 21V11l7 6 7-6v10"
              fill="none"
              stroke="var(--c-accent-fg)"
              strokeWidth="2.6"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </span>
        <span className="sidebar__brand-text">
          <span className="sidebar__org">Acme Inc.</span>
          <span className="sidebar__product">Mini CRM</span>
        </span>
        {props.canExpand && (
          <button
            type="button"
            className="icon-btn sidebar__toggle"
            aria-label={props.collapsed ? "Expand sidebar" : "Collapse sidebar"}
            title={props.collapsed ? "Expand sidebar" : "Collapse sidebar"}
            onClick={props.onToggle}
          >
            <PanelLeft size={16} aria-hidden />
          </button>
        )}
      </div>

      <div className="nav">
        <p className="nav__group">Sales</p>
        <NavItem to="/contacts" icon={<Users size={16} aria-hidden />} label="Contacts" />
        <NavItem to="/deals" icon={<Handshake size={16} aria-hidden />} label="Deals" />

        <p className="nav__group">Automation</p>
        <NavItem to="/workflows" icon={<Workflow size={16} aria-hidden />} label="Workflows" />
        <NavItem to="/runs" icon={<Activity size={16} aria-hidden />} label="Runs" />
        <NavItem
          to="/approvals"
          icon={<BadgeCheck size={16} aria-hidden />}
          label="Approvals"
          count={pending}
        />
        <NavItem to="/outbox" icon={<Inbox size={16} aria-hidden />} label="Outbox" />
        <NavItem
          to="/webhook-tester"
          icon={<Webhook size={16} aria-hidden />}
          label="Webhook tester"
        />
      </div>

      <div className="sidebar__foot">
        <ResetDemo />
        <div className="sidebar__me">
          <span className="sidebar__me-text">
            <span className="sidebar__me-name">Demo user</span>
            <span className="sidebar__me-role">acme · no login</span>
          </span>
          <ThemeSwitch value={props.theme} onChange={props.onTheme} />
        </div>
      </div>
    </nav>
  );
}

/** Whether a media query matches, kept up to date. */
function useMedia(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const m = window.matchMedia(query);
    const on = () => setMatches(m.matches);
    on();
    m.addEventListener("change", on);
    return () => m.removeEventListener("change", on);
  }, [query]);
  return matches;
}

/** The whole app: providers, sidebar and routes. */
export function App(): JSX.Element {
  const [theme, setTheme] = useThemePref();
  const prefersDark = useMedia("(prefers-color-scheme: dark)");
  const narrow = useMedia("(max-width: 1100px)");
  const location = useLocation();
  const [userCollapsed, setUserCollapsed] = useState(false);
  // The editor wants every pixel, and narrow windows need the room: both get the icon rail.
  const fullBleed = /^\/workflows\/[^/]+/.test(location.pathname);
  const forced = fullBleed || narrow;
  const collapsed = userCollapsed || forced;
  const resolved = theme === "system" ? (prefersDark ? "dark" : "light") : theme;
  const flowlineTheme = useMemo<FlowlineTheme>(() => ({ colorMode: resolved }), [resolved]);

  return (
    <FlowlineProvider client={flowline} widgets={WIDGETS} icons={ICONS} theme={flowlineTheme}>
      <ToastProvider>
        <div className="shell" data-collapsed={collapsed || undefined}>
          <Sidebar
            theme={theme}
            onTheme={setTheme}
            collapsed={collapsed}
            canExpand={!forced}
            onToggle={() => setUserCollapsed((c) => !c)}
          />
          <main className="main" data-bleed={fullBleed || undefined}>
            <Routes>
              <Route path="/" element={<Navigate to="/contacts" replace />} />
              <Route path="/contacts" element={<ContactsPage />} />
              <Route path="/deals" element={<DealsPage />} />
              <Route path="/workflows" element={<WorkflowsPage />} />
              <Route path="/workflows/:id" element={<WorkflowEditPage />} />
              <Route path="/runs" element={<RunsPage />} />
              <Route path="/runs/:id" element={<RunsPage />} />
              <Route path="/approvals" element={<ApprovalsPage />} />
              <Route path="/outbox" element={<OutboxPage />} />
              <Route path="/webhook-tester" element={<WebhookTesterPage />} />
              <Route path="/dev/widgets" element={<WidgetHarnessPage />} />
              <Route path="*" element={<Navigate to="/contacts" replace />} />
            </Routes>
          </main>
        </div>
      </ToastProvider>
    </FlowlineProvider>
  );
}
