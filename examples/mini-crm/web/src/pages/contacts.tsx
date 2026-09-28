/**
 * Contacts: a searchable table and a "New contact" dialog. Creating a contact reports
 * `contact.created`, which starts any workflow listening for it; the toast says which.
 *
 * @module
 */
import { Plus, Search, Users } from "lucide-react";
import { type FormEvent, type JSX, useEffect, useMemo, useState } from "react";
import { Link } from "react-router";
import { ApiError, api, type Contact, invalidate, runsStartedBy, useQuery, useUsers } from "../api";
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
        detail:
          runs.length === 0 ? (
            "No workflow listens for new contacts."
          ) : (
            <>
              Started{" "}
              {runs.map((r, i) => (
                <span key={r.id}>
                  {i > 0 && ", "}
                  <Link to={`/runs/${r.id}`}>{r.workflowId}</Link>
                </span>
              ))}
            </>
          ),
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
              </tr>
            </thead>
            <tbody>
              {!contacts.data && <SkeletonRows cols={5} />}
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
