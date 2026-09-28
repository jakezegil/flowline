/**
 * Outbox: every email a workflow's "Send email" step sent (recorded, never delivered), as a
 * message list with a reading pane.
 *
 * @module
 */
import { Activity, Inbox } from "lucide-react";
import { type JSX, useState } from "react";
import { Link } from "react-router";
import { api, type OutboxMessage, useQuery, useWorkflowName } from "../api";
import {
  Avatar,
  Badge,
  EmptyState,
  ErrorState,
  fullTime,
  PageHeader,
  timeAgo,
  useNow,
} from "../ui";

/**
 * Whether `to` is one plausible email address. The outbox records whatever a step sent, so a
 * mapping that glued two values together (`"ava@acme.testava@acme.test"`) shows up here.
 */
export function isValidAddress(to: string): boolean {
  return /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>.]{2,}$/.test(to.trim());
}

const INVALID_TITLE =
  "Not a valid email address: a real mail server would reject it. Check the step's To mapping.";

function InvalidAddress(): JSX.Element {
  return (
    <Badge tone="warning" title={INVALID_TITLE}>
      Invalid address
    </Badge>
  );
}

/** Test steps run outside any run: their run IDs start with `test_` and have no run to open. */
const isTestRun = (m: OutboxMessage) => m.runId?.startsWith("test_") ?? false;

/** The workflow that sent `m`, linking to its run. */
function SentBy(props: { message: OutboxMessage }): JSX.Element | null {
  const workflowName = useWorkflowName();
  const { runId, workflowId } = props.message;
  if (!runId || !workflowId) return null;
  if (isTestRun(props.message)) {
    return (
      <span className="mail__sent-by muted">Sent by a test step in {workflowName(workflowId)}</span>
    );
  }
  return (
    <Link to={`/runs/${runId}`} className="btn btn--sm mail__sent-by">
      <Activity size={14} aria-hidden />
      {workflowName(workflowId)} run
    </Link>
  );
}

/** The outbox page. */
export function OutboxPage(): JSX.Element {
  const outbox = useQuery("outbox", api.listOutbox, 5000);
  const now = useNow();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const messages = outbox.data ?? [];
  const selected = messages.find((m) => m.id === selectedId) ?? messages[0];

  return (
    <div className="page page--fill">
      <PageHeader
        title="Outbox"
        count={outbox.data?.length}
        description="Emails your workflows sent. Nothing leaves this demo; messages are only recorded."
      />
      {outbox.error && !outbox.data ? (
        <ErrorState message={outbox.error} onRetry={outbox.reload} />
      ) : outbox.data && messages.length === 0 ? (
        <div className="table-wrap">
          <EmptyState
            icon={<Inbox size={20} />}
            title="No emails sent yet"
            action={
              <Link to="/webhook-tester" className="btn">
                Send a test lead
              </Link>
            }
          >
            A new lead gets a welcome email; a won deal over $10,000 gets a thank-you.
          </EmptyState>
        </div>
      ) : (
        <div className="mail">
          <ul className="mail__list" aria-label="Sent emails">
            {!outbox.data &&
              [0, 1, 2].map((i) => (
                <li key={i} className="mail__item mail__item--skeleton" aria-hidden>
                  <span className="skeleton" />
                  <span className="skeleton" />
                </li>
              ))}
            {messages.map((m) => (
              <li key={m.id}>
                <button
                  type="button"
                  className="mail__item"
                  aria-current={m.id === selected?.id ? "true" : undefined}
                  onClick={() => setSelectedId(m.id)}
                >
                  <span className="mail__row">
                    <span className="mail__to">{m.to}</span>
                    {!isValidAddress(m.to) && (
                      <span className="mail__flag">
                        <InvalidAddress />
                      </span>
                    )}
                    <span className="mail__time" title={fullTime(m.sentAt)}>
                      {timeAgo(m.sentAt, now)}
                    </span>
                  </span>
                  <span className="mail__subject">{m.subject}</span>
                  <span className="mail__snippet">{m.body.replace(/\s+/g, " ").slice(0, 90)}</span>
                </button>
              </li>
            ))}
          </ul>
          <article className="mail__pane" aria-label="Email">
            {selected && (
              <>
                <h2 className="mail__title">{selected.subject}</h2>
                <div className="mail__meta">
                  <Avatar name={selected.to} size={32} />
                  <div className="mail__meta-text">
                    <span>
                      <span className="muted">To </span>
                      {selected.to}
                      {!isValidAddress(selected.to) && (
                        <>
                          {" "}
                          <InvalidAddress />
                        </>
                      )}
                    </span>
                    <span className="muted">Sent {fullTime(selected.sentAt)}</span>
                  </div>
                  <SentBy message={selected} />
                </div>
                <div className="mail__body">{selected.body}</div>
                <p className="mail__foot muted">
                  Idempotency key <code>{selected.idempotencyKey}</code>. A retried step finds this
                  message instead of sending it twice.
                </p>
              </>
            )}
          </article>
        </div>
      )}
    </div>
  );
}
