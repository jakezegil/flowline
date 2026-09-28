/**
 * Webhook tester: pick a webhook workflow, edit a JSON body (a sample lead to start with) and
 * POST it to the workflow's webhook URL, optionally with an `X-Request-Id` for deduplication.
 * Shows the response and links to the run it started.
 *
 * @module
 */
import type { WorkflowSummary } from "@flowkit/core/client";
import { ArrowUpRight, Dices, LoaderCircle, Send, Webhook } from "lucide-react";
import { type JSX, useEffect, useMemo, useState } from "react";
import { Link } from "react-router";
import { api, flowkit, invalidate, useQuery } from "../api";
import { Badge, CopyButton, EmptyState, ErrorState, PageHeader } from "../ui";

const SAMPLES = {
  enterprise: {
    label: "Enterprise lead",
    hint: "1,200 employees, so a manager must approve",
    body: {
      email: "hank@globex.test",
      firstName: "Hank",
      lastName: "Scorpio",
      company: "Globex",
      source: "referral",
      employees: 1200,
    },
  },
  smb: {
    label: "Small web lead",
    hint: "40 employees, gets the welcome email",
    body: {
      email: "marge@kwik-e-mart.test",
      firstName: "Marge",
      lastName: "Bouvier",
      company: "Kwik-E-Mart",
      source: "web",
      employees: 40,
    },
  },
} as const;
type SampleKey = keyof typeof SAMPLES;

const newRequestId = () => `req_${crypto.randomUUID().slice(0, 8)}`;
const pretty = (v: unknown) => JSON.stringify(v, null, 2);

interface Sent {
  status: number;
  ms: number;
  body: unknown;
  requestId: string | null;
}

/** The webhook tester page. */
export function WebhookTesterPage(): JSX.Element {
  const demo = useQuery("all", api.demo);
  const workflows = useQuery<WorkflowSummary[]>("runs", () => flowkit.listWorkflows());
  const hooks = useMemo(() => Object.entries(demo.data?.webhooks ?? {}), [demo.data]);
  const [workflowId, setWorkflowId] = useState<string | undefined>(undefined);
  const [sample, setSample] = useState<SampleKey>("enterprise");
  const [body, setBody] = useState(() => pretty(SAMPLES.enterprise.body));
  const [sendId, setSendId] = useState(true);
  const [requestId, setRequestId] = useState(newRequestId);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState<Sent | null>(null);
  const [netError, setNetError] = useState<string | null>(null);

  useEffect(() => {
    if (!workflowId && hooks[0]) setWorkflowId(hooks[0][0]);
  }, [hooks, workflowId]);

  const path = hooks.find(([id]) => id === workflowId)?.[1];
  const url = path ? `${location.origin}${path}` : "";
  const parseError = useMemo(() => {
    try {
      JSON.parse(body);
      return null;
    } catch (err) {
      return err instanceof Error ? err.message : "Invalid JSON";
    }
  }, [body]);
  const curl = [
    `curl -X POST '${url}'`,
    "-H 'content-type: application/json'",
    ...(sendId ? [`-H 'X-Request-Id: ${requestId}'`] : []),
    `-d '${body.replace(/\s*\n\s*/g, " ").replace(/'/g, "'\\''")}'`,
  ].join(" \\\n  ");

  function pickSample(key: SampleKey) {
    setSample(key);
    setBody(pretty(SAMPLES[key].body));
  }

  async function send() {
    if (!path || parseError) return;
    setSending(true);
    setNetError(null);
    const started = performance.now();
    const usedId = sendId ? requestId : null;
    try {
      const res = await fetch(path, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(usedId ? { "X-Request-Id": usedId } : {}),
        },
        body,
      });
      const text = await res.text();
      let parsed: unknown = text;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        // Not JSON: show the text.
      }
      setSent({
        status: res.status,
        ms: Math.round(performance.now() - started),
        body: parsed,
        requestId: usedId,
      });
      // A fresh ID for the next lead; "Reuse" below brings the old one back to try dedupe.
      if (usedId) setRequestId(newRequestId());
      invalidate("contacts");
      invalidate("approvals");
    } catch (err) {
      setNetError(err instanceof Error ? err.message : String(err));
    } finally {
      setSending(false);
    }
  }

  const runId =
    sent && typeof sent.body === "object" && sent.body && "runId" in sent.body
      ? String((sent.body as { runId: unknown }).runId)
      : undefined;
  const deduped =
    sent && typeof sent.body === "object" && sent.body && "deduped" in sent.body
      ? Boolean((sent.body as { deduped: unknown }).deduped)
      : false;

  if (demo.error && !demo.data) {
    return (
      <div className="page">
        <PageHeader title="Webhook tester" />
        <ErrorState message={demo.error} onRetry={demo.reload} />
      </div>
    );
  }

  return (
    <div className="page">
      <PageHeader
        title="Webhook tester"
        description="Play the role of another system: POST a JSON body to a workflow's webhook URL."
      />
      {demo.data && hooks.length === 0 ? (
        <div className="table-wrap">
          <EmptyState icon={<Webhook size={20} />} title="No webhook workflows are published">
            Publish a workflow with a Webhook trigger to test it here.
          </EmptyState>
        </div>
      ) : (
        <div className="tester">
          <section className="card tester__request" aria-labelledby="req-title">
            <h2 id="req-title" className="card__title">
              Request
            </h2>
            <label className="field">
              <span className="field__label">Workflow</span>
              <select
                className="input"
                value={workflowId ?? ""}
                onChange={(e) => setWorkflowId(e.target.value)}
              >
                {hooks.map(([id]) => (
                  <option key={id} value={id}>
                    {workflows.data?.find((w) => w.id === id)?.name ?? id}
                  </option>
                ))}
              </select>
            </label>
            <div className="field">
              <span className="field__label">URL</span>
              <div className="url">
                <Badge tone="accent">POST</Badge>
                <code className="url__text">{url || "Loading…"}</code>
                {url && <CopyButton text={url} label="Copy URL" />}
              </div>
              <span className="field__hint">
                Anyone with this URL can start the workflow. Treat it like a password.
              </span>
            </div>

            <div className="field">
              <span className="field__label">X-Request-Id</span>
              <div className="request-id">
                <label className="check">
                  <input
                    type="checkbox"
                    checked={sendId}
                    onChange={(e) => setSendId(e.target.checked)}
                  />
                  Send
                </label>
                <input
                  className="input input--mono"
                  aria-label="Request ID"
                  value={requestId}
                  disabled={!sendId}
                  onChange={(e) => setRequestId(e.target.value)}
                />
                <button
                  type="button"
                  className="icon-btn icon-btn--bordered"
                  aria-label="New request ID"
                  title="New request ID"
                  disabled={!sendId}
                  onClick={() => setRequestId(newRequestId())}
                >
                  <Dices size={15} aria-hidden />
                </button>
              </div>
              <span className="field__hint">
                A repeated ID starts nothing: the workflow deduplicates on it.
                {sent?.requestId && sent.requestId !== requestId && (
                  <>
                    {" "}
                    <button
                      type="button"
                      className="link-button"
                      onClick={() => sent.requestId && setRequestId(sent.requestId)}
                    >
                      Reuse {sent.requestId}
                    </button>{" "}
                    to try it.
                  </>
                )}
              </span>
            </div>

            <div className="field">
              <div className="field__label-row">
                <span className="field__label" id="body-label">
                  Body
                </span>
                <fieldset className="segmented" aria-label="Sample body">
                  {(Object.keys(SAMPLES) as SampleKey[]).map((k) => (
                    <button
                      key={k}
                      type="button"
                      aria-pressed={sample === k}
                      title={SAMPLES[k].hint}
                      onClick={() => pickSample(k)}
                    >
                      {SAMPLES[k].label}
                    </button>
                  ))}
                </fieldset>
              </div>
              <textarea
                className="code-input"
                aria-labelledby="body-label"
                spellCheck={false}
                rows={10}
                value={body}
                aria-invalid={parseError ? true : undefined}
                onChange={(e) => setBody(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault();
                    void send();
                  }
                }}
              />
              <span className="field__hint" data-error={parseError ? true : undefined}>
                {parseError ? `Not valid JSON: ${parseError}` : SAMPLES[sample].hint}
              </span>
            </div>

            <div className="tester__actions">
              <span className="muted tester__shortcut">⌘ Enter</span>
              <button
                type="button"
                className="btn btn--primary"
                disabled={!path || !!parseError || sending}
                onClick={send}
              >
                {sending ? (
                  <LoaderCircle size={15} aria-hidden className="spin" />
                ) : (
                  <Send size={15} aria-hidden />
                )}
                Send request
              </button>
            </div>
          </section>

          <section className="card tester__response" aria-labelledby="res-title" aria-live="polite">
            <h2 id="res-title" className="card__title">
              Response
            </h2>
            {netError && (
              <p className="form__error" role="alert">
                {netError}
              </p>
            )}
            {!sent && !netError && (
              <div className="tester__idle">
                <Send size={18} aria-hidden />
                <p>Send the request to see what the server answers.</p>
              </div>
            )}
            {sent && (
              <>
                <div className="response-meta">
                  <Badge tone={sent.status < 300 ? "success" : "danger"} dot>
                    {sent.status} {statusText(sent.status)}
                  </Badge>
                  <span className="muted">{sent.ms} ms</span>
                  {deduped && <Badge tone="warning">Deduplicated</Badge>}
                </div>
                <pre className="code-block">{pretty(sent.body)}</pre>
                {runId && (
                  <div className="response-next">
                    <p>
                      {deduped
                        ? "This request ID was seen before, so no new run started. This is the original run."
                        : "The workflow is running. Follow it step by step, including any approval it waits for."}
                    </p>
                    <Link to={`/runs/${runId}`} className="btn btn--primary">
                      Open run
                      <ArrowUpRight size={15} aria-hidden />
                    </Link>
                  </div>
                )}
              </>
            )}
            <details className="curl">
              <summary>Same request with cURL</summary>
              <div className="code-block code-block--copy">
                <pre>{curl}</pre>
                <CopyButton text={curl} label="Copy cURL command" />
              </div>
            </details>
          </section>
        </div>
      )}
    </div>
  );
}

function statusText(status: number): string {
  const texts: Record<number, string> = {
    200: "OK",
    202: "Accepted",
    400: "Bad Request",
    401: "Unauthorized",
    404: "Not Found",
    409: "Conflict",
    413: "Payload Too Large",
    415: "Unsupported Media Type",
    500: "Server Error",
  };
  return texts[status] ?? "";
}
