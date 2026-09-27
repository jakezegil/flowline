import {
  duplicateStep as coreDuplicateStep,
  insertStep as coreInsertStep,
  moveStep as coreMoveStep,
  removeStep as coreRemoveStep,
  findStep,
  generateStepId,
  type Issue,
  type Manifest,
  type NodeManifest,
  type Step,
  type StepLocation,
  updateStep,
  type ValidationContext,
  type ValueExpr,
  validateWorkflow,
  type WorkflowDoc,
  walkSteps,
} from "@flowkit/core";
import { createStore, type StoreApi } from "zustand/vanilla";
import {
  cloneWithFreshIds,
  createStep,
  defaultConfig,
  jsonEqual,
  replaceStepType,
  subtreeIds,
  syncBranches,
  withConfigValue,
} from "./commands";
import { emptyHistory, type History, recordEdit, redoEdit, undoEdit } from "./history";

/** Selection / sample key standing for the workflow's trigger. */
export const TRIGGER_KEY = "__trigger";

/** Whether a step's last test still reflects its config. */
export type TestState = "tested" | "needs-test";

/** The editor's state. Read it with `store.getState()` or the hooks in `hooks.ts`. */
export interface EditorState {
  /** The workflow being edited. Immutable: every command produces a new doc. */
  doc: WorkflowDoc;
  /** Available nodes and triggers. */
  manifest: Manifest;
  /** Extra validation knowledge (callable sub-flows). */
  ctx: ValidationContext;
  /** Validation issues of `doc`, recomputed on every change. */
  issues: Issue[];
  /** Selected step ID, {@link TRIGGER_KEY} for the trigger, or `null`. */
  selection: string | null;
  /**
   * Sample output per step ID ({@link TRIGGER_KEY} → trigger payload sample), used by the data
   * picker and step tests. Editor-local only: persisted to `localStorage` under
   * `flowkit:samples:<workflowId>` and never written into the workflow doc (it may contain PII).
   * Entries of removed steps are kept while the editor is open (so undo brings them back) and
   * pruned when samples are next loaded.
   */
  samples: Record<string, unknown>;
  /** Per step ID ({@link TRIGGER_KEY} for the trigger): tested, or edited since its last test. */
  testState: Record<string, TestState>;
  /** Whether `doc` differs from the last saved (or loaded) doc. Undoing back to it clears it. */
  dirty: boolean;
  /** Version number of the last save, if any. */
  savedVersion: number | null;
  /** Version number currently published, if any. */
  publishedVersion: number | null;
  /** The last copied step (with its subtree). */
  clipboard: Step | null;
  /** Whether {@link EditorActions.undo} would do anything. */
  canUndo: boolean;
  /** Whether {@link EditorActions.redo} would do anything. */
  canRedo: boolean;
}

/**
 * Editor commands. Every doc-changing command is one undo step (except bursts of edits to the
 * same field, see {@link EditorActions.setConfig}) and revalidates the doc. Commands given an
 * unknown step ID, node type or invalid location throw (`FlowkitTreeError` or `Error`) and leave
 * the state unchanged.
 */
export interface EditorActions {
  /**
   * Inserts a new step of `nodeType` at `loc`, with config defaults from the node's input schema
   * and an empty list per declared branch. Selects it unless `opts.select` is `false`.
   * @returns The new step's generated ID, e.g. `"sendEmail"` or `"sendEmail_2"`.
   */
  insertStep(loc: StepLocation, nodeType: string, opts?: InsertOptions): string;
  /**
   * Changes a step's node type, keeping its ID. Config resets to the new type's defaults; child
   * steps stay in their branches, and branches the new type doesn't declare are kept (and
   * flagged by the validator) rather than dropped or merged. Same type: no-op.
   */
  replaceStep(id: string, nodeType: string): void;
  /**
   * Deletes a step and its subtree. Clears the selection if it was inside the removed subtree.
   * Samples and test state are kept, so undo restores them.
   */
  removeStep(id: string): void;
  /**
   * Duplicates a step (and subtree) right after itself with fresh IDs, rewriting references
   * inside the copy. Selects the copy unless `opts.select` is `false`.
   * @returns The copy's ID.
   */
  duplicateStep(id: string, opts?: InsertOptions): string;
  /** Moves a step (and subtree) to `to`, whose index counts positions after the step's removal. */
  moveStep(id: string, to: StepLocation): void;
  /** Sets a step's display name; blank clears the override. Bursts of renames coalesce. */
  renameStep(id: string, name: string): void;
  /** Disables or re-enables a step. */
  toggleDisabled(id: string): void;
  /**
   * Sets (or, with `undefined`, removes) config field `key` of a step. Marks the step
   * `needs-test` if it was tested. Consecutive edits of the same step and key less than 500ms
   * apart coalesce into one undo step. Setting an unchanged value does nothing. For nodes whose
   * branches come from config (switch cases), branches are kept in sync.
   */
  setConfig(id: string, key: string, value: ValueExpr | undefined): void;
  /** Switches the trigger type, resetting its config to the new type's defaults. */
  setTrigger(type: string): void;
  /** Like {@link EditorActions.setConfig}, for the trigger's config. */
  setTriggerConfig(key: string, value: ValueExpr | undefined): void;
  /** Selects a step, the trigger ({@link TRIGGER_KEY}), or nothing. Not recorded in history. */
  select(id: string | null): void;
  /** Copies a step (with its subtree) to the editor clipboard. Unknown IDs are ignored. */
  copy(id: string): void;
  /**
   * Inserts a fresh-ID copy of the clipboard at `loc`. Selects it unless `opts.select` is `false`.
   * @returns The pasted step's ID, or `null` when the clipboard is empty.
   */
  paste(loc: StepLocation, opts?: InsertOptions): string | null;
  /** Stores a step's (or the trigger's) sample output and marks it tested. Not in history. */
  setSample(id: string, output: unknown): void;
  /**
   * Loads samples and test state for the current workflow from `localStorage`, pruned to steps
   * that exist. The store does this itself when created in a browser; when created where there is
   * no `window` (SSR) it starts empty, and the provider (`<WorkflowEditor>` / `<WorkflowCanvas>`)
   * calls `hydrateLocal()` in an effect after mounting.
   */
  hydrateLocal(): void;
  /** Reverts the last doc change. */
  undo(): void;
  /** Re-applies the last undone change. */
  redo(): void;
  /** Records that the current doc was saved as `version`; clears `dirty`. */
  markSaved(version: number): void;
  /** Records that `version` is now published. */
  markPublished(version: number): void;
  /**
   * Replaces the doc wholesale as a new clean baseline (e.g. once loaded from the server): clears
   * history and selection, loads that workflow's samples if its ID differs, and drops samples and
   * test state of steps the new doc doesn't contain.
   */
  replaceDoc(doc: WorkflowDoc): void;
}

/** Options of commands that add a step. */
export interface InsertOptions {
  /** Select the new step (default `true`). */
  select?: boolean;
}

/** A vanilla Zustand store holding the editor state and commands. */
export type EditorStore = StoreApi<EditorState & EditorActions>;

interface LocalData {
  samples: Record<string, unknown>;
  testState: Record<string, TestState>;
}

const storageKey = (workflowId: string) => `flowkit:samples:${workflowId}`;

function storage(): Storage | undefined {
  try {
    return globalThis.localStorage ?? undefined;
  } catch {
    return undefined;
  }
}

/** Samples and test state of `doc` from storage, keeping only the trigger and existing steps. */
function loadLocal(doc: WorkflowDoc): LocalData {
  const data = readLocal(doc.id);
  return { samples: pruneTo(doc, data.samples), testState: pruneTo(doc, data.testState) };
}

/** `record` without keys that are neither {@link TRIGGER_KEY} nor a step of `doc`. */
function pruneTo<T>(doc: WorkflowDoc, record: Record<string, T>): Record<string, T> {
  const ids = new Set<string>([TRIGGER_KEY]);
  walkSteps(doc, (step) => ids.add(step.id));
  return without(
    record,
    Object.keys(record).filter((k) => !ids.has(k)),
  );
}

function readLocal(workflowId: string): LocalData {
  const empty: LocalData = { samples: {}, testState: {} };
  try {
    const raw = storage()?.getItem(storageKey(workflowId));
    if (!raw) return empty;
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object") return empty;
    const { samples, testState } = parsed as Partial<LocalData>;
    const states: Record<string, TestState> = {};
    if (testState && typeof testState === "object") {
      for (const [id, s] of Object.entries(testState)) {
        if (s === "tested" || s === "needs-test") states[id] = s;
      }
    }
    return {
      samples: samples && typeof samples === "object" ? { ...samples } : {},
      testState: states,
    };
  } catch {
    return empty;
  }
}

function saveLocal(workflowId: string, data: LocalData): void {
  try {
    storage()?.setItem(storageKey(workflowId), JSON.stringify(data));
  } catch {
    // Storage full, blocked or unavailable: samples stay in memory for this session.
  }
}

function without<T>(record: Record<string, T>, ids: readonly string[]): Record<string, T> {
  if (!ids.some((id) => id in record)) return record;
  const next = { ...record };
  for (const id of ids) delete next[id];
  return next;
}

/**
 * Creates the headless editor store for one workflow. Validation runs synchronously against
 * `manifest` (and `ctx`) after every change. In a browser, samples and test state are loaded from
 * `localStorage` for `doc.id`; without `window` (SSR) they start empty until
 * {@link EditorActions.hydrateLocal} is called.
 *
 * @example
 * const store = createEditorStore({ doc, manifest });
 * const id = store.getState().insertStep({ parentId: null, index: 0 }, "crm.sendEmail");
 * store.getState().setConfig(id, "subject", "Welcome!");
 * store.getState().undo();
 */
export function createEditorStore(init: {
  doc: WorkflowDoc;
  manifest: Manifest;
  ctx?: ValidationContext;
}): EditorStore {
  const { manifest } = init;
  const ctx = init.ctx ?? {};
  let history: History<WorkflowDoc> = emptyHistory();
  let savedDoc = init.doc;
  const local: LocalData =
    typeof window === "undefined" ? { samples: {}, testState: {} } : loadLocal(init.doc);

  const nodeManifest = (type: string): NodeManifest => {
    const m = manifest.nodes.find((n) => n.type === type);
    if (!m) throw new Error(`Unknown node type "${type}"`);
    return m;
  };

  return createStore<EditorState & EditorActions>()((set, get) => {
    const derived = (doc: WorkflowDoc) => ({
      doc,
      issues: validateWorkflow(doc, manifest, ctx),
      dirty: doc !== savedDoc,
      canUndo: history.past.length > 0,
      canRedo: history.future.length > 0,
    });

    /** Applies a doc change as an undo step, plus any state patch. */
    const commit = (
      next: WorkflowDoc,
      patch: Partial<EditorState> = {},
      coalesceKey?: string,
    ): void => {
      const prev = get().doc;
      if (next === prev) return;
      history = recordEdit(history, prev, coalesceKey, Date.now());
      set({ ...derived(next), ...patch });
    };

    /** Updates samples/test state and persists them. */
    const setLocal = (patch: Partial<LocalData>): Partial<EditorState> => {
      const { samples, testState, doc } = get();
      const data = { samples: patch.samples ?? samples, testState: patch.testState ?? testState };
      if (data.samples !== samples || data.testState !== testState) saveLocal(doc.id, data);
      return data;
    };

    const needsTest = (id: string): Partial<EditorState> =>
      get().testState[id] === "tested"
        ? setLocal({ testState: { ...get().testState, [id]: "needs-test" } })
        : {};

    const travel = (step: typeof undoEdit): void => {
      const result = step(history, get().doc);
      if (!result) return;
      history = result.history;
      const { selection } = get();
      const keep =
        selection === null || selection === TRIGGER_KEY || findStep(result.value, selection);
      set({ ...derived(result.value), ...(keep ? {} : { selection: null }) });
    };

    /** Commits `next`, which adds `step`: resets local data left over under its IDs, selects it. */
    const commitNew = (next: WorkflowDoc, step: Step, opts: InsertOptions | undefined): string => {
      const ids = subtreeIds(step);
      const { samples, testState } = get();
      commit(next, {
        ...setLocal({ samples: without(samples, ids), testState: without(testState, ids) }),
        ...(opts?.select === false ? {} : { selection: step.id }),
      });
      return step.id;
    };

    return {
      ...derived(init.doc),
      manifest,
      ctx,
      selection: null,
      samples: local.samples,
      testState: local.testState,
      savedVersion: null,
      publishedVersion: null,
      clipboard: null,

      insertStep(loc, nodeType, opts) {
        const step = createStep(generateStepId(get().doc, nodeType), nodeManifest(nodeType));
        return commitNew(coreInsertStep(get().doc, loc, step), step, opts);
      },

      replaceStep(id, nodeType) {
        const m = nodeManifest(nodeType);
        const found = findStep(get().doc, id);
        if (found?.step.type === nodeType) return;
        commit(replaceStepType(get().doc, id, m));
      },

      removeStep(id) {
        const found = findStep(get().doc, id);
        const next = coreRemoveStep(get().doc, id);
        const ids = found ? subtreeIds(found.step) : [id];
        const { selection } = get();
        commit(next, selection !== null && ids.includes(selection) ? { selection: null } : {});
      },

      duplicateStep(id, opts) {
        const { doc, newId } = coreDuplicateStep(get().doc, id);
        return commitNew(doc, findStep(doc, newId)?.step as Step, opts);
      },

      moveStep(id, to) {
        const from = findStep(get().doc, id)?.location;
        const same =
          from?.parentId === to.parentId &&
          (to.parentId === null || from.branch === to.branch) &&
          from.index === to.index;
        if (!same) commit(coreMoveStep(get().doc, id, to));
      },

      renameStep(id, name) {
        const trimmed = name.trim();
        const next = updateStep(get().doc, id, (s) => {
          if ((s.name ?? "") === trimmed) return s;
          const { name: _, ...rest } = s;
          return trimmed === "" ? rest : { ...rest, name: trimmed };
        });
        commit(unchangedIfSame(get().doc, next, id), {}, `name\u0000${id}`);
      },

      toggleDisabled(id) {
        commit(
          updateStep(get().doc, id, (s) => {
            const { disabled, ...rest } = s;
            return disabled ? rest : { ...rest, disabled: true };
          }),
        );
      },

      setConfig(id, key, value) {
        const found = findStep(get().doc, id);
        if (found && jsonEqual(found.step.config[key], value)) return;
        const m = manifest.nodes.find((n) => n.type === found?.step.type);
        const next = updateStep(get().doc, id, (s) => {
          const updated = { ...s, config: withConfigValue(s.config, key, value) };
          return m ? syncBranches(updated, m) : updated;
        });
        commit(next, needsTest(id), `config\u0000${id}\u0000${key}`);
      },

      setTrigger(type) {
        const t = manifest.triggers.find((x) => x.type === type);
        if (!t) throw new Error(`Unknown trigger type "${type}"`);
        const { doc } = get();
        if (doc.trigger.type === type) return;
        commit({ ...doc, trigger: { type, config: defaultConfig(t.config) } });
      },

      setTriggerConfig(key, value) {
        const { doc } = get();
        if (jsonEqual(doc.trigger.config[key], value)) return;
        commit(
          {
            ...doc,
            trigger: { ...doc.trigger, config: withConfigValue(doc.trigger.config, key, value) },
          },
          needsTest(TRIGGER_KEY),
          `trigger\u0000${key}`,
        );
      },

      select(id) {
        if (get().selection !== id) set({ selection: id });
      },

      copy(id) {
        const found = findStep(get().doc, id);
        if (found) set({ clipboard: found.step });
      },

      paste(loc, opts) {
        const { clipboard, doc } = get();
        if (!clipboard) return null;
        const copy = cloneWithFreshIds(doc, clipboard);
        return commitNew(coreInsertStep(doc, loc, copy), copy, opts);
      },

      setSample(id, output) {
        const { samples, testState } = get();
        set(
          setLocal({
            samples: { ...samples, [id]: output },
            testState: { ...testState, [id]: "tested" },
          }),
        );
      },

      hydrateLocal() {
        set(loadLocal(get().doc));
      },

      undo() {
        travel(undoEdit);
      },

      redo() {
        travel(redoEdit);
      },

      markSaved(version) {
        savedDoc = get().doc;
        set({ savedVersion: version, dirty: false });
      },

      markPublished(version) {
        set({ publishedVersion: version });
      },

      replaceDoc(doc) {
        const { doc: prev, samples, testState } = get();
        history = emptyHistory();
        savedDoc = doc;
        const local =
          doc.id !== prev.id
            ? loadLocal(doc)
            : { samples: pruneTo(doc, samples), testState: pruneTo(doc, testState) };
        set({ ...derived(doc), ...local, selection: null });
      },
    };
  });
}

/** `prev` when updating step `id` produced an identical step, so no-op edits add no history. */
function unchangedIfSame(prev: WorkflowDoc, next: WorkflowDoc, id: string): WorkflowDoc {
  return findStep(prev, id)?.step === findStep(next, id)?.step ? prev : next;
}
