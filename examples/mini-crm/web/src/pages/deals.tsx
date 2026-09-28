/**
 * Deals: the pipeline at a glance and a table whose stage select PATCHes the deal. Each change
 * reports `deal.updated`; rows show the latest workflow run a change of that deal started.
 *
 * @module
 */
import type { RunSummary } from "@flowkit/core/client";
import { Handshake } from "lucide-react";
import { type JSX, useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router";
import {
  ApiError,
  api,
  DEAL_STAGES,
  type Deal,
  type DealStage,
  flowkit,
  invalidate,
  runsStartedBy,
  useQuery,
  useUsers,
  useWorkflowName,
} from "../api";
import {
  Blank,
  EmptyState,
  ErrorState,
  formatMoney,
  PageHeader,
  RunBadge,
  SkeletonRows,
  UserChip,
  useToast,
} from "../ui";

const STAGE_LABELS: Record<DealStage, string> = {
  lead: "Lead",
  qualified: "Qualified",
  proposal: "Proposal",
  won: "Won",
  lost: "Lost",
};

const TERMINAL = new Set(["completed", "failed", "cancelled"]);

type DealTrigger = { deal?: { id?: string } } | null;
const dealIdOf = (trigger: unknown) => (trigger as DealTrigger)?.deal?.id;

/**
 * The latest run each deal's updates started, by deal ID: seeded from recent runs, extended as
 * this page changes deals, and refreshed while any of them is still going.
 */
function useDealRuns() {
  const [runs, setRuns] = useState<Record<string, RunSummary>>({});

  const load = useCallback(async () => {
    const recent = await flowkit.listRuns({ limit: 50 });
    const fromDeals = recent
      .filter((r) => r.startedBy.kind === "event" && r.startedBy.event === "deal.updated")
      .slice(0, 20);
    const details = await Promise.all(fromDeals.map((r) => flowkit.getRun(r.id)));
    const next: Record<string, RunSummary> = {};
    // Newest first, so the first run seen per deal is its latest.
    for (const d of details) {
      const id = dealIdOf(d.run.trigger);
      if (id && !next[id]) next[id] = d.run;
    }
    setRuns(next);
  }, []);

  useEffect(() => {
    load().catch(() => {});
  }, [load]);

  const live = Object.values(runs).some((r) => !TERMINAL.has(r.status));
  useEffect(() => {
    if (!live) return;
    const t = setInterval(() => load().catch(() => {}), 3000);
    return () => clearInterval(t);
  }, [live, load]);

  const add = useCallback((dealId: string, run: RunSummary) => {
    setRuns((prev) => ({ ...prev, [dealId]: run }));
  }, []);
  return { runs, add };
}

/** Pipeline value by stage, as one proportional bar with a legend underneath. */
function Pipeline(props: { deals: Deal[] }): JSX.Element {
  const totals = DEAL_STAGES.map((stage) => {
    const inStage = props.deals.filter((d) => d.stage === stage);
    return { stage, count: inStage.length, value: inStage.reduce((s, d) => s + d.amount, 0) };
  });
  const open = totals.filter((t) => t.stage !== "won" && t.stage !== "lost");
  const openValue = open.reduce((s, t) => s + t.value, 0);
  const all = totals.reduce((s, t) => s + t.value, 0) || 1;
  return (
    <section className="pipeline" aria-label="Pipeline by stage">
      <div className="pipeline__summary">
        <span className="pipeline__value">{formatMoney(openValue)}</span>
        <span className="pipeline__caption">
          open across {open.reduce((s, t) => s + t.count, 0)} deals
        </span>
      </div>
      <div className="pipeline__bar" aria-hidden>
        {totals.map(
          (t) =>
            t.value > 0 && (
              <span
                key={t.stage}
                className="pipeline__seg"
                data-stage={t.stage}
                style={{ flexGrow: t.value / all }}
              />
            ),
        )}
      </div>
      <dl className="pipeline__legend">
        {totals.map((t) => (
          <div key={t.stage} className="pipeline__item" data-stage={t.stage}>
            <dt>
              <span className="stage-dot" data-stage={t.stage} aria-hidden />
              {STAGE_LABELS[t.stage]}
              <span className="pipeline__count">{t.count}</span>
            </dt>
            <dd>{formatMoney(t.value)}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

/** The deals page. */
export function DealsPage(): JSX.Element {
  const deals = useQuery("deals", api.listDeals, 10_000);
  const contacts = useQuery("contacts", api.listContacts);
  const { users } = useUsers();
  const { runs, add } = useDealRuns();
  const workflowName = useWorkflowName();
  const toast = useToast();
  const [saving, setSaving] = useState<string | null>(null);

  const contactName = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of contacts.data ?? []) m.set(c.id, `${c.firstName} ${c.lastName}`);
    return m;
  }, [contacts.data]);

  async function moveStage(deal: Deal, stage: DealStage) {
    const before = deal.stage;
    deals.setData((ds) => ds?.map((d) => (d.id === deal.id ? { ...d, stage } : d)));
    setSaving(deal.id);
    const since = Date.now() - 2000;
    try {
      await api.updateDeal(deal.id, { stage });
      invalidate("deals");
      const started = await runsStartedBy(
        "deal.updated",
        since,
        (t) => dealIdOf(t) === deal.id,
      ).catch(() => []);
      const first = started[0];
      if (first) add(deal.id, first);
      toast({
        tone: "success",
        title: `${deal.name} moved to ${STAGE_LABELS[stage]}`,
        detail: first ? (
          <>
            Started <Link to={`/runs/${first.id}`}>{workflowName(first.workflowId)}</Link>
            {started.length > 1 ? ` and ${started.length - 1} more` : ""}.
          </>
        ) : (
          "No workflow ran for this change."
        ),
      });
    } catch (err) {
      deals.setData((ds) => ds?.map((d) => (d.id === deal.id ? { ...d, stage: before } : d)));
      toast({
        tone: "danger",
        title: "Couldn't change the stage",
        detail: err instanceof ApiError ? err.message : String(err),
      });
    } finally {
      setSaving(null);
    }
  }

  return (
    <div className="page">
      <PageHeader
        title="Deals"
        count={deals.data?.length}
        description="Changing a stage reports deal.updated. Mark a deal over $10,000 as won to start the follow-up workflow."
      />
      {deals.data && <Pipeline deals={deals.data} />}

      {deals.error && !deals.data ? (
        <ErrorState message={deals.error} onRetry={deals.reload} />
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Deal</th>
                <th>Contact</th>
                <th>Owner</th>
                <th className="num">Amount</th>
                <th>Stage</th>
                <th>Automation</th>
              </tr>
            </thead>
            <tbody>
              {!deals.data && <SkeletonRows cols={6} />}
              {deals.data?.map((d) => {
                const run = runs[d.id];
                return (
                  <tr key={d.id} data-stage={d.stage}>
                    <td className="strong">{d.name}</td>
                    <td>
                      {contactName.get(d.contactId) ?? <span className="muted">{d.contactId}</span>}
                    </td>
                    <td>
                      <UserChip user={users?.find((u) => u.id === d.ownerId)} />
                    </td>
                    <td className="num strong">{formatMoney(d.amount)}</td>
                    <td>
                      <span className="stage-select" data-stage={d.stage}>
                        <span className="stage-dot" data-stage={d.stage} aria-hidden />
                        <select
                          aria-label={`Stage of ${d.name}`}
                          value={d.stage}
                          disabled={saving === d.id}
                          onChange={(e) => moveStage(d, e.target.value as DealStage)}
                        >
                          {DEAL_STAGES.map((s) => (
                            <option key={s} value={s}>
                              {STAGE_LABELS[s]}
                            </option>
                          ))}
                        </select>
                      </span>
                    </td>
                    <td>
                      {run ? (
                        <span className="automation">
                          <RunBadge runId={run.id} status={run.status} />
                          <span className="automation__wf">{workflowName(run.workflowId)}</span>
                        </span>
                      ) : (
                        <Blank />
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {deals.data?.length === 0 && (
            <EmptyState icon={<Handshake size={20} />} title="No deals">
              Reset the demo data to bring back the sample pipeline.
            </EmptyState>
          )}
        </div>
      )}
    </div>
  );
}
