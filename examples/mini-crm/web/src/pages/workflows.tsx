/**
 * Workflows: every workflow with its trigger and published version, and a "New workflow" dialog
 * that picks a workflow or a sub-flow, a name and a trigger, saves it as a draft and opens the
 * editor.
 *
 * @module
 */
import type { Manifest, WorkflowDoc } from "@flowline/core";
import type { WorkflowSummary } from "@flowline/core/client";
import { useFlowline } from "@flowline/react";
import { ChevronRight, Plus, Workflow } from "lucide-react";
import { type FormEvent, type JSX, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router";
import { flowline, invalidate, useQuery } from "../api";
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

/** What the New workflow dialog creates: a workflow that starts on its own, or a sub-flow. */
export type WorkflowKind = "workflow" | "subflow";

/** The triggers a new workflow of `kind` can start from, in manifest order. */
export function triggersFor(manifest: Manifest | undefined, kind: WorkflowKind): TriggerDef[] {
  return (manifest?.triggers ?? []).filter((t) => (t.kind === "subflow") === (kind === "subflow"));
}

/**
 * The trigger a new workflow starts from until one is picked: the app's own events (Contact
 * created, not the developer-facing core "App event"), else a webhook, else the first one.
 */
export function defaultTrigger(triggers: TriggerDef[]): TriggerDef | undefined {
  return (
    triggers.find((t) => t.kind === "event" && !t.type.startsWith("core.")) ??
    triggers.find((t) => t.kind === "webhook") ??
    triggers[0]
  );
}

const KINDS: { kind: WorkflowKind; name: string; desc: string; icon: string }[] = [
  {
    kind: "workflow",
    name: "Workflow",
    desc: "Runs on its own when something happens: a CRM change, a webhook, a schedule or a click.",
    icon: "workflow",
  },
  {
    kind: "subflow",
    name: "Sub-flow",
    desc: 'A reusable piece, like "Get or create contact", that other workflows run with a Run sub-flow step. It takes inputs and returns an output.',
    icon: "log-in",
  },
];

/** Longest generated workflow ID. */
const MAX_ID = 48;

/**
 * Workflow ID from a name: `"Big deal alert!"` → `"big-deal-alert"`. A long name is cut at the
 * last whole word that fits in {@link MAX_ID} characters (a single longer word is cut hard).
 */
export function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (slug.length <= MAX_ID) return slug;
  const cut = slug.slice(0, MAX_ID + 1).lastIndexOf("-");
  return cut > 0 ? slug.slice(0, cut) : slug.slice(0, MAX_ID);
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
  const { resolveIcon } = useFlowline();
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

/** The New workflow dialog: a workflow or a sub-flow, its name and ID, and its trigger. */
export function NewWorkflowDialog(props: {
  open: boolean;
  onClose(): void;
  manifest: Manifest | undefined;
  taken: Set<string>;
}): JSX.Element {
  const navigate = useNavigate();
  const { resolveIcon } = useFlowline();
  const [name, setName] = useState("");
  const [idEdited, setIdEdited] = useState<string | null>(null);
  const [kind, setKind] = useState<WorkflowKind>("workflow");
  const [picked, setPicked] = useState<string | null>(null);
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
  const triggers = triggersFor(props.manifest, kind);
  // The default trigger of the kind until one is picked (and again after switching kinds).
  const trigger = (triggers.find((t) => t.type === picked) ?? defaultTrigger(triggers))?.type;
  const noun = kind === "subflow" ? "sub-flow" : "workflow";

  // The workflow is saved as a draft before the editor opens, so it exists even if nobody
  // presses Save there.
  async function submit(e: FormEvent) {
    e.preventDefault();
    const def = props.manifest?.triggers.find((t) => t.type === trigger);
    if (!def || !id || idError || saving) return;
    const doc: WorkflowDoc = {
      id,
      name: name.trim() || `Untitled ${noun}`,
      trigger: { type: def.type, config: defaultTriggerConfig(def) },
      steps: [],
    };
    setSaving(true);
    setSaveError(null);
    try {
      await flowline.saveWorkflow(doc);
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
      title={kind === "subflow" ? "New sub-flow" : "New workflow"}
      description={
        kind === "subflow"
          ? "Name it here. In the editor you declare its inputs and output and add its steps."
          : "Pick what starts it. You add the steps in the editor."
      }
      width={560}
    >
      <form className="form" onSubmit={submit}>
        <fieldset className="field">
          <legend className="field__label">Create</legend>
          <div className="choice-grid">
            {KINDS.map((k) => {
              const Icon = resolveIcon(k.icon);
              return (
                <label key={k.kind} className="choice" data-checked={k.kind === kind || undefined}>
                  <input
                    type="radio"
                    name="kind"
                    value={k.kind}
                    checked={k.kind === kind}
                    onChange={() => setKind(k.kind)}
                    className="sr-only"
                  />
                  <span className="choice__icon" aria-hidden>
                    <Icon size={16} />
                  </span>
                  <span className="choice__text">
                    <span className="choice__name">{k.name}</span>
                    <span className="choice__desc">{k.desc}</span>
                  </span>
                </label>
              );
            })}
          </div>
        </fieldset>
        <div className="form__row form__row--wide">
          <label className="field">
            <span className="field__label">Name</span>
            <input
              className="input"
              required
              autoComplete="off"
              placeholder={kind === "subflow" ? "Get or create contact" : "Big deal alert"}
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
              placeholder={kind === "subflow" ? "get-or-create-contact" : "big-deal-alert"}
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
        {/* A sub-flow starts when another workflow runs it: with one sub-flow trigger there's
            nothing to pick. */}
        {(kind === "workflow" || triggers.length > 1) && (
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
                      onChange={() => setPicked(t.type)}
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
        )}
        {triggers.length === 0 && (
          <p className="form__error" role="alert">
            {props.manifest
              ? `This app has no ${noun} trigger, so a ${noun} can't be created here.`
              : "Loading triggers…"}
          </p>
        )}
        {saveError && (
          <p className="form__error" role="alert">
            Couldn't create the {noun}: {saveError}
          </p>
        )}
        <div className="dialog__foot">
          <button type="button" className="btn" onClick={props.onClose}>
            Cancel
          </button>
          <button
            type="submit"
            className="btn btn--primary"
            disabled={!id || !!idError || !trigger || saving}
          >
            {saving ? "Creating…" : "Create and open editor"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

/** The workflows page. */
export function WorkflowsPage(): JSX.Element {
  const workflows = useQuery<WorkflowSummary[]>("workflows", () => flowline.listWorkflows());
  const manifest = useQuery<Manifest>("static", () => flowline.getManifest());
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
