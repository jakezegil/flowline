import {
  type AnnotationColor,
  type ApplyError,
  type ApplyResult,
  type At,
  apply,
  branchList,
  type Command,
  changedStepIds,
  cloneRunWithFreshIds,
  removeStep as coreRemoveStep,
  runTool as coreRunTool,
  FlowlineCommandError,
  findStep,
  type Issue,
  jsonEqual,
  type Manifest,
  type Section,
  type SectionInput,
  type Step,
  type StepLocation,
  type ValidationContext,
  type ValueExpr,
  validateWorkflow,
  type WorkflowDoc,
  walkSteps,
} from "@flowlinejs/core";
import { createStore, type StoreApi } from "zustand/vanilla";
import { atFromLocation, stepToFragment, subtreeIds } from "./commands";
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
  /** The last copied step (with its subtree); the first step of {@link EditorState.clipboardRun}. */
  clipboard: Step | null;
  /** The whole copied run (each step with its subtree), pasted as a block. */
  clipboardRun: Step[] | null;
  /**
   * A contiguous run of steps in one list (`first` at or before `last`), or `null`. Pruned on
   * every doc change like `selection`: an endpoint that goes away shrinks the range to the
   * members left in its list, and a range with none left is cleared.
   */
  range: { first: string; last: string } | null;
  /**
   * The single source of truth for read-only mode: doc-changing actions throw
   * `FlowlineCommandError` (`error.code === "readOnly"`) and {@link EditorActions.apply} returns
   * code `"readOnly"`. `<WorkflowCanvas readOnly>` sets it while mounted.
   */
  readOnly: boolean;
  /**
   * Steps and sections changed by the last {@link EditorActions.apply}, for a brief canvas
   * highlight: step IDs, section IDs, and a `token` that is new on every flash.
   */
  flash: { ids: string[]; sections: string[]; token: number } | null;
  /**
   * The step renames (old → new ID) of the edit, undo or redo that produced `doc`, so UI state
   * keyed by step ID (an open note editor) can follow them. Only meaningful while
   * `renames.doc === doc`; `null` before the first edit.
   */
  renames: { doc: WorkflowDoc; map: Record<string, string> } | null;
  /** Whether {@link EditorActions.undo} would do anything. */
  canUndo: boolean;
  /** Whether {@link EditorActions.redo} would do anything. */
  canRedo: boolean;
}

/**
 * Editor commands. Every doc-changing command is one undo step (except bursts of edits to the
 * same field, see {@link EditorActions.setConfig}) and revalidates the doc. Each runs through
 * core's `apply`; a command that changes nothing adds no history. Commands given an unknown step
 * ID, node or trigger type throw `FlowlineCommandError`, and an invalid location throws
 * `FlowlineTreeError` (which `FlowlineCommandError` extends); the state is left unchanged.
 */
export interface EditorActions {
  /**
   * Runs `commands` through core's `apply` (untrusted, with the full report) as one undo step.
   * Never throws: a failed batch (or a read-only store, code `"readOnly"`) comes back as
   * `ok: false` and changes nothing. A burst with the same `coalesceKey` joins the previous undo
   * step. The selection, the range and local data (samples, test state, sample types) follow
   * `renamed`; removed steps drop out of the selection and the range, and steps the batch adds
   * start without leftover local data. Sets {@link EditorState.flash} unless `flash: false`.
   *
   * @example
   * const r = store.getState().apply([
   *   { op: "addStep", at: { after: "load" }, type: "crm.sendEmail" },
   *   { op: "setConfig", id: "$1", key: "to", value: { $ref: "steps.load.email" } },
   * ]);
   * if (!r.ok) console.warn(r.error.message);
   */
  apply(commands: Command[], opts?: { coalesceKey?: string; flash?: boolean }): ApplyResult;
  /**
   * Selects the run between two steps of one list (in list order, whichever is given first).
   * Returns `false`, changing nothing, when they are in different lists or one doesn't exist.
   */
  selectRange(first: string, last: string): boolean;
  /** Clears the range. */
  clearRange(): void;
  /** Turns read-only mode on or off (see {@link EditorState.readOnly}). */
  setReadOnly(readOnly: boolean): void;
  /**
   * Copies the run `first`…`last` (with subtrees): `clipboardRun` is the run, `clipboard` its
   * first step. A run that isn't one list, in order, is ignored.
   */
  copyRange(first: string, last: string): void;
  /** Deletes the run `first`…`last` (with subtrees) as one undo step. */
  removeRange(first: string, last: string): void;
  /**
   * Duplicates the run `first`…`last` right after it, with fresh IDs.
   * @returns The first copy's ID.
   */
  duplicateRange(first: string, last: string): string;
  /**
   * Moves the run `first`…`last` one place up (`-1`) or down (`1`) in its list; a no-op at the
   * list's edge. Members keep their section when they land inside its span.
   */
  moveBy(first: string, last: string, delta: -1 | 1): void;
  /**
   * Wraps the run `first`…`last` in a new section.
   * @returns The section's ID.
   */
  addSection(first: string, last: string, input: SectionInput): string;
  /** Changes a section's title, colour or note (`note: null` removes it). */
  updateSection(
    id: string,
    patch: { title?: string; color?: AnnotationColor; note?: string | null },
  ): void;
  /** Removes a section, keeping its steps. */
  removeSection(id: string): void;
  /** Sets a step's note (`null` or `""` removes it). Bursts of edits coalesce. */
  setNote(id: string, note: string | null): void;
  /** Sets a step's colour (`null` removes it). */
  setColor(id: string, color: AnnotationColor | null): void;
  /**
   * Inserts a new step of `nodeType` at `loc`, with config defaults from the node's input schema
   * and an empty list per declared branch. Selects it unless `opts.select` is `false`.
   * @returns The new step's generated ID, e.g. `"sendEmail"` or `"sendEmail_2"`.
   */
  insertStep(loc: StepLocation, nodeType: string, opts?: InsertOptions): string;
  /**
   * Changes a step's node type. Config resets to the new type's defaults and the name override
   * is dropped; its note and colour are kept (annotations belong to the step). Child steps stay in
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
  /**
   * Copies a step (with its subtree) to the editor clipboard (`clipboardRun` is `[step]`).
   * Unknown IDs are ignored.
   */
  copy(id: string): void;
  /**
   * Inserts a fresh-ID copy of the copied run at `loc` (as copied: config and branches as they
   * were, refs between copied steps pointing at the copies). Selects the first pasted step
   * unless `opts.select` is `false`.
   * @returns The first pasted step's ID, or `null` when the clipboard is empty.
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
  /** Reverts the last doc change. Throws in read-only mode, like every doc-changing action. */
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

/** A successful {@link apply} result. */
type Applied = Extract<ApplyResult, { ok: true }>;

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
  /** Start in read-only mode (see {@link EditorState.readOnly}). */
  readOnly?: boolean;
}): EditorStore {
  const { manifest } = init;
  const ctx = init.ctx ?? {};
  let history: History<HistoryEntry> = emptyHistory();
  let savedDoc = init.doc;
  const local: LocalData =
    typeof window === "undefined"
      ? { samples: {}, testState: {}, sampleTypes: {} }
      : loadLocal(init.doc);

  /** Issues the server reported, for the doc `serverBase` (see `setServerIssues`). */
  let serverIssues: Issue[] = [];
  let serverBase: WorkflowDoc | null = null;
  let flashToken = 0;
  /** The host's read-only value (`setReadOnly`), and how many holders keep the store read-only. */
  const lock = { base: init.readOnly === true, holders: 0 };

  const store = createStore<EditorState & EditorActions>()((set, get) => {
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
      renamed: Record<string, string> = {},
    ): void => {
      const prev = get().doc;
      if (next === prev) return;
      const depth = history.past.length;
      const last = history.past[depth - 1];
      history = recordEdit(
        history,
        { doc: prev, renamed, range: get().range },
        coalesceKey,
        Date.now(),
      );
      if (history.past.length === depth && last) {
        // Joined the previous undo step: its renames now run through this edit's too.
        const past = history.past.slice();
        past[depth - 1] = { ...last, renamed: composeRenames(last.renamed, renamed) };
        history = { ...history, past };
      }
      const selection = "selection" in patch ? (patch.selection ?? null) : get().selection;
      const kept = "range" in patch ? (patch.range ?? null) : get().range;
      const range = pruneRange(prev, next, kept, renamed);
      set({
        ...derived(next),
        ...patch,
        selection: validSelection(next, selection),
        range,
        renames: { doc: next, map: renamed },
      });
      syncTestState();
    };

    /** Throws the read-only error when the store is read-only. */
    const guard = (): void => {
      if (get().readOnly) throw new FlowlineCommandError(READ_ONLY);
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

    /**
     * Undo or redo. Each history entry carries the renames of the edit that followed it, so the
     * selection and the range follow step IDs back (inverted) on undo and forward on redo.
     */
    const travel = (dir: "undo" | "redo"): void => {
      const source = dir === "undo" ? history.past.at(-1) : history.future.at(-1);
      if (!source) return;
      const renamed = source.renamed;
      const step = dir === "undo" ? undoEdit : redoEdit;
      const result = step(history, { doc: get().doc, renamed, range: get().range });
      if (!result) return;
      history = result.history;
      const next = result.value.doc;
      const map = dir === "undo" ? invertRenames(renamed) : renamed;
      const selection = get().selection;
      const mapped =
        selection !== null && Object.hasOwn(map, selection)
          ? (map[selection] as string)
          : selection;
      set({
        ...derived(next),
        selection: validSelection(next, mapped),
        range: travelRange(get().doc, next, get().range, map, result.value.range),
        renames: { doc: next, map },
      });
      syncTestState();
    };

    /**
     * Runs `commands` on the current doc through core's `apply` (trusted, no report). Throws
     * {@link FlowlineCommandError} when the batch fails; `undefined` when it changes nothing (the
     * no-op identity rule), so callers skip the commit and its side effects.
     */
    const run = (commands: Command[]): Applied | undefined => {
      guard();
      const doc = get().doc;
      const r = apply(doc, commands, manifest, { ctx, trusted: true, report: false });
      if (!r.ok) throw new FlowlineCommandError(r.error);
      return r.doc === doc ? undefined : r;
    };

    /** Commits an applied batch, carrying the selection over renamed step IDs. */
    const commitApplied = (
      r: Applied,
      patch: Partial<EditorState> = {},
      coalesceKey?: string,
    ): void => {
      const selection = "selection" in patch ? (patch.selection ?? null) : get().selection;
      const mapped =
        selection !== null && Object.hasOwn(r.renamed, selection)
          ? (r.renamed[selection] as string)
          : selection;
      commit(r.doc, { ...patch, selection: mapped }, coalesceKey, r.renamed);
    };

    /** Local data (samples, test state) with the entries under `ids` dropped. */
    const resetLocal = (ids: readonly string[]): Partial<EditorState> => {
      const { samples, testState, sampleTypes } = get();
      return setLocal({
        samples: without(samples, ids),
        testState: without(testState, ids),
        sampleTypes: without(sampleTypes, ids),
      });
    };

    /**
     * Commits a batch that added step `$1`: resets local data left over under its subtree's IDs
     * and selects it.
     */
    const commitNew = (
      r: Applied | undefined,
      opts: InsertOptions | undefined,
      added: readonly Step[] = [],
    ): string => {
      const id = r?.ids.$1;
      const step = r && id !== undefined ? findStep(r.doc, id)?.step : undefined;
      if (!r || !step) throw new Error("A step-adding command added no step");
      const fresh = added.length > 0 ? added.flatMap(subtreeIds) : subtreeIds(step);
      commitApplied(r, {
        ...resetLocal(fresh),
        ...(opts?.select === false ? {} : { selection: step.id }),
      });
      return step.id;
    };

    /**
     * Local data copied over renamed steps (old → new, for steps that existed before), with the
     * leftovers under IDs the batch added dropped. The old entries stay, so undo finds them.
     */
    const remapLocal = (before: WorkflowDoc, r: Applied): Partial<EditorState> => {
      const { samples, testState, sampleTypes } = get();
      const existed = new Set<string>();
      walkSteps(before, (s) => existed.add(s.id));
      const moves = Object.entries(r.renamed).filter(([old]) => existed.has(old));
      const targets = new Set(moves.map(([, now]) => now));
      const added = changedStepIds(before, r.doc).added.filter((id) => !targets.has(id));
      if (moves.length === 0 && added.length === 0) return {};
      const move = <T>(record: Record<string, T>): Record<string, T> => {
        const next = { ...without(record, added) };
        // Values come from `record`, so swaps (a → b, b → a) copy the pre-batch entries.
        for (const [old, now] of moves) {
          if (Object.hasOwn(record, old)) next[now] = record[old] as T;
          else delete next[now];
        }
        return next;
      };
      return setLocal({
        samples: move(samples),
        testState: move(testState),
        sampleTypes: move(sampleTypes),
      });
    };

    /** A `{ key, value }` config edit: `undefined` removes the key, `null` is stored. */
    const keyValue = (key: string, value: ValueExpr | undefined) =>
      value === undefined
        ? { key, value: null }
        : value === null
          ? { key, value, nullIsValue: true }
          : { key, value };

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
      clipboardRun: null,
      range: null,
      readOnly: init.readOnly === true,
      flash: null,
      renames: null,

      apply(commands, opts) {
        if (get().readOnly) return { ok: false, error: READ_ONLY };
        const before = get().doc;
        let r: ApplyResult;
        try {
          r = apply(before, commands, manifest, { ctx });
        } catch (err) {
          // A batch nested thousands deep overflows the recursive checks: core's catalog has the
          // error for it. Anything else is a bug, and surfaces.
          if (!(err instanceof RangeError)) throw err;
          const reported = coreRunTool({ doc: before, manifest, ctx }, "apply", { commands });
          if (reported.ok && isFailure(reported.result)) return reported.result;
          throw err;
        }
        if (!r.ok || r.doc === before) return r;
        const selection = get().selection;
        const patch: Partial<EditorState> = {
          ...remapLocal(before, r),
          selection:
            selection !== null && Object.hasOwn(r.renamed, selection)
              ? (r.renamed[selection] as string)
              : selection,
        };
        if (opts?.flash !== false) {
          const delta = changedStepIds(before, r.doc);
          patch.flash = {
            ids: [...delta.added, ...delta.updated],
            sections: changedSections(before.sections ?? [], r.doc.sections ?? []),
            token: ++flashToken,
          };
        }
        commit(r.doc, patch, opts?.coalesceKey, r.renamed);
        return r;
      },

      selectRange(first, last) {
        const { doc, range } = get();
        const a = findStep(doc, first);
        const z = findStep(doc, last);
        if (!a || !z || !sameList(a.location, z.location)) return false;
        const next =
          a.location.index <= z.location.index ? { first, last } : { first: last, last: first };
        if (range?.first !== next.first || range.last !== next.last) set({ range: next });
        return true;
      },

      clearRange() {
        if (get().range !== null) set({ range: null });
      },

      setReadOnly(readOnly) {
        lock.base = readOnly;
        const next = readOnly || lock.holders > 0;
        if (get().readOnly !== next) set({ readOnly: next });
      },

      copyRange(first, last) {
        const steps = runOf(get().doc, first, last);
        if (steps && steps.length > 0) set({ clipboard: steps[0] as Step, clipboardRun: steps });
      },

      removeRange(first, last) {
        const r = run([{ op: "removeSteps", first, last }]);
        if (r) commitApplied(r);
      },

      duplicateRange(first, last) {
        return commitNew(run([{ op: "duplicateSteps", first, last }]), { select: false });
      },

      moveBy(first, last, delta) {
        guard();
        const { doc } = get();
        const steps = runOf(doc, first, last);
        const found = findStep(doc, first);
        const list = found ? listOf(doc, found.location) : undefined;
        if (!steps || !found || !list) {
          // Not a run: the command reports why.
          const r = run([{ op: "moveSteps", first, last, to: { start: true } }]);
          if (r) commitApplied(r);
          return;
        }
        const start = found.location.index;
        const neighbour = delta < 0 ? list[start - 1] : list[start + steps.length];
        if (!neighbour) return;
        const to: At = delta < 0 ? { before: neighbour.id } : { after: neighbour.id };
        const r = run([{ op: "moveSteps", first, last, to }]);
        if (r) commitApplied(r);
      },

      addSection(first, last, input) {
        const r = run([{ op: "addSection", first, last, ...input }]);
        const id = r?.ids.$1;
        if (!r || id === undefined) throw new Error("addSection added no section");
        commitApplied(r);
        return id;
      },

      updateSection(id, patch) {
        const r = run([{ op: "updateSection", id, ...patch }]);
        if (r) commitApplied(r);
      },

      removeSection(id) {
        const r = run([{ op: "removeSection", id }]);
        if (r) commitApplied(r);
      },

      setNote(id, note) {
        const r = run([{ op: "setNote", id, note }]);
        if (r) commitApplied(r, {}, `note\u0000${id}`);
      },

      setColor(id, color) {
        const r = run([{ op: "setColor", id, color }]);
        if (r) commitApplied(r);
      },

      insertStep(loc, nodeType, opts) {
        guard();
        const at = atFromLocation(get().doc, loc);
        return commitNew(run([{ op: "addStep", at, type: nodeType }]), opts);
      },

      replaceStep(id, nodeType) {
        const r = run([{ op: "setType", id, type: nodeType }]);
        if (!r) return;
        const free = Object.hasOwn(r.renamed, id) ? r.renamed[id] : undefined;
        // An ID generated from the old type was regenerated (references follow): the new ID
        // starts without local data, and the selection follows it.
        commitApplied(r, free === undefined ? needsTest(id) : resetLocal([free]));
      },

      removeStep(id) {
        guard();
        const found = findStep(get().doc, id);
        const r = run([{ op: "removeStep", id }]);
        if (!r) return;
        const ids = found ? subtreeIds(found.step) : [id];
        const { selection } = get();
        commitApplied(r, selection !== null && ids.includes(selection) ? { selection: null } : {});
      },

      duplicateStep(id, opts) {
        return commitNew(run([{ op: "duplicateStep", id }]), opts);
      },

      moveStep(id, to) {
        guard();
        const { doc } = get();
        // `to` counts positions after the step's removal, as the command's anchor does.
        const at = findStep(doc, id)
          ? atFromLocation(coreRemoveStep(doc, id), to)
          : ({ start: true } as const);
        const r = run([{ op: "moveStep", id, to: at }]);
        if (r) commitApplied(r);
      },

      renameStep(id, name) {
        const r = run([{ op: "renameStep", id, name }]);
        if (r) commitApplied(r, {}, `name\u0000${id}`);
      },

      toggleDisabled(id) {
        const disabled = findStep(get().doc, id)?.step.disabled !== true;
        const r = run([{ op: "setDisabled", id, disabled }]);
        if (r) commitApplied(r);
      },

      setConfig(id, key, value) {
        guard();
        const found = findStep(get().doc, id);
        if (found && jsonEqual(found.step.config[key], value)) return;
        const r = run([{ op: "setConfig", id, ...keyValue(key, value) }]);
        if (r) commitApplied(r, needsTest(id), `config\u0000${id}\u0000${key}`);
      },

      setTrigger(type) {
        const r = run([{ op: "setTrigger", type }]);
        if (r) commitApplied(r, needsTest(TRIGGER_KEY));
      },

      setTriggerConfig(key, value) {
        guard();
        if (jsonEqual(get().doc.trigger.config[key], value)) return;
        const r = run([{ op: "setTriggerConfig", ...keyValue(key, value) }]);
        if (r) commitApplied(r, needsTest(TRIGGER_KEY), `trigger\u0000${key}`);
      },

      setOutput(key, value) {
        guard();
        if (jsonEqual(get().doc.output?.[key], value)) return;
        const r = run([{ op: "setOutput", ...keyValue(key, value) }]);
        if (r) commitApplied(r, {}, `output\u0000${key}`);
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
        if (found) set({ clipboard: found.step, clipboardRun: [found.step] });
      },

      paste(loc, opts) {
        guard();
        const { clipboard, clipboardRun, doc } = get();
        const copied = clipboardRun ?? (clipboard ? [clipboard] : null);
        if (!copied || copied.length === 0) return null;
        const at = atFromLocation(doc, loc);
        // Fresh relative to the doc and to the originals (which may have been deleted since).
        const scratch: WorkflowDoc = { ...doc, steps: [...copied, ...doc.steps] };
        const { steps } = cloneRunWithFreshIds(scratch, copied);
        const r = run([
          { op: "insertSteps", at, verbatim: true, steps: steps.map(stepToFragment) },
        ]);
        return commitNew(r, opts, steps);
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
        guard();
        travel("undo");
      },

      redo() {
        guard();
        travel("redo");
      },

      renameWorkflow(name) {
        const r = run([{ op: "renameWorkflow", name }]);
        if (r) commitApplied(r, {}, "workflowName");
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
        set({ ...derived(doc), ...local, selection: null, range: null });
      },
    };
  });
  readOnlyLocks.set(store, () => {
    lock.holders++;
    if (!store.getState().readOnly) store.setState({ readOnly: true });
    let held = true;
    return () => {
      if (!held) return;
      held = false;
      lock.holders--;
      const next = lock.base || lock.holders > 0;
      if (store.getState().readOnly !== next) store.setState({ readOnly: next });
    };
  });
  return store;
}

/** Each store's read-only hold (see {@link holdReadOnly}). */
const readOnlyLocks = new WeakMap<EditorStore, () => () => void>();

/**
 * @internal Keeps `store` read-only until the returned release runs (at most once). Holds
 * stack: the store is read-only while any hold is kept or the host's own
 * {@link EditorActions.setReadOnly} value is `true`. `<WorkflowCanvas readOnly>` holds its store
 * while mounted.
 */
export function holdReadOnly(store: EditorStore): () => void {
  const hold = readOnlyLocks.get(store);
  if (hold) return hold();
  // A store made elsewhere: set the flag and restore the previous value.
  const prev = store.getState().readOnly;
  store.getState().setReadOnly(true);
  let held = true;
  return () => {
    if (!held) return;
    held = false;
    store.getState().setReadOnly(prev);
  };
}

/** A history snapshot: a doc, and the step renames of the edit that replaced it (old → new). */
interface HistoryEntry {
  doc: WorkflowDoc;
  renamed: Record<string, string>;
  /**
   * The range when this snapshot was left (null: none). Undo and redo bring it back when the
   * range was lost on the way (e.g. undoing a duplicate removes the copies it moved to).
   */
  range?: { first: string; last: string } | null;
}

/** `a` then `b`, as one old → new map; identities are dropped. */
function composeRenames(
  a: Record<string, string>,
  b: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  const put = (k: string, v: string) => {
    if (k !== v)
      Object.defineProperty(out, k, {
        value: v,
        enumerable: true,
        writable: true,
        configurable: true,
      });
  };
  const via = new Set<string>();
  for (const [from, to] of Object.entries(a)) {
    via.add(to);
    put(from, Object.hasOwn(b, to) ? (b[to] as string) : to);
  }
  for (const [from, to] of Object.entries(b)) {
    if (!via.has(from) && !Object.hasOwn(a, from)) put(from, to);
  }
  return out;
}

/** The new → old map of an old → new rename map. */
function invertRenames(renamed: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [from, to] of Object.entries(renamed)) {
    Object.defineProperty(out, to, {
      value: from,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return out;
}

/** Whether a tool result is a failed ApplyResult. */
function isFailure(v: unknown): v is Extract<ApplyResult, { ok: false }> {
  return typeof v === "object" && v !== null && (v as { ok?: unknown }).ok === false;
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

/** The error of a doc change attempted in read-only mode. */
const READ_ONLY: ApplyError = {
  index: 0,
  path: "",
  code: "readOnly",
  message: "The editor is read-only",
};

/** Whether two step locations are in the same list. */
function sameList(a: StepLocation, b: StepLocation): boolean {
  return a.parentId === b.parentId && a.branch === b.branch;
}

/** The list a step location is in. */
function listOf(doc: WorkflowDoc, loc: StepLocation): Step[] | undefined {
  if (loc.parentId === null) return doc.steps;
  const parent = findStep(doc, loc.parentId)?.step;
  return parent && loc.branch !== undefined ? branchList(parent, loc.branch) : undefined;
}

/** The steps `first`…`last` of one list, in order, or `undefined` when they aren't a run. */
function runOf(doc: WorkflowDoc, first: string, last: string): Step[] | undefined {
  const a = findStep(doc, first);
  const z = findStep(doc, last);
  if (!a || !z || !sameList(a.location, z.location)) return undefined;
  if (a.location.index > z.location.index) return undefined;
  return listOf(doc, a.location)?.slice(a.location.index, z.location.index + 1);
}

/**
 * The range after an undo or redo from `before` to `after`: the current range carried over (see
 * {@link pruneRange}), else, when that is lost, the range `saved` with the snapshot if it is a
 * run of `after` again.
 */
function travelRange(
  before: WorkflowDoc,
  after: WorkflowDoc,
  range: { first: string; last: string } | null,
  renamed: Record<string, string>,
  saved: { first: string; last: string } | null | undefined,
): { first: string; last: string } | null {
  const carried = pruneRange(before, after, range, renamed);
  if (carried !== null || !saved) return carried;
  return runOf(after, saved.first, saved.last) ? saved : null;
}

/**
 * `range` carried from `before` to `after`: its endpoints follow `renamed`, and when they no
 * longer form a run, it shrinks to the members left in the first surviving member's list (or is
 * cleared when none are left).
 */
function pruneRange(
  before: WorkflowDoc,
  after: WorkflowDoc,
  range: { first: string; last: string } | null,
  renamed: Record<string, string> = {},
): { first: string; last: string } | null {
  if (range === null) return null;
  const map = (id: string) => (Object.hasOwn(renamed, id) ? (renamed[id] as string) : id);
  const first = map(range.first);
  const last = map(range.last);
  if (runOf(after, first, last)) {
    return first === range.first && last === range.last ? range : { first, last };
  }
  const members = runOf(before, range.first, range.last) ?? [];
  let list: StepLocation | undefined;
  let lo: { index: number; id: string } | undefined;
  let hi: { index: number; id: string } | undefined;
  for (const m of members) {
    const id = map(m.id);
    const loc = findStep(after, id)?.location;
    if (!loc) continue;
    list ??= loc;
    if (!sameList(list, loc)) continue;
    if (!lo || loc.index < lo.index) lo = { index: loc.index, id };
    if (!hi || loc.index > hi.index) hi = { index: loc.index, id };
  }
  return lo && hi ? { first: lo.id, last: hi.id } : null;
}

/**
 * IDs of the sections added or changed from `before` to `after`. Sections with the same ID are
 * paired in the order they occur (duplicate IDs exist in invalid docs), not by array index.
 */
function changedSections(before: readonly Section[], after: readonly Section[]): string[] {
  const was = new Map<string, Section[]>();
  for (const s of before) {
    const list = was.get(s.id);
    if (list) list.push(s);
    else was.set(s.id, [s]);
  }
  const seen = new Map<string, number>();
  const out = new Set<string>();
  for (const s of after) {
    const n = seen.get(s.id) ?? 0;
    seen.set(s.id, n + 1);
    const old = was.get(s.id)?.[n];
    if (!old || (old !== s && JSON.stringify(old) !== JSON.stringify(s))) out.add(s.id);
  }
  return [...out];
}
