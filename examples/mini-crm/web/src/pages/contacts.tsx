/**
 * Contacts: a searchable table and a "New contact" dialog. Creating a contact reports
 * `contact.created`, which starts any workflow listening for it; the toast says which. Each row
 * can also log a finished AI or VoIP call, which reports `ai_call.ended` or `voip_call.ended`.
 *
 * @module
 */
import type { RunSummary } from "@flowlinejs/core/client";
import { Bot, Phone, Plus, Search, Sparkles, Users, X } from "lucide-react";
import { type FormEvent, type JSX, type ReactNode, useEffect, useMemo, useState } from "react";
import { Link } from "react-router";
import {
  ApiError,
  api,
  type CallKind,
  type Contact,
  invalidate,
  type NewCall,
  runsStartedBy,
  useQuery,
  useUsers,
} from "../api";
import {
  Avatar,
  Badge,
  Blank,
  Dialog,
  EmptyState,
  ErrorState,
  fullTime,
  PageHeader,
  SkeletonRows,
  timeAgo,
  UserChip,
  useNow,
  useToast,
} from "../ui";

const SOURCES = ["web", "referral", "event", "outbound"] as const;

const WELCOME_KEY = "mini-crm.welcome-dismissed";

/**
 * The first page a visitor lands on is Contacts: point them at where the automations are, until
 * they dismiss it (remembered in this browser).
 */
export function WelcomeHint(): JSX.Element | null {
  const [hidden, setHidden] = useState(() => {
    try {
      return localStorage.getItem(WELCOME_KEY) === "1";
    } catch {
      return false;
    }
  });
  if (hidden) return null;
  function dismiss() {
    setHidden(true);
    try {
      localStorage.setItem(WELCOME_KEY, "1");
    } catch {
      // Private mode: it comes back on the next visit.
    }
  }
  return (
    <aside className="welcome" aria-label="Getting started">
      <Sparkles size={16} aria-hidden className="welcome__icon" />
      <p className="welcome__text">
        <strong>New here?</strong> Automations live in <Link to="/workflows">Workflows</Link>. To
        watch one run, send a sample lead from the <Link to="/webhook-tester">Webhook tester</Link>{" "}
        and follow it in <Link to="/runs">Runs</Link>.
      </p>
      <button
        type="button"
        className="icon-btn"
        aria-label="Dismiss"
        title="Dismiss"
        onClick={dismiss}
      >
        <X size={14} aria-hidden />
      </button>
    </aside>
  );
}

/** Links to the runs a CRM change started, for a toast. */
function startedRuns(runs: RunSummary[], none: string): ReactNode {
  if (runs.length === 0) return none;
  return (
    <>
      Started{" "}
      {runs.map((r, i) => (
        <span key={r.id}>
          {i > 0 && ", "}
          <Link to={`/runs/${r.id}`}>{r.workflowId}</Link>
        </span>
      ))}
    </>
  );
}

/** The sample call each button logs: what the AI agent or the phone system would report. */
const SAMPLE_CALLS: Record<CallKind, { label: string; call: Omit<NewCall, "contactId"> }> = {
  ai: {
    label: "AI",
    call: { kind: "ai", durationSec: 95, summary: "Asked about pricing for the team plan." },
  },
  voip: { label: "VoIP", call: { kind: "voip", durationSec: 240 } },
};

/**
 * "Log AI call" and "Log VoIP call" for one contact: each posts a finished sample call, which the
 * CRM reports as `ai_call.ended` or `voip_call.ended`; the toast links the runs it started.
 */
export function CallButtons(props: {
  contact: Pick<Contact, "id" | "firstName" | "lastName">;
}): JSX.Element {
  const toast = useToast();
  const [busy, setBusy] = useState<CallKind | null>(null);
  const name = `${props.contact.firstName} ${props.contact.lastName}`;

  async function log(kind: CallKind) {
    const { label, call } = SAMPLE_CALLS[kind];
    setBusy(kind);
    const since = Date.now() - 2000;
    try {
      const logged = await api.logCall({ contactId: props.contact.id, ...call });
      const runs = await runsStartedBy(
        kind === "ai" ? "ai_call.ended" : "voip_call.ended",
        since,
        (t) => (t as { call?: { id?: string } } | null)?.call?.id === logged.id,
      ).catch(() => []);
      toast({
        tone: "success",
        title: `${label} call with ${name} logged`,
        detail: startedRuns(runs, "No workflow started for this call."),
      });
    } catch (err) {
      toast({
        tone: "danger",
        title: `Couldn't log the ${label} call`,
        detail: err instanceof ApiError ? err.message : String(err),
      });
    } finally {
      setBusy(null);
    }
  }

  return (
    <span className="row-actions">
      {(["ai", "voip"] as const).map((kind) => (
        <button
          key={kind}
          type="button"
          className="btn btn--sm"
          aria-label={`Log ${SAMPLE_CALLS[kind].label} call with ${name}`}
          title={`Log a finished ${SAMPLE_CALLS[kind].label} call with ${name}`}
          disabled={busy !== null}
          onClick={() => log(kind)}
        >
          {kind === "ai" ? <Bot size={13} aria-hidden /> : <Phone size={13} aria-hidden />}
          {SAMPLE_CALLS[kind].label} call
        </button>
      ))}
    </span>
  );
}

function NewContactDialog(props: { open: boolean; onClose(): void }): JSX.Element {
  const { users } = useUsers();
  const toast = useToast();
  const [error, setError] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  // The dialog stays mounted while closed: start each opening without the last one's error.
  useEffect(() => {
    if (props.open) setError(undefined);
  }, [props.open]);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const text = (k: string) => String(form.get(k) ?? "").trim();
    setBusy(true);
    setError(undefined);
    const since = Date.now() - 2000;
    try {
      const contact = await api.createContact({
        firstName: text("firstName"),
        lastName: text("lastName"),
        email: text("email"),
        company: text("company"),
        source: text("source"),
        ownerId: text("ownerId") || null,
      });
      invalidate("contacts");
      props.onClose();
      const runs = await runsStartedBy(
        "contact.created",
        since,
        (t) => (t as { contact?: Contact } | null)?.contact?.id === contact.id,
      ).catch(() => []);
      toast({
        tone: "success",
        title: `${contact.firstName} ${contact.lastName} added`,
        detail: startedRuns(runs, "No workflow listens for new contacts."),
      });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={props.open}
      onClose={props.onClose}
      title="New contact"
      description="Adding a contact reports a contact.created event to your workflows."
    >
      <form className="form" onSubmit={submit}>
        <div className="form__row">
          <label className="field">
            <span className="field__label">First name</span>
            <input name="firstName" required autoComplete="off" className="input" />
          </label>
          <label className="field">
            <span className="field__label">Last name</span>
            <input name="lastName" required autoComplete="off" className="input" />
          </label>
        </div>
        <label className="field">
          <span className="field__label">Email</span>
          <input name="email" type="email" required autoComplete="off" className="input" />
        </label>
        <label className="field">
          <span className="field__label">Company</span>
          <input name="company" autoComplete="off" className="input" />
        </label>
        <div className="form__row">
          <label className="field">
            <span className="field__label">Source</span>
            <select name="source" className="input" defaultValue="web">
              {SOURCES.map((s) => (
                <option key={s} value={s}>
                  {s[0]?.toUpperCase() + s.slice(1)}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span className="field__label">Owner</span>
            <select name="ownerId" className="input" defaultValue="">
              <option value="">Unassigned</option>
              {users?.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                </option>
              ))}
            </select>
          </label>
        </div>
        {error && (
          <p className="form__error" role="alert">
            {error}
          </p>
        )}
        <div className="dialog__foot">
          <button type="button" className="btn" onClick={props.onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn--primary" disabled={busy}>
            {busy ? "Adding…" : "Add contact"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

/** The contacts page. */
export function ContactsPage(): JSX.Element {
  const contacts = useQuery("contacts", api.listContacts, 10_000);
  const { users } = useUsers();
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const now = useNow();

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    const all = contacts.data ?? [];
    if (!q) return all;
    return all.filter((c) =>
      `${c.firstName} ${c.lastName} ${c.email} ${c.company}`.toLowerCase().includes(q),
    );
  }, [contacts.data, query]);

  return (
    <div className="page">
      <PageHeader
        title="Contacts"
        count={contacts.data?.length}
        description="People your team sells to. New contacts can start workflows."
        actions={
          <button type="button" className="btn btn--primary" onClick={() => setOpen(true)}>
            <Plus size={15} aria-hidden />
            New contact
          </button>
        }
      />
      <WelcomeHint />
      <div className="toolbar">
        <label className="search">
          <Search size={14} aria-hidden />
          <input
            type="search"
            placeholder="Search name, email or company"
            aria-label="Search contacts"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
      </div>

      {contacts.error && !contacts.data ? (
        <ErrorState message={contacts.error} onRetry={contacts.reload} />
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Company</th>
                <th>Source</th>
                <th>Owner</th>
                <th className="num">Added</th>
                <th className="num">Log a call</th>
              </tr>
            </thead>
            <tbody>
              {!contacts.data && <SkeletonRows cols={6} />}
              {rows.map((c) => (
                <tr key={c.id}>
                  <td>
                    <span className="person">
                      <Avatar name={`${c.firstName} ${c.lastName}`} seed={c.id} size={28} />
                      <span className="person__text">
                        <span className="person__name">
                          {c.firstName} {c.lastName}
                        </span>
                        <span className="person__sub">{c.email}</span>
                      </span>
                    </span>
                  </td>
                  <td>{c.company || <Blank />}</td>
                  <td>{c.source ? <Badge>{c.source}</Badge> : <Blank />}</td>
                  <td>
                    <UserChip user={users?.find((u) => u.id === c.ownerId)} />
                  </td>
                  <td className="num muted" title={fullTime(c.createdAt)}>
                    {timeAgo(c.createdAt, now)}
                  </td>
                  <td>
                    <CallButtons contact={c} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {contacts.data && rows.length === 0 && (
            <EmptyState
              icon={<Users size={20} />}
              title={query ? "No contacts match" : "No contacts yet"}
              action={
                query ? (
                  <button type="button" className="btn" onClick={() => setQuery("")}>
                    Clear search
                  </button>
                ) : undefined
              }
            >
              {query
                ? `Nothing matches "${query}".`
                : "Add one, or send a lead from the webhook tester."}
            </EmptyState>
          )}
        </div>
      )}
      <NewContactDialog open={open} onClose={() => setOpen(false)} />
    </div>
  );
}
