/**
 * Widgets backed by the server: `"secret"` (names from `client.listSecrets()`),
 * `"subflowSelect"` (callable workflows from `client.listSubflows()`) and `"subflowInput"` (a
 * form for the chosen sub-flow's input schema).
 *
 * @module
 */
import type { SubflowInfo } from "@flowlinejs/core";
import type { FlowlineClient } from "@flowlinejs/core/client";
import { KeyRound, RotateCw } from "lucide-react";
import { type JSX, useContext, useEffect, useId, useState, useSyncExternalStore } from "react";
import { EditorContext } from "../../hooks";
import { useFlowline, useFlowlineAppearance } from "../../provider";
import { errorText } from "../../ui/primitives";
import { FieldShell } from "../fields/shell";
import { type FieldProps, useFormEnv } from "../form-context";
import { issuesAt, issuesUnder, metaOf, propertiesOf } from "../schema";
import { asObject, NestedForm, ObjectFields, withKey } from "../schema-form";

type ListKey = "secrets" | "subflows";
type Entry = { promise: Promise<unknown>; at: number };
const cache = new WeakMap<FlowlineClient, Map<ListKey, Entry>>();
/** A cached list older than this is fetched again when a field needing it mounts or is focused. */
const STALE_MS = 15_000;

/**
 * A list from the server, shared by every field that needs it. It is fetched again when a field
 * mounts or its control is focused (`refresh`) and the cached copy is older than a few seconds, so
 * a secret or sub-flow added meanwhile shows up without a reload. The old list stays shown while
 * the new one loads.
 */
function useServerList<T>(
  key: ListKey,
  load: (c: FlowlineClient) => Promise<T>,
): { data?: T; error?: string; retry(): void; refresh(): void } {
  const { client } = useFlowline();
  const [state, setState] = useState<{ data?: T; error?: string }>({});
  const [attempt, setAttempt] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` re-runs the load on retry and refresh.
  useEffect(() => {
    let active = true;
    let byKey = cache.get(client);
    if (!byKey) {
      byKey = new Map();
      cache.set(client, byKey);
    }
    let entry = byKey.get(key);
    if (!entry || Date.now() - entry.at > STALE_MS) {
      entry = { promise: load(client), at: Date.now() };
      byKey.set(key, entry);
    }
    const mine = entry;
    (mine.promise as Promise<T>).then(
      (data) => active && setState({ data }),
      (err: unknown) => {
        if (byKey?.get(key) === mine) byKey.delete(key);
        if (active) setState((prev) => ({ ...prev, error: errorText(err) }));
      },
    );
    return () => {
      active = false;
    };
  }, [client, key, attempt]);
  return {
    ...state,
    retry: () => setAttempt((n) => n + 1),
    refresh() {
      const entry = cache.get(client)?.get(key);
      if (!entry || Date.now() - entry.at > STALE_MS) setAttempt((n) => n + 1);
    },
  };
}

function LoadError({ message, retry }: { message: string; retry(): void }): JSX.Element {
  const { labels } = useFlowlineAppearance();
  return (
    <p className="fl-f__local fl-load-error">
      {labels.loadFailed(message)}
      <button type="button" className="fl-link-btn" onClick={retry}>
        <RotateCw size={12} aria-hidden />
        {labels.tryAgain}
      </button>
    </p>
  );
}

/** The `"secret"` widget: a choice of configured secret names (never values). */
export function SecretWidget(p: FieldProps): JSX.Element {
  const env = useFormEnv();
  const { labels } = useFlowlineAppearance();
  const id = useId();
  const secrets = useServerList("secrets", (c) => c.listSecrets());
  const value = typeof p.value === "string" ? p.value : "";
  const names = secrets.data ?? [];
  const missing = value !== "" && secrets.data !== undefined && !names.includes(value);
  return (
    <FieldShell
      label={p.label}
      required={p.required}
      description={p.schema.description as string | undefined}
      issues={issuesUnder(env.issues, p.path)}
      htmlFor={id}
      bare={p.bare}
    >
      {secrets.error !== undefined ? (
        <>
          <input
            id={id}
            className="fl-input fl-input--code"
            value={value}
            placeholder={labels.chooseSecret}
            readOnly={env.readOnly}
            onChange={(e) => p.onChange(e.target.value === "" ? undefined : e.target.value)}
          />
          <LoadError message={secrets.error} retry={secrets.retry} />
        </>
      ) : (
        <div className="fl-select-wrap">
          <KeyRound size={14} className="fl-select-wrap__icon" aria-hidden />
          <select
            id={id}
            className="fl-input fl-select fl-select--icon"
            value={value}
            disabled={env.readOnly || secrets.data === undefined}
            aria-invalid={missing || undefined}
            onFocus={secrets.refresh}
            onChange={(e) => p.onChange(e.target.value === "" ? undefined : e.target.value)}
          >
            {secrets.data === undefined ? (
              <option value={value}>{value || labels.loading}</option>
            ) : (
              <>
                <option value="">
                  {names.length === 0 ? labels.noSecrets : labels.chooseSecret}
                </option>
                {missing && <option value={value}>{labels.secretMissing(value)}</option>}
                {names.map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </>
            )}
          </select>
        </div>
      )}
    </FieldShell>
  );
}

const noSubscribe = () => () => {};

/** The current workflow's ID, when inside an editor (a workflow can't call itself). */
function useCurrentWorkflowId(): string | undefined {
  const store = useContext(EditorContext);
  return useSyncExternalStore(
    store ? store.subscribe : noSubscribe,
    () => store?.getState().doc.id,
    () => store?.getState().doc.id,
  );
}

/** Callable sub-flows: the server's list, else what the editor loaded. */
function useSubflows(): {
  data?: SubflowInfo[];
  error?: string;
  retry(): void;
  refresh(): void;
} {
  return useServerList("subflows", (c) => c.listSubflows());
}

/** The `"subflowSelect"` widget: a choice of published workflows with a sub-flow trigger. */
export function SubflowSelectWidget(p: FieldProps): JSX.Element {
  const env = useFormEnv();
  const { labels } = useFlowlineAppearance();
  const id = useId();
  const self = useCurrentWorkflowId();
  const subflows = useSubflows();
  const value = typeof p.value === "string" ? p.value : "";
  const options = (subflows.data ?? []).filter((s) => s.id !== self);
  const missing =
    value !== "" && subflows.data !== undefined && !options.some((s) => s.id === value);
  return (
    <FieldShell
      label={p.label}
      required={p.required}
      description={p.schema.description as string | undefined}
      issues={issuesUnder(env.issues, p.path)}
      htmlFor={id}
      bare={p.bare}
    >
      <select
        id={id}
        className="fl-input fl-select"
        value={value}
        disabled={env.readOnly || subflows.data === undefined}
        aria-invalid={missing || undefined}
        onFocus={subflows.refresh}
        onChange={(e) => p.onChange(e.target.value === "" ? undefined : e.target.value)}
      >
        {subflows.data === undefined ? (
          <option value={value}>{subflows.error ? value : labels.loading}</option>
        ) : (
          <>
            <option value="">{labels.chooseSubflow}</option>
            {missing && <option value={value}>{value}</option>}
            {options.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </>
        )}
      </select>
      {subflows.error !== undefined && (
        <LoadError message={subflows.error} retry={subflows.retry} />
      )}
      {subflows.data !== undefined && options.length === 0 && (
        <p className="fl-f__help">{labels.noSubflows}</p>
      )}
    </FieldShell>
  );
}

/**
 * The `"subflowInput"` widget: the input form of the workflow chosen in the sibling
 * `"subflowSelect"` field, generated from its input schema.
 */
export function SubflowInputWidget(p: FieldProps): JSX.Element {
  const env = useFormEnv();
  const { labels } = useFlowlineAppearance();
  const store = useContext(EditorContext);
  const subflows = useSubflows();
  const selectKey = propertiesOf(env.root).find(
    ([, s]) => metaOf(s).widget === "subflowSelect",
  )?.[0];
  const chosen = selectKey ? env.values[selectKey] : undefined;
  const id = typeof chosen === "string" && chosen !== "" ? chosen : undefined;
  const known = id ? store?.getState().ctx.subflows?.[id] : undefined;
  const input = subflows.data?.find((s) => s.id === id)?.input ?? known?.input;
  const obj = asObject(p.value);
  const hasFields = input !== undefined && propertiesOf(input).length > 0;
  return (
    <FieldShell
      label={p.label}
      required={p.required}
      description={p.schema.description as string | undefined}
      issues={issuesAt(env.issues, p.path)}
      group
      bare={p.bare}
    >
      {id === undefined ? (
        <p className="fl-empty-note">{labels.subflowFirst}</p>
      ) : input === undefined ? (
        <p className="fl-empty-note">
          {subflows.error ? labels.loadFailed(subflows.error) : labels.loading}
        </p>
      ) : !hasFields ? (
        <p className="fl-empty-note">{labels.subflowNoInput}</p>
      ) : (
        <div className="fl-nest">
          <NestedForm env={{ root: input }}>
            <ObjectFields
              schema={input}
              path={p.path}
              value={obj}
              onChange={(k, v) => p.onChange(withKey(obj, k, v))}
            />
          </NestedForm>
        </div>
      )}
    </FieldShell>
  );
}
