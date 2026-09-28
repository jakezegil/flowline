/**
 * Workflows: every workflow with its trigger and published version, and a "New workflow" dialog
 * that picks a name and a trigger, saves the new workflow as a draft and opens the editor.
 *
 * @module
 */
import type { Manifest, WorkflowDoc } from "@flowkit/core";
import type { WorkflowSummary } from "@flowkit/core/client";
import { useFlowkit } from "@flowkit/react";
import { ChevronRight, Plus, Workflow } from "lucide-react";
import { type FormEvent, type JSX, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router";
import { flowkit, invalidate, useQuery } from "../api";
import {
  Badge,
  Dialog,
  EmptyState,
  ErrorState,
  fullTime,
  PageHeader,
  SkeletonRows,
  timeAgo,
  useNow,
} from "../ui";

type TriggerDef = Manifest["triggers"][number];

/** Workflow ID from a name: `"Big deal alert!"` → `"big-deal-alert"`. */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

/** A trigger's config with each property's schema default filled in. */
function defaultTriggerConfig(t: TriggerDef): WorkflowDoc["trigger"]["config"] {
  const props = (t.config.properties ?? {}) as Record<string, { default?: unknown }>;
  const config: WorkflowDoc["trigger"]["config"] = {};
  for (const [key, schema] of Object.entries(props)) {
    if (schema.default !== undefined) config[key] = schema.default as never;
  }
  return config;
}

function TriggerLabel(props: { type: string; manifest: Manifest | undefined }): JSX.Element {
  const { resolveIcon } = useFlowkit();
  const def = props.manifest?.triggers.find((t) => t.type === props.type);
  const Icon = resolveIcon(def?.icon);
  return (
    <span className="trigger-label">
      <span className="trigger-label__icon" aria-hidden>
        <Icon size={14} />
      </span>
      {def?.name ?? props.type}
    </span>
  );
}

function NewWorkflowDialog(props: {
  open: boolean;
  onClose(): void;
  manifest: Manifest | undefined;
  taken: Set<string>;
}): JSX.Element {
  const navigate = useNavigate();
  const { resolveIcon } = useFlowkit();
  const [name, setName] = useState("");
  const [idEdited, setIdEdited] = useState<string | null>(null);
  const [trigger, setTrigger] = useState("crm.dealUpdated");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const id = idEdited ?? slugify(name);
  const idError = !id
    ? undefined
    : !/^[a-z0-9][a-z0-9-_]*$/.test(id)
      ? "Use lowercase letters, digits, - and _."
      : props.taken.has(id)
        ? "A workflow with this ID exists."
        : undefined;
  const triggers = (props.manifest?.triggers ?? []).filter((t) => t.kind !== "subflow");

  // The workflow is saved as a draft before the editor opens, so it exists even if nobody
  // presses Save there.
  async function submit(e: FormEvent) {
    e.preventDefault();
    const def = props.manifest?.triggers.find((t) => t.type === trigger);
    if (!def || !id || idError || saving) return;
    const doc: WorkflowDoc = {
      id,
      name: name.trim() || "Untitled workflow",
      trigger: { type: def.type, config: defaultTriggerConfig(def) },
      steps: [],
    };
    setSaving(true);
    setSaveError(null);
    try {
      await flowkit.saveWorkflow(doc);
      invalidate("workflows");
      navigate(`/workflows/${id}`);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
      setSaving(false);
    }
  }

  return (
    <Dialog
      open={props.open}
      onClose={props.onClose}
      title="New workflow"
      description="Pick what starts it. You add the steps in the editor."
      width={560}
    >
      <form className="form" onSubmit={submit}>
        <div className="form__row form__row--wide">
          <label className="field">
            <span className="field__label">Name</span>
            <input
              className="input"
              required
              autoComplete="off"
              placeholder="Big deal alert"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <label className="field">
            <span className="field__label">ID</span>
            <input
              className="input input--mono"
              required
              autoComplete="off"
              placeholder="big-deal-alert"
              value={id}
              aria-invalid={idError ? true : undefined}
              onChange={(e) => setIdEdited(e.target.value)}
            />
          </label>
        </div>
        {idError && (
          <p className="form__error" role="alert">
            {idError}
          </p>
        )}
        <fieldset className="field">
          <legend className="field__label">Starts when</legend>
          <div className="choice-grid">
            {triggers.map((t) => {
              const Icon = resolveIcon(t.icon);
              return (
                <label
                  key={t.type}
                  className="choice"
                  data-checked={t.type === trigger || undefined}
                >
                  <input
                    type="radio"
                    name="trigger"
                    value={t.type}
                    checked={t.type === trigger}
                    onChange={() => setTrigger(t.type)}
                    className="sr-only"
                  />
                  <span className="choice__icon" aria-hidden>
                    <Icon size={16} />
                  </span>
                  <span className="choice__text">
                    <span className="choice__name">{t.name}</span>
                    {t.description && <span className="choice__desc">{t.description}</span>}
                  </span>
                </label>
              );
            })}
          </div>
        </fieldset>
        {saveError && (
          <p className="form__error" role="alert">
            Couldn't create the workflow: {saveError}
          </p>
        )}
        <div className="dialog__foot">
          <button type="button" className="btn" onClick={props.onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn--primary" disabled={!id || !!idError || saving}>
            {saving ? "Creating…" : "Create and open editor"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

/** The workflows page. */
export function WorkflowsPage(): JSX.Element {
  const workflows = useQuery<WorkflowSummary[]>("workflows", () => flowkit.listWorkflows());
  const manifest = useQuery<Manifest>("all", () => flowkit.getManifest());
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const now = useNow();
  const taken = useMemo(() => new Set(workflows.data?.map((w) => w.id)), [workflows.data]);
  // Sub-flows are building blocks other workflows call; list them after the top-level ones.
  const rows = useMemo(
    () =>
      [...(workflows.data ?? [])].sort(
        (a, b) =>
          Number(a.triggerType === "core.subflow") - Number(b.triggerType === "core.subflow") ||
          a.name.localeCompare(b.name),
      ),
    [workflows.data],
  );

  return (
    <div className="page">
      <PageHeader
        title="Workflows"
        count={workflows.data?.length}
        description="Automations that react to CRM changes, webhooks and schedules."
        actions={
          <button type="button" className="btn btn--primary" onClick={() => setOpen(true)}>
            <Plus size={15} aria-hidden />
            New workflow
          </button>
        }
      />
      {workflows.error && !workflows.data ? (
        <ErrorState message={workflows.error} onRetry={workflows.reload} />
      ) : (
        <div className="table-wrap">
          <table className="table table--clickable">
            <thead>
              <tr>
                <th>Workflow</th>
                <th>Trigger</th>
                <th>Status</th>
                <th className="num">Last saved</th>
                <th>
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {!workflows.data && <SkeletonRows cols={5} />}
              {rows.map((w) => {
                const draftAhead =
                  w.publishedVersion !== null && w.latestVersion > w.publishedVersion;
                return (
                  <tr key={w.id} onClick={() => navigate(`/workflows/${w.id}`)}>
                    <td>
                      <Link
                        to={`/workflows/${w.id}`}
                        className="row-link"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <span className="person__name">{w.name}</span>
                        <span className="person__sub mono">{w.id}</span>
                      </Link>
                    </td>
                    <td>
                      <TriggerLabel type={w.triggerType} manifest={manifest.data} />
                    </td>
                    <td>
                      <span className="badges">
                        {w.publishedVersion !== null ? (
                          <Badge
                            tone="success"
                            dot
                            title={
                              w.publishedAt ? `Published ${fullTime(w.publishedAt)}` : undefined
                            }
                          >
                            Live v{w.publishedVersion}
                          </Badge>
                        ) : (
                          <Badge>Not published</Badge>
                        )}
                        {draftAhead && <Badge tone="warning">Draft v{w.latestVersion}</Badge>}
                      </span>
                    </td>
                    <td className="num muted" title={fullTime(w.updatedAt)}>
                      {timeAgo(w.updatedAt, now)}
                    </td>
                    <td className="row-actions">
                      <Link
                        to={`/runs?workflow=${encodeURIComponent(w.id)}`}
                        className="btn btn--ghost btn--sm"
                        onClick={(e) => e.stopPropagation()}
                      >
                        Runs
                      </Link>
                      <ChevronRight size={16} aria-hidden className="muted" />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {workflows.data?.length === 0 && (
            <EmptyState
              icon={<Workflow size={20} />}
              title="No workflows yet"
              action={
                <button type="button" className="btn btn--primary" onClick={() => setOpen(true)}>
                  New workflow
                </button>
              }
            >
              Start one from a CRM event, a webhook or a schedule.
            </EmptyState>
          )}
        </div>
      )}
      {open && (
        <NewWorkflowDialog
          open={open}
          onClose={() => setOpen(false)}
          manifest={manifest.data}
          taken={taken}
        />
      )}
    </div>
  );
}
