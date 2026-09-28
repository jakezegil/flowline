import {
  codeBlocksRename,
  duplicateStep as coreDuplicateStep,
  insertStep as coreInsertStep,
  moveStep as coreMoveStep,
  removeStep as coreRemoveStep,
  findStep,
  generateStepId,
  type Issue,
  isGeneratedStepId,
  type Manifest,
  type NodeManifest,
  renameStepId,
  type Step,
  type StepLocation,
  updateStep,
  type ValidationContext,
  type ValueExpr,
  validateWorkflow,
  type WorkflowDoc,
  walkSteps,
} from "@flowline/core";
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
  /**
   * Validation issues of `doc`, recomputed on every change, plus any the server reported (see
   * {@link EditorActions.setServerIssues}) that still apply.
   */
  issues: Issue[];
  /**
   * Selected step ID, {@link TRIGGER_KEY} for the trigger, or `null`. Always a step in `doc`: a
   * change that removes the selected step (delete, undo, a new doc) clears it.
   */
  selection: string | null;
  /**
   * Sample output per step ID ({@link TRIGGER_KEY} → trigger payload sample), used by the data
   * picker and step tests. Editor-local only: persisted to `localStorage` under
   * `flowline:samples:<workflowId>` and never written into the workflow doc (it may contain PII).
   * Entries of removed steps are kept while the editor is open (so undo brings them back) and
   * pruned when samples are next loaded.
   */
  samples: Record<string, unknown>;
  /** Per step ID ({@link TRIGGER_KEY} for the trigger): tested, or edited since its last test. */
  testState: Record<string, TestState>;
  /**
   * Per sample key: the node (or trigger) type the sample was recorded for. A step whose type
   * has changed since its sample was taken is `needs-test`; its sample may not match its output.
   */
  sampleTypes: Record<string, string>;
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
 * unknown step ID, node type or invalid location throw (`FlowlineTreeError` or `Error`) and leave
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
   * Changes a step's node type. Config resets to the new type's defaults; child steps stay in
   * their branches, and branches the new type doesn't declare are kept (and flagged by the
   * validator) rather than dropped or merged. A tested step becomes `needs-test`. Same type:
   * no-op. An ID the editor generated from the old type (`httpRequest_2`) is regenerated from
   * the new one, with references to it rewritten; an ID a person chose is kept.
   */
  replaceStep(id: string, nodeType: string): void;
  /**
   * Deletes a step and its subtree. Clears the selection if it was inside the removed subtree.
   * Samples and test state are kept, so undo restores them.
   */
  removeStep(id: string): void;
  /**
   * Duplicates a step (and subtree) right after itself with fresh IDs, rewriting references
   * inside the copy. The copy is named "<name> (copy)" ("(copy 2)", … when taken). Selects the
   * copy unless `opts.select` is `false`.
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
  /**
   * Switches the trigger type, resetting its config to the new type's defaults. A tested trigger
   * becomes `needs-test`.
   */
  setTrigger(type: string): void;
  /** Like {@link EditorActions.setConfig}, for the trigger's config. */
  setTriggerConfig(key: string, value: ValueExpr | undefined): void;
  /**
   * Sets (or, with `undefined`, removes) output `key` of the workflow's output mapping
   * (`doc.output`, what a sub-flow returns to its caller). Removing the last key removes the
   * mapping. Bursts of edits to the same key coalesce into one undo step, like
   * {@link EditorActions.setConfig}; an unchanged value does nothing.
   */
  setOutput(key: string, value: ValueExpr | undefined): void;
  /**
   * Selects a step, the trigger ({@link TRIGGER_KEY}), or nothing. An ID that isn't in the doc
   * selects nothing. Not recorded in history.
   */
  select(id: string | null): void;
  /**
   * Shows issues the server reported for the current doc (e.g. a publish rejected with 422)
   * alongside the editor's own: on the issues pill, the steps and their fields. Each one lasts
   * until what it's about changes: its step (or the trigger, or the output mapping), or for a
   * workflow-level issue, anything. Duplicates of the editor's own issues are dropped.
   *
   * Dropping is deliberately eager, since the server's verdict can't be re-checked locally: a
   * workflow-level issue goes with the first edit of any kind, even an unrelated one, and once
   * dropped an issue doesn't come back, even if undo returns the doc to the version the server
   * judged. Saving or publishing again asks the server afresh.
   */
  setServerIssues(issues: Issue[]): void;
  /** Copies a step (with its subtree) to the editor clipboard. Unknown IDs are ignored. */
  copy(id: string): void;
  /**
   * Inserts a fresh-ID copy of the clipboard at `loc`. Selects it unless `opts.select` is `false`.
   * @returns The pasted step's ID, or `null` when the clipboard is empty.
   */
  paste(loc: StepLocation, opts?: InsertOptions): string | null;
  /**
   * Stores a step's (or the trigger's) sample output and marks it tested. The sample is recorded
   * for `producedBy`, the node (or trigger) type that produced it, which defaults to the current
   * type; pass the type a test started with, so a type changed mid-test marks it `needs-test`.
   * Not in history.
   */
  setSample(id: string, output: unknown, producedBy?: string): void;
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
  /**
   * Sets the workflow's display name (trimmed; blank is ignored). Bursts of renames coalesce
   * into one undo step.
   */
  renameWorkflow(name: string): void;
  /**
   * Records that `doc` (default: the current doc) was saved as `version`. `dirty` is cleared
   * unless the doc changed since `doc` was sent, e.g. edits made while a save was in flight.
   */
  markSaved(version: number, doc?: WorkflowDoc): void;
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
  sampleTypes: Record<string, string>;
}

const storageKey = (workflowId: string) => `flowline:samples:${workflowId}`;

function storage(): Storage | undefined {
  try {
    return globalThis.localStorage ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * Samples and test state of `doc` from storage, keeping only the trigger and existing steps. A
 * step tested as another node type than it has now needs a new test.
 */
function loadLocal(doc: WorkflowDoc): LocalData {
  const data = readLocal(doc.id);
  const sampleTypes = pruneTo(doc, data.sampleTypes);
  return {
    samples: pruneTo(doc, data.samples),
    testState: reconcile(doc, pruneTo(doc, data.testState), sampleTypes),
    sampleTypes,
  };
}

/**
 * `testState` with every tested step (or trigger) whose sample came from another type than it has
 * now marked `needs-test`; the same object when nothing changes. The store's `testState` is the
 * one source of truth for canvas and panel, so this runs after every doc change, undo and redo.
 */
function reconcile(
  doc: WorkflowDoc,
  testState: Record<string, TestState>,
  sampleTypes: Record<string, string>,
): Record<string, TestState> {
  let types: Map<string, string> | undefined;
  let next = testState;
  for (const [id, type] of Object.entries(sampleTypes)) {
    if (testState[id] !== "tested") continue;
    types ??= currentTypes(doc);
    const now = types.get(id);
    if (now === undefined || now === type) continue;
    if (next === testState) next = { ...testState };
    next[id] = "needs-test";
  }
  return next;
}

/** Node type per step ID, and the trigger type under {@link TRIGGER_KEY}. */
function currentTypes(doc: WorkflowDoc): Map<string, string> {
  const types = new Map<string, string>([[TRIGGER_KEY, doc.trigger.type]]);
  walkSteps(doc, (step) => {
    if (!types.has(step.id)) types.set(step.id, step.type);
  });
  return types;
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
  const empty: LocalData = { samples: {}, testState: {}, sampleTypes: {} };
  try {
    const raw = storage()?.getItem(storageKey(workflowId));
    if (!raw) return empty;
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object") return empty;
    const { samples, testState, sampleTypes } = parsed as Partial<LocalData>;
    const states: Record<string, TestState> = {};
    if (testState && typeof testState === "object") {
      for (const [id, s] of Object.entries(testState)) {
        if (s === "tested" || s === "needs-test") states[id] = s;
      }
    }
    const types: Record<string, string> = {};
    if (sampleTypes && typeof sampleTypes === "object") {
      for (const [id, t] of Object.entries(sampleTypes)) if (typeof t === "string") types[id] = t;
    }
    return {
      samples: samples && typeof samples === "object" ? { ...samples } : {},
      testState: states,
      sampleTypes: types,
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
    typeof window === "undefined"
      ? { samples: {}, testState: {}, sampleTypes: {} }
      : loadLocal(init.doc);

  const nodeManifest = (type: string): NodeManifest => {
    const m = manifest.nodes.find((n) => n.type === type);
    if (!m) throw new Error(`Unknown node type "${type}"`);
    return m;
  };

  /** Issues the server reported, for the doc `serverBase` (see `setServerIssues`). */
  let serverIssues: Issue[] = [];
  let serverBase: WorkflowDoc | null = null;

  return createStore<EditorState & EditorActions>()((set, get) => {
    const derived = (doc: WorkflowDoc) => {
      const own = validateWorkflow(doc, manifest, ctx);
      if (serverBase !== null) {
        const base = serverBase;
        serverIssues = serverIssues.filter((i) => stillApplies(i, base, doc));
      }
      const key = (i: Issue) => `${i.stepId ?? ""}\u0000${i.field ?? ""}\u0000${i.message}`;
      const seen = new Set(own.map(key));
      const server = serverIssues.filter((i) => !seen.has(key(i)));
      return {
        doc,
        issues: server.length > 0 ? [...own, ...server] : own,
        dirty: doc !== savedDoc,
        canUndo: history.past.length > 0,
        canRedo: history.future.length > 0,
      };
    };

    /** `selection` if it still names something in `doc`, else `null`. */
    const validSelection = (doc: WorkflowDoc, selection: string | null): string | null =>
      selection === null || selection === TRIGGER_KEY || findStep(doc, selection)
        ? selection
        : null;

    /** Applies a doc change as an undo step, plus any state patch. */
    const commit = (
      next: WorkflowDoc,
      patch: Partial<EditorState> = {},
      coalesceKey?: string,
    ): void => {
      const prev = get().doc;
      if (next === prev) return;
      history = recordEdit(history, prev, coalesceKey, Date.now());
      const selection = "selection" in patch ? (patch.selection ?? null) : get().selection;
      set({ ...derived(next), ...patch, selection: validSelection(next, selection) });
      syncTestState();
    };

    /** Re-derives test state against the current doc (see {@link reconcile}), persisting it. */
    const syncTestState = (): void => {
      const { doc, testState, sampleTypes } = get();
      const next = reconcile(doc, testState, sampleTypes);
      if (next !== testState) set(setLocal({ testState: next }));
    };

    /** Updates samples/test state and persists them. */
    const setLocal = (patch: Partial<LocalData>): Partial<EditorState> => {
      const { samples, testState, sampleTypes, doc } = get();
      const data = {
        samples: patch.samples ?? samples,
        testState: patch.testState ?? testState,
        sampleTypes: patch.sampleTypes ?? sampleTypes,
      };
      if (
        data.samples !== samples ||
        data.testState !== testState ||
        data.sampleTypes !== sampleTypes
      ) {
        saveLocal(doc.id, data);
      }
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
      set({ ...derived(result.value), selection: validSelection(result.value, get().selection) });
      syncTestState();
    };

    /** Commits `next`, which adds `step`: resets local data left over under its IDs, selects it. */
    const commitNew = (next: WorkflowDoc, step: Step, opts: InsertOptions | undefined): string => {
      const ids = subtreeIds(step);
      const { samples, testState, sampleTypes } = get();
      commit(next, {
        ...setLocal({
          samples: without(samples, ids),
          testState: without(testState, ids),
          sampleTypes: without(sampleTypes, ids),
        }),
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
      sampleTypes: local.sampleTypes,
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
        const replaced = replaceStepType(get().doc, id, m);
        if (
          !found ||
          !isGeneratedStepId(id, found.step.type) ||
          isGeneratedStepId(id, nodeType) ||
          // Code that reads this step dynamically would break silently: keep its ID.
          codeBlocksRename(replaced, id, manifest)
        ) {
          commit(replaced, needsTest(id));
          return;
        }
        // An ID generated from the old type would now misname the step (`httpRequest` for a
        // Transform): regenerate it, and point references at the new ID.
        const free = generateStepId(replaced, nodeType);
        const { samples, testState, sampleTypes, selection } = get();
        commit(renameStepId(replaced, id, free, manifest), {
          ...setLocal({
            samples: without(samples, [free]),
            testState: without(testState, [free]),
            sampleTypes: without(sampleTypes, [free]),
          }),
          ...(selection === id ? { selection: free } : {}),
        });
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
        const copy = findStep(doc, newId)?.step as Step;
        const base = copy.name ?? manifest.nodes.find((n) => n.type === copy.type)?.name ?? copy.id;
        const taken = new Set<string>();
        walkSteps(doc, (s) => {
          if (s.name !== undefined) taken.add(s.name);
        });
        const name = copyName(base, taken);
        const named = updateStep(doc, newId, (s) => ({ ...s, name }));
        return commitNew(named, findStep(named, newId)?.step as Step, opts);
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
        commit(
          { ...doc, trigger: { type, config: defaultConfig(t.config) } },
          needsTest(TRIGGER_KEY),
        );
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

      setOutput(key, value) {
        const { doc } = get();
        if (jsonEqual(doc.output?.[key], value)) return;
        const { output: _, ...rest } = doc;
        const output = withConfigValue(doc.output ?? {}, key, value);
        commit(
          Object.keys(output).length > 0 ? { ...rest, output } : rest,
          {},
          `output\u0000${key}`,
        );
      },

      select(id) {
        const next = validSelection(get().doc, id);
        if (get().selection !== next) set({ selection: next });
      },

      setServerIssues(issues) {
        serverIssues = issues;
        serverBase = get().doc;
        set({ issues: derived(get().doc).issues });
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

      setSample(id, output, producedBy) {
        const { samples, testState, sampleTypes, doc } = get();
        const now = id === TRIGGER_KEY ? doc.trigger.type : findStep(doc, id)?.step.type;
        const type = producedBy ?? now;
        set(
          setLocal({
            samples: { ...samples, [id]: output },
            testState: {
              ...testState,
              [id]:
                type !== undefined && now !== undefined && type !== now ? "needs-test" : "tested",
            },
            ...(type !== undefined ? { sampleTypes: { ...sampleTypes, [id]: type } } : {}),
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

      renameWorkflow(name) {
        const trimmed = name.trim();
        const { doc } = get();
        if (trimmed === "" || trimmed === doc.name) return;
        commit({ ...doc, name: trimmed }, {}, "workflowName");
      },

      markSaved(version, doc) {
        savedDoc = doc ?? get().doc;
        set({ savedVersion: version, dirty: get().doc !== savedDoc });
      },

      markPublished(version) {
        set({ publishedVersion: version });
      },

      replaceDoc(doc) {
        const { doc: prev, samples, testState, sampleTypes } = get();
        history = emptyHistory();
        savedDoc = doc;
        serverIssues = [];
        serverBase = null;
        const local =
          doc.id !== prev.id
            ? loadLocal(doc)
            : {
                samples: pruneTo(doc, samples),
                testState: reconcile(doc, pruneTo(doc, testState), sampleTypes),
                sampleTypes: pruneTo(doc, sampleTypes),
              };
        set({ ...derived(doc), ...local, selection: null });
      },
    };
  });
}

/** "<base> (copy)", or "(copy 2)", "(copy 3)", … when that name is taken. */
function copyName(base: string, taken: ReadonlySet<string>): string {
  const stem = base.replace(/ \(copy(?: \d+)?\)$/, "");
  let name = `${stem} (copy)`;
  for (let n = 2; taken.has(name); n++) name = `${stem} (copy ${n})`;
  return name;
}

/**
 * Whether a server issue reported for `base` still applies to `doc`: its step (or the trigger, or
 * the output mapping) is unchanged; a workflow-level issue, only while nothing changed. Callers
 * filter the kept list on every change, so an issue dropped once stays dropped (an undo back to
 * `base` doesn't restore it); see `setServerIssues`.
 */
function stillApplies(issue: Issue, base: WorkflowDoc, doc: WorkflowDoc): boolean {
  if (doc === base) return true;
  if (issue.stepId !== undefined) {
    const before = findStep(base, issue.stepId)?.step;
    return before !== undefined && findStep(doc, issue.stepId)?.step === before;
  }
  if (issue.field?.startsWith("trigger.") || issue.field === "trigger")
    return doc.trigger === base.trigger;
  if (issue.field?.startsWith("output.") || issue.field === "output")
    return doc.output === base.output;
  return false;
}

/** `prev` when updating step `id` produced an identical step, so no-op edits add no history. */
function unchangedIfSame(prev: WorkflowDoc, next: WorkflowDoc, id: string): WorkflowDoc {
  return findStep(prev, id)?.step === findStep(next, id)?.step ? prev : next;
}
