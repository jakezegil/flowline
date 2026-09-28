/**
 * Every piece of text the canvas shows or announces, so hosts can translate it. Pass overrides
 * as `<FlowkitProvider labels={...}>`; anything not overridden uses the English default.
 *
 * @module
 */

import type { RunEventType, RunOrigin } from "@flowkit/core";
import type { RunStepStatus } from "./canvas/canvas-context";

/** The canvas's visible and accessible text. Functions build text that includes values. */
export interface FlowkitLabels {
  // Canvas and controls
  /** Accessible name of the canvas. */
  canvas: string;
  /** Screen-reader help on each card of a read-only canvas. */
  canvasHelpReadOnly: string;
  /** Screen-reader help on each card of an editable canvas. */
  canvasHelp: string;
  /** Screen-reader description of a connection. */
  edgeDescription: string;
  controls: string;
  zoomIn: string;
  zoomOut: string;
  fitView: string;

  // Trigger card
  /** The tag above the trigger card. */
  triggerTag: string;
  /** Accessible name of the trigger card. */
  triggerNode(name: string): string;
  /** Trigger name when its type isn't in the manifest. */
  triggerUnknown(type: string): string;
  triggerEvent(event: string | undefined): string;
  triggerWebhook: string;
  triggerManual: string;
  triggerSchedule(cron: string | undefined): string;
  triggerSubflow: string;

  // Step cards
  /** Subtitle of a step whose type isn't in the manifest. */
  unknownStep(type: string): string;
  /** Card summary of a condition without rules. */
  noConditions: string;
  /** Card summary of a condition whose first rule has no value to test yet. */
  conditionNotSet: string;
  /** Stands for the missing right-hand side of a rule in a card summary. */
  ruleValueNotSet: string;
  /** After a condition summary's first rule: the other rules, `or` when any may match. */
  moreRules(n: number, or: boolean): string;
  /** A trigger card's filters, after its caption: "Stage: Won". */
  triggerFilter(label: string, value: string): string;
  /** Subtitle of a card that can never run (an earlier step always ends the run). */
  neverRuns: string;
  /** The chip on a disabled step. */
  disabled: string;
  /** Accessible name of a disabled step's card. */
  disabledNode(name: string): string;
  /** Accessible name of the inline rename field. */
  stepName: string;
  /** Invalid badge: the count and messages of a step's issues. */
  issues(messages: string[]): string;
  /** Badge of a step edited since its last test. */
  needsTest: string;
  /** Badge of a tested step. */
  tested: string;
  /** Run status names, used for the badge and subtitle. */
  runStatus: Record<RunStepStatus["status"], string>;
  /** A run duration, e.g. "1.2s". */
  duration(ms: number): string;
  /** Retry count in a run subtitle, e.g. "3 attempts" (only shown for 2+). */
  attempts(n: number): string;
  loopIteration: string;
  previousIteration: string;
  nextIteration: string;

  // Summaries
  /** Pill label root for `{{trigger.…}}` references. */
  refTrigger: string;
  /** Pill label root for `{{loop.item…}}` references. */
  refItem: string;
  refLoopIndex: string;
  refRunId: string;
  /** An unset field without a default, from its label: "No subject". */
  noValue(label: string): string;
  /** A list value, e.g. "3 items". */
  items(n: number): string;

  // Data picker, reference inputs and code editor
  /** Accessible name of the data picker. */
  dataPicker: string;
  searchData: string;
  /** The data picker when nothing is in scope. */
  noScope: string;
  noDataMatches(query: string): string;
  /** Section caption of the trigger, a step and the enclosing loop. */
  scopeTrigger: string;
  scopeStep: string;
  scopeLoop: string;
  /** Caption on a disabled step's section: its output is empty at runtime. */
  scopeDisabled: string;
  /** A section whose output shape isn't known yet (no schema, no sample). */
  noKnownFields: string;
  /** The `[0]` row under a list. */
  firstItem: string;
  /** Hover button on an object or list row that inserts all of it. */
  insertWhole(name: string): string;
  /** Key hints in the picker footer. */
  keyNavigate: string;
  keyInsert: string;
  keyExpand: string;
  keyInsertWhole: string;
  /** The picker's keys, for screen readers (the footer hints are visual only). */
  pickerKeysHint: string;
  /** Under a search with more matches than the picker shows. */
  moreMatches(shown: number, total: number): string;
  /** Shown while browsing (no search) when there are more rows than the picker renders. */
  moreRows(shown: number, total: number): string;
  /** Tooltip label before a sample value. */
  sampleValue: string;
  /** Accessible name of a pill: "Load contact › email (string)". */
  refPill(label: string, type: string): string;
  /** Accessible name and tooltip of a reference that no longer resolves. */
  refStale(label: string): string;
  staleRefHint: string;
  /** Screen-reader help of a reference input. */
  refInputHint(multiline: boolean): string;
  /** Screen-reader help of a single-reference input. */
  refPickHint: string;
  /** The placeholder of a single-reference input. */
  pickValue: string;
  /** The button inside a reference input that opens the picker. */
  browseData: string;
  /** Screen-reader help of the code editor. */
  codeEditorHint: string;

  // Edges and placeholders
  /** The "+" buttons on connections, where nothing more specific applies. */
  addStepHere: string;
  /** A "+" after a step. */
  addStepAfter(step: string): string;
  /** The "+" under the trigger (`first`: the workflow has no steps yet). */
  addStepAfterTrigger(first: boolean): string;
  /** A "+" at the top of a branch, or an empty branch's placeholder. */
  addStepInBranch(branch: string, block: string): string;
  /** An empty branch's placeholder (also the picker's name when adding). */
  addStep: string;
  /** An empty branch on a read-only canvas. */
  noSteps: string;
  /** The label under the end of the workflow. */
  end: string;
  /** The label on a loop's body. */
  eachItem: string;
  /** A branch the step's type no longer declares. */
  leftoverBranch(key: string): string;
  leftoverBranchHint(key: string): string;

  // Menus
  actionsFor(name: string): string;
  rename: string;
  duplicate: string;
  copyReference: string;
  replace: string;
  enable: string;
  disable: string;
  copy: string;
  pasteAfter: string;
  pasteInsideBranch: string;
  pasteInsideLoop: string;
  delete: string;

  // Toasts
  referenceCopied: string;
  copyFailed(reference: string): string;
  stepCopied: string;
  stepDeleted: string;
  undo: string;
  dismiss: string;

  // Step picker
  replaceStep: string;
  searchSteps: string;
  replaceWith: string;
  noMatches(query: string): string;
  stepCategories: string;
  tabAll: string;
  /** The tab of Flowkit's built-in nodes. */
  tabLogic: string;

  // Formatting
  /** A time relative to now; `deltaMs` is negative in the past: "5 min ago", "in 6 days". */
  relativeTime(deltaMs: number): string;
  /** An absolute date and time, for tooltips. */
  dateTime(ts: number): string;

  // Workflow editor
  loadingWorkflow: string;
  loadWorkflowFailed: string;
  tryAgain: string;
  /** Accessible name of the workflow name field. */
  workflowName: string;
  untitledWorkflow: string;
  editorToolbar: string;
  redo: string;
  /** Status chip: unsaved edits. */
  statusUnsaved: string;
  /** Status chip: saved, not (or not this version) published. `null` = never saved. */
  statusDraft(version: number | null): string;
  /** Status chip: the saved version is the published one. */
  statusPublished(version: number): string;
  /** Status chip tooltip when an older version is live. */
  statusLive(version: number): string;
  /** Issues pill text. */
  issueCount(n: number): string;
  /** Issues pill of a workflow whose only issue is that it has no steps. */
  addFirstStep: string;
  /** Issues pill accessible description. */
  showNextIssue: string;
  /** Issues pill tooltip while cycling through the steps with issues: "Step 2 of 3 with issues". */
  issuePosition(i: number, n: number): string;
  save: string;
  saving: string;
  saved(version: number): string;
  saveFailed(message: string): string;
  /** Why a request failed when it never reached the server (in place of "Failed to fetch"). */
  serverUnreachable: string;
  run: string;
  /** Tooltip of Run when nothing is published yet. */
  runNeedsPublish: string;
  runDialogTitle: string;
  runDialogDescription(version: number): string;
  /** Note in the run dialog when the draft has changes the published version lacks. */
  runDraftNote: string;
  startRun: string;
  runStarted: string;
  runFailed(message: string): string;
  cancel: string;
  required: string;
  /** Placeholder of a JSON field in the run dialog. */
  jsonPlaceholder: string;
  /** Placeholder of a list field in the run dialog. */
  jsonListPlaceholder: string;
  invalidJson: string;
  invalidNumber: string;
  invalidDate: string;
  publish: string;
  publishing: string;
  published(version: number): string;
  /** Publish tooltip while the workflow has errors. */
  publishBlocked(errors: number): string;
  /** Publish tooltip when the saved version is already live. */
  alreadyPublished: string;
  /** Toast when the server rejects a publish (422). */
  publishRejected(issues: number): string;
  /** Toast when the server rejects a save (422). */
  saveRejected(issues: number): string;
  publishFailed(message: string): string;
  showIssues: string;
  closePanel: string;
  stepSettings: string;

  // Config panel
  /** Tab with the step's settings form. */
  configureTab: string;
  /** Tab where a step is tested (or the trigger's sample data is set). */
  testTab: string;
  /** Accessible name of the step name in the panel header, which renames it on click. */
  renameStep: string;
  /** The step's ID in the panel header, as used in references. */
  stepIdCaption(id: string): string;
  /** Shown instead of the form when the step's type isn't in the manifest. */
  unknownNodeHelp: string;
  /** Shown when a node has no config fields. */
  nothingToConfigure: string;
  /** Banner of a disabled step. */
  disabledBanner: string;
  enableStep: string;
  triggerType: string;
  webhookUrl: string;
  webhookUrlHint: string;
  /** Instead of the webhook URL until the workflow has been saved. */
  webhookSaveFirst: string;
  copyUrl: string;
  /** Explains an event trigger. */
  eventTriggerHint(event: string): string;
  /** Heading of a sub-flow's output mapping (in the trigger panel). */
  outputMapping: string;
  /** Explains the output mapping. */
  outputMappingHint: string;
  /** Instead of the output rows while the sub-flow declares no output fields. */
  outputMappingEmpty: string;
  /** Accessible name of an output's value field. */
  outputValue(name: string): string;
  /** Marks a mapped output that isn't declared (any more). */
  outputUndeclared: string;
  /** Removes an undeclared output from the mapping. */
  removeOutput(name: string): string;
  /** Screen-reader text of the required-field marker. */
  requiredField: string;
  /** Ref-mode toggle of number, boolean, choice and list fields. */
  useReference: string;
  useLiteral: string;
  editAsJson: string;
  editAsText: string;
  addItem: string;
  remove: string;
  moveUp: string;
  moveDown: string;
  /** Heading of an item in a list of objects: "Case 2". */
  itemTitle(label: string, n: number): string;
  addEntry: string;
  mapKey: string;
  mapValue: string;
  duplicateKey: string;
  chooseOption: string;
  noneOption: string;
  /** Choice of how rules combine. */
  rulesCombinator: Record<"and" | "or", string>;
  /** The chip between two rules. */
  rulesJoin: Record<"and" | "or", string>;
  rulesMatch: string;
  addRule: string;
  addGroup: string;
  removeRule: string;
  removeGroup: string;
  /** Name of a nested rule group: "Group 2". */
  ruleGroup: string;
  /** Placeholder of the value of an "is one of" rule. */
  ruleListPlaceholder: string;
  ruleLeft: string;
  ruleOperator: string;
  ruleRight: string;
  matchCase: string;
  /** Operator names of the rule builder. */
  ruleOps: Record<string, string>;
  /** Operator names when the value is a date. */
  ruleOpsDate: Record<string, string>;
  emptyRules: string;
  addCase: string;
  caseLabel: string;
  caseValue: string;
  /** The path ID under a switch case. */
  caseId(id: string): string;
  emptyCases: string;
  addField: string;
  fieldName: string;
  fieldType: string;
  fieldRequired: string;
  fieldDescription: string;
  fieldTypes: Record<"string" | "number" | "boolean" | "object" | "array" | "date", string>;
  invalidFieldName: string;
  duplicateField: string;
  emptyFields: string;
  loading: string;
  loadFailed(message: string): string;
  chooseSubflow: string;
  noSubflows: string;
  subflowFirst: string;
  subflowNoInput: string;
  chooseSecret: string;
  noSecrets: string;
  /** A selected secret the server doesn't list. */
  secretMissing(name: string): string;

  // Step test
  testStep: string;
  testing: string;
  testAgain: string;
  testIntro: string;
  testInput: string;
  testOutput: string;
  testError: string;
  /** Heading of a stored sample from an earlier test. */
  testSample: string;
  testDuration(ms: number): string;
  testBranch(branch: string): string;
  testSignal: Record<"suspend" | "stop" | "subflow", string>;
  testFailed(message: string): string;
  upstreamUntested: string;
  /** Names of the untested steps a test depends on. */
  upstreamList(names: string[]): string;
  addTriggerSample: string;
  notTested: string;
  needsRetest: string;
  sampleTypeChanged: string;
  triggerSample: string;
  manualSample: string;
  triggerSampleHint: string;
  fillFromFields: string;
  saveSample: string;
  clearSample: string;
  sampleSaved: string;

  // Run viewer
  loadingRun: string;
  loadRunFailed: string;
  /** Run status names. */
  runState: Record<"queued" | "running" | "waiting" | "completed" | "failed" | "cancelled", string>;
  /** A completed run that a Stop step ended early. */
  runStopped: string;
  cancelling: string;
  version(version: number): string;
  started(relative: string): string;
  /** What started a run. */
  origin(origin: RunOrigin): string;
  retryFromFailed: string;
  retryStarted: string;
  retryFailed(message: string): string;
  cancelRun: string;
  /** Title of the confirm that Cancel run opens. */
  cancelRunConfirm: string;
  cancelRunConfirmBody: string;
  /** Backs out of cancelling a run. */
  keepRunning: string;
  cancelFailed(message: string): string;
  resume: string;
  resumeTitle: string;
  resumeDescription: string;
  callbackBody: string;
  resumed: string;
  resumeFailed(message: string): string;
  /** The waiting step's callback line, e.g. "Waiting for callback · expires in 6 days". */
  waitingForCallback(expires: string | undefined): string;
  waitingUntil(when: string): string;
  waitingForSubflow: string;
  failedAt(step: string): string;
  /** Title of a stopped run's banner, e.g. "Stopped at Reject lead". */
  stoppedAt(step: string): string;
  /**
   * The waiting line of a step the host app resumes (`resume.hostHandled`, e.g. an approval), in
   * place of {@link FlowkitLabels.waitingForCallback}: "Waiting for a decision · expires in 3 days".
   */
  waitingForDecision(expires: string | undefined): string;
  /** Title of a cancelled run's banner when it was waiting at a step. */
  cancelledWhileWaiting(step: string): string;
  /** Title of a cancelled run's banner when a step was running (or queued) as it was cancelled. */
  cancelledAt(step: string): string;
  /** Who cancelled a run, in its banner: "By Ava Chen". */
  cancelledBy(who: string): string;
  /** A step a finished run never reached (its Output tab). */
  didNotRun: string;
  iterationOf(i: number, n: number): string;
  showStep: string;
  runSummary: string;
  tabInput: string;
  tabOutput: string;
  tabError: string;
  tabTimeline: string;
  inspectorTabs: string;
  noInput: string;
  noOutput: string;
  noError: string;
  noEvents: string;
  notRun: string;
  notTaken: string;
  /** Tab names when the trigger is inspected: payload, run output, run error, all events. */
  triggerInput: string;
  runOutput: string;
  errorCode: string;
  /** Timeline detail of a branching step's completion. */
  tookBranch(branch: string): string;
  /** A timeline retry event: "Attempt 2 in 4s". */
  retryAttempt(attempt: number, delayMs?: number): string;
  /** Audit event names. */
  eventType: Record<RunEventType, string>;
  copyJson: string;
  copied: string;
  expand: string;
  collapse: string;
  /** Tooltip on masked values. */
  redacted: string;
  /** Short text shown in place of a masked value. */
  redactedValue: string;
  keys(n: number): string;

  // Run list
  runs: string;
  filterRuns: string;
  /** The run list filter showing every status. */
  allRuns: string;
  noRuns: string;
  noRunsWithStatus(status: string): string;
  loadRunsFailed: string;

  // Not found, resume guidance
  /** Title of the editor's state for a workflow ID that doesn't exist. */
  workflowNotFound: string;
  workflowNotFoundDetail(workflowId: string): string;
  /** The editor's not-found action with `notFoundAction="create"`: a new workflow under the ID. */
  createWorkflow: string;
  /** The editor's default not-found action: back to the previous page. */
  goBack: string;
  /** Title of the run viewer's state for a run ID that doesn't exist. */
  runNotFound: string;
  runNotFoundDetail(runId: string): string;
  /** Shown instead of Resume… when the waiting step is resumed from the host app. */
  resumeHandledByApp: string;
  /** The resume dialog's body field is empty but the step expects a body. */
  callbackBodyRequired: string;
  /** Resume dialog: the body the waiting step expects, e.g. "Expects { decision }". */
  callbackBodyExpects(type: string): string;
}

/** Formats a run duration: `850ms`, `1.2s`, `2m 5s`, `1h 35m`, `1d 2h`. */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
  const pair = (big: number, bigUnit: string, small: number, smallUnit: string) =>
    small ? `${big}${bigUnit} ${small}${smallUnit}` : `${big}${bigUnit}`;
  if (ms < 3_600_000) {
    return pair(Math.floor(ms / 60_000), "m", Math.round((ms % 60_000) / 1000), "s");
  }
  if (ms < 86_400_000) {
    return pair(Math.floor(ms / 3_600_000), "h", Math.floor((ms % 3_600_000) / 60_000), "m");
  }
  return pair(Math.floor(ms / 86_400_000), "d", Math.floor((ms % 86_400_000) / 3_600_000), "h");
}

/** "Subject" → "No subject"; acronyms like "URL" keep their case. */
function noValue(label: string): string {
  const second = label.charAt(1);
  const acronym =
    second !== "" && second === second.toUpperCase() && second !== second.toLowerCase();
  return `No ${acronym ? label : label.charAt(0).toLowerCase() + label.slice(1)}`;
}

const nav = "Use the arrow keys to move between steps, and Enter or Space to open one.";
/** The "+" buttons between steps are pointer targets outside the Tab order; ⌘K reaches them. */
const add =
  'Press Control+K (Command+K on a Mac) to add a step after this one (what the "+" between steps does), Shift with it to add one before';

/** The English defaults. */
export const defaultLabels: FlowkitLabels = {
  canvas: "Workflow canvas",
  canvasHelpReadOnly: nav,
  canvasHelp: `${nav} ${add}, Delete to remove it, and Escape to clear the selection.`,
  edgeDescription: "Connection between steps.",
  controls: "Canvas controls",
  zoomIn: "Zoom in",
  zoomOut: "Zoom out",
  fitView: "Fit workflow to view",

  triggerTag: "Trigger",
  triggerNode: (name) => `Trigger: ${name}`,
  triggerUnknown: (type) => `Unknown trigger type ${type}`,
  triggerEvent: (event) => (event ? `When ${event} happens` : "When an event happens"),
  triggerWebhook: "When a webhook is called",
  triggerManual: "When run manually",
  triggerSchedule: (cron) => (cron ? `On schedule ${cron}` : "On a schedule"),
  triggerSubflow: "When called by another workflow",

  unknownStep: (type) => `Unknown step type ${type}`,
  noConditions: "No conditions",
  conditionNotSet: "Condition not set",
  ruleValueNotSet: "(not set)",
  moreRules: (n, or) => `${or ? "or" : "and"} ${n} more`,
  triggerFilter: (label, value) => `${label}: ${value}`,
  neverRuns: "Never runs: an earlier step ends the run",
  disabled: "Disabled",
  disabledNode: (name) => `${name} (disabled)`,
  stepName: "Step name",
  issues: (messages) =>
    `${messages.length} ${messages.length === 1 ? "issue" : "issues"}: ${messages.join("; ")}`,
  needsTest: "Edited since last test",
  tested: "Tested",
  runStatus: {
    done: "Succeeded",
    failed: "Failed",
    running: "Running",
    waiting: "Waiting",
    skipped: "Skipped",
    pending: "Not run yet",
    stopped: "Stopped the run",
    cancelled: "Cancelled",
  },
  duration: formatDuration,
  attempts: (n) => `${n} attempts`,
  loopIteration: "Loop iteration",
  previousIteration: "Previous iteration",
  nextIteration: "Next iteration",

  refTrigger: "Trigger",
  refItem: "Item",
  refLoopIndex: "Loop index",
  refRunId: "Run ID",
  noValue,
  items: (n) => (n === 1 ? "1 item" : `${n} items`),

  dataPicker: "Insert data",
  searchData: "Search data",
  noScope: "No data yet — add a step above or configure the trigger.",
  noDataMatches: (query) => `No data matches “${query}”.`,
  scopeTrigger: "Trigger",
  scopeStep: "Step",
  scopeLoop: "Loop",
  scopeDisabled: "Disabled · empty at runtime",
  noKnownFields: "No fields known yet. Test this step to see its output.",
  firstItem: "First item",
  insertWhole: (name) => `Insert all of ${name}`,
  keyNavigate: "navigate",
  keyInsert: "insert",
  keyExpand: "expand",
  keyInsertWhole: "insert all",
  pickerKeysHint:
    "Up and Down arrows move through the data. Enter inserts a value or opens a group; Shift+Enter inserts a whole group. Right and Left arrows open and close groups. Escape returns to the field.",
  moreMatches: (shown, total) => `Showing ${shown} of ${total} — refine your search to see more.`,
  moreRows: (shown, total) =>
    `Showing ${shown} of ${total} — search or collapse a section to see more.`,
  sampleValue: "Sample",
  refPill: (label, type) => `${label} (${type})`,
  refStale: (label) => `${label}: not available here`,
  staleRefHint: "This reference points at data that isn't available to this step anymore.",
  refInputHint: (multiline) =>
    `Type {{ to insert data, or press ${multiline ? "Alt+Down arrow" : "Down arrow"} to browse it.`,
  refPickHint: "Press Down arrow to choose a value. Backspace clears it.",
  pickValue: "Choose a value…",
  browseData: "Browse data",
  codeEditorHint:
    "Type steps. or trigger. for suggestions. Press Escape, then Tab, to leave the editor.",

  addStepHere: "Add step here",
  addStepAfter: (step) => `Add step after ${step}`,
  addStepAfterTrigger: (first) => (first ? "Add first step" : "Add step after the trigger"),
  addStepInBranch: (branch, block) => `Add step to ${branch} of ${block}`,
  addStep: "Add step",
  noSteps: "No steps",
  end: "End",
  eachItem: "Each item",
  leftoverBranch: (key) => `Leftover: ${key}`,
  leftoverBranchHint: (key) =>
    `The "${key}" branch isn't part of this step's type anymore. Move or delete its steps.`,

  actionsFor: (name) => `Actions for ${name}`,
  rename: "Rename",
  duplicate: "Duplicate",
  copyReference: "Copy reference",
  replace: "Replace…",
  enable: "Enable",
  disable: "Disable",
  copy: "Copy",
  pasteAfter: "Paste after",
  pasteInsideBranch: "Paste inside branch",
  pasteInsideLoop: "Paste inside loop",
  delete: "Delete",

  referenceCopied: "Reference copied",
  copyFailed: (reference) => `Couldn't copy. The reference is ${reference}`,
  stepCopied: "Step copied",
  stepDeleted: "Step deleted",
  undo: "Undo",
  dismiss: "Dismiss",

  replaceStep: "Replace step",
  searchSteps: "Search steps",
  replaceWith: "Replace with…",
  noMatches: (query) => `No steps match “${query}”.`,
  stepCategories: "Step categories",
  tabAll: "All",
  tabLogic: "Logic",

  relativeTime,
  dateTime: (ts) =>
    new Date(ts).toLocaleString("en", {
      dateStyle: "medium",
      timeStyle: "medium",
    }),

  loadingWorkflow: "Loading workflow…",
  loadWorkflowFailed: "Couldn't load this workflow.",
  tryAgain: "Try again",
  workflowName: "Workflow name",
  untitledWorkflow: "Untitled workflow",
  editorToolbar: "Workflow actions",
  redo: "Redo",
  statusUnsaved: "Unsaved changes",
  statusDraft: (v) => (v === null ? "Draft" : `Draft · v${v}`),
  statusPublished: (v) => `Published v${v}`,
  statusLive: (v) => `v${v} is live`,
  issueCount: (n) => (n === 1 ? "1 issue" : `${n} issues`),
  addFirstStep: "Add a first step",
  showNextIssue: "Select the next step with an issue",
  issuePosition: (i, n) => `Step ${i} of ${n} with issues`,
  save: "Save",
  saving: "Saving…",
  saved: (v) => `Saved as v${v}`,
  saveFailed: (m) => `Couldn't save. ${m}`,
  serverUnreachable: "The server can't be reached. Check your connection, then try again.",
  run: "Run",
  runNeedsPublish: "Publish the workflow to run it",
  runDialogTitle: "Run workflow",
  runDialogDescription: (v) => `Starts a run of the published version, v${v}.`,
  runDraftNote: "Your unpublished changes aren't part of this run.",
  startRun: "Start run",
  runStarted: "Run started",
  runFailed: (m) => `Couldn't start the run. ${m}`,
  cancel: "Cancel",
  required: "Required",
  jsonPlaceholder: "JSON, e.g. {}",
  jsonListPlaceholder: 'A JSON list, e.g. ["gold", "silver"]',
  invalidJson: "Enter valid JSON",
  invalidNumber: "Enter a number",
  invalidDate: "Enter a date and time",
  publish: "Publish",
  publishing: "Publishing…",
  published: (v) => `Published v${v}`,
  publishBlocked: (n) => `Fix ${n === 1 ? "1 error" : `${n} errors`} to publish`,
  alreadyPublished: "This version is already live",
  publishRejected: (n) =>
    n === 0
      ? "Publishing was blocked"
      : `Publishing was blocked by ${n === 1 ? "1 issue" : `${n} issues`}`,
  saveRejected: (n) =>
    n === 0 ? "Saving was blocked" : `Saving was blocked by ${n === 1 ? "1 issue" : `${n} issues`}`,
  publishFailed: (m) => `Couldn't publish. ${m}`,
  showIssues: "Show",
  closePanel: "Close panel",
  stepSettings: "Step settings",

  configureTab: "Configure",
  testTab: "Test",
  renameStep: "Rename step",
  stepIdCaption: (id) => `ID ${id}`,
  unknownNodeHelp: "This step's type isn't available here, so it can't be configured.",
  nothingToConfigure: "This step has nothing to configure.",
  disabledBanner: "This step is disabled. Runs skip it.",
  enableStep: "Enable",
  triggerType: "Trigger type",
  webhookUrl: "Webhook URL",
  webhookUrlHint: "POST a JSON body to this URL to start a run of the published version.",
  webhookSaveFirst: "Save the workflow to generate its URL.",
  copyUrl: "Copy URL",
  eventTriggerHint: (event) => `Runs every time the ${event} event happens.`,
  outputMapping: "Output values",
  outputMappingHint:
    "What this sub-flow returns to the workflow that ran it. Pick each value from the trigger or the top-level steps.",
  outputMappingEmpty: "Declare output fields above to map their values here.",
  outputValue: (name) => `Output ${name}`,
  outputUndeclared: "Not a declared output field, so calling workflows can't pick it.",
  removeOutput: (name) => `Remove output ${name}`,
  requiredField: "(required)",
  useReference: "Use data from earlier steps",
  useLiteral: "Enter a value instead",
  editAsJson: "Edit as JSON",
  editAsText: "Edit as text",
  addItem: "Add item",
  remove: "Remove",
  moveUp: "Move up",
  moveDown: "Move down",
  itemTitle: (label, n) => `${label} ${n}`,
  addEntry: "Add entry",
  mapKey: "Key",
  mapValue: "Value",
  duplicateKey: "This key is used twice",
  chooseOption: "Choose…",
  noneOption: "None",
  rulesCombinator: { and: "All rules", or: "Any rule" },
  rulesJoin: { and: "and", or: "or" },
  rulesMatch: "Match",
  addRule: "Add rule",
  addGroup: "Add group",
  removeRule: "Remove rule",
  removeGroup: "Remove group",
  ruleGroup: "Group",
  ruleListPlaceholder: "gold, silver, bronze",
  ruleLeft: "Value",
  ruleOperator: "Operator",
  ruleRight: "Compare with",
  matchCase: "Match case",
  ruleOps: {
    eq: "equals",
    neq: "does not equal",
    gt: "is greater than",
    gte: "is at least",
    lt: "is less than",
    lte: "is at most",
    contains: "contains",
    notContains: "does not contain",
    startsWith: "starts with",
    endsWith: "ends with",
    in: "is one of",
    isEmpty: "is empty",
    isNotEmpty: "is not empty",
    isTrue: "is true",
    isFalse: "is false",
  },
  ruleOpsDate: {
    eq: "is",
    neq: "is not",
    gt: "is after",
    gte: "is on or after",
    lt: "is before",
    lte: "is on or before",
  },
  emptyRules: "No rules yet. Without rules, the Else path always runs.",
  addCase: "Add case",
  caseLabel: "Case name",
  caseValue: "Matches",
  caseId: (id) => `Path ID ${id}`,
  emptyCases: "No cases yet. Every value takes the Default path.",
  addField: "Add field",
  fieldName: "Field name",
  fieldType: "Type",
  fieldRequired: "Required",
  fieldDescription: "Description (optional)",
  fieldTypes: {
    string: "Text",
    number: "Number",
    boolean: "True / false",
    object: "Object",
    array: "List",
    date: "Date",
  },
  invalidFieldName: "Use letters, digits and _, not starting with a digit",
  duplicateField: "Another field has this name",
  emptyFields: "No fields yet.",
  loading: "Loading…",
  loadFailed: (m) => `Couldn't load. ${m}`,
  chooseSubflow: "Choose a workflow",
  noSubflows: "No workflows can be called yet. Publish a workflow with a sub-flow trigger first.",
  subflowFirst: "Choose a workflow to set its input.",
  subflowNoInput: "This workflow takes no input.",
  chooseSecret: "Choose a secret",
  noSecrets: "No secrets are configured.",
  secretMissing: (name) => `${name} (not found)`,

  testStep: "Test step",
  testing: "Testing…",
  testAgain: "Test again",
  testIntro: "Runs only this step, using the sample data of the trigger and earlier steps.",
  testInput: "Input",
  testOutput: "Output",
  testError: "Error",
  testSample: "Output of the last test",
  testDuration: (ms) => `Took ${formatDuration(ms)}`,
  testBranch: (branch) => `Takes the ${branch} path`,
  testSignal: {
    suspend: "Would pause the run here",
    stop: "Would stop the run here",
    subflow: "Would call a workflow",
  },
  testFailed: (m) => `The test couldn't run. ${m}`,
  upstreamUntested: "Upstream steps haven't been tested; references will be empty.",
  upstreamList: (names) => `Test first: ${names.join(", ")}.`,
  addTriggerSample: "Add trigger sample",
  notTested: "Not tested yet",
  needsRetest: "Needs re-test",
  sampleTypeChanged: "The step's type changed since its last test.",
  triggerSample: "Sample data",
  manualSample: "Sample input",
  triggerSampleHint:
    "Stands in for the trigger's data when you pick fields and test steps. It stays in this browser.",
  fillFromFields: "Fill from fields",
  saveSample: "Save sample",
  clearSample: "Clear",
  sampleSaved: "Sample saved",

  loadingRun: "Loading run…",
  loadRunFailed: "Couldn't load this run.",
  runState: {
    queued: "Queued",
    running: "Running",
    waiting: "Waiting",
    completed: "Completed",
    failed: "Failed",
    cancelled: "Cancelled",
  },
  runStopped: "Stopped",
  cancelling: "Cancelling…",
  version: (v) => `v${v}`,
  started: (rel) => `Started ${rel}`,
  origin: (o) => {
    switch (o.kind) {
      case "event":
        return `Event ${o.event}`;
      case "webhook":
        return "Webhook";
      case "manual":
        return "Run manually";
      case "schedule":
        return "Schedule";
      case "subflow":
        return "Called by another workflow";
    }
  },
  retryFromFailed: "Retry from failed step",
  retryStarted: "Retry started",
  retryFailed: (m) => `Couldn't retry. ${m}`,
  cancelRun: "Cancel run",
  cancelRunConfirm: "Cancel this run?",
  cancelRunConfirmBody: "Steps that already finished stay done. Nothing after them runs.",
  keepRunning: "Keep running",
  cancelFailed: (m) => `Couldn't cancel. ${m}`,
  resume: "Resume…",
  resumeTitle: "Resume run",
  resumeDescription:
    "The waiting step continues as if its callback arrived, with this JSON as the callback body.",
  callbackBody: "Callback body",
  resumed: "Run resumed",
  resumeFailed: (m) => `Couldn't resume. ${m}`,
  waitingForCallback: (expires) =>
    expires ? `Waiting for callback · expires ${expires}` : "Waiting for callback",
  waitingUntil: (when) => `Waiting until ${when}`,
  waitingForSubflow: "Waiting for a called workflow to finish",
  failedAt: (step) => `Failed at ${step}`,
  stoppedAt: (step) => `Stopped at ${step}`,
  waitingForDecision: (expires) =>
    expires ? `Waiting for a decision · expires ${expires}` : "Waiting for a decision",
  cancelledWhileWaiting: (step) => `Cancelled while waiting at ${step}`,
  cancelledAt: (step) => `Cancelled at ${step}`,
  cancelledBy: (who) => `By ${who}`,
  didNotRun: "This step didn't run: the run ended before reaching it.",
  iterationOf: (i, n) => `iteration ${i} of ${n}`,
  showStep: "Show step",
  runSummary: "Run details",
  tabInput: "Input",
  tabOutput: "Output",
  tabError: "Error",
  tabTimeline: "Timeline",
  inspectorTabs: "Step details",
  noInput: "No input was recorded for this step.",
  noOutput: "This step has no output yet.",
  noError: "No error.",
  noEvents: "Nothing has happened here yet.",
  notRun: "This step hasn't run.",
  notTaken: "The run took another branch, so this step didn't run.",
  triggerInput: "Payload",
  runOutput: "Run output",
  errorCode: "Code",
  tookBranch: (b) => `Took the “${b}” branch`,
  retryAttempt: (n, delay) =>
    delay !== undefined ? `Attempt ${n} in ${formatDuration(delay)}` : `Attempt ${n}`,
  eventType: {
    "run.started": "Run started",
    "step.started": "Started",
    "step.completed": "Completed",
    "step.failed": "Failed",
    "step.retrying": "Retrying",
    "step.skipped": "Skipped",
    "step.afterCommitFailed": "Notification failed",
    "run.suspended": "Waiting",
    "run.resumed": "Resumed",
    "run.completed": "Run completed",
    "run.failed": "Run failed",
    "run.cancelled": "Run cancelled",
    "run.stopped": "Run stopped",
  },
  copyJson: "Copy JSON",
  copied: "Copied",
  expand: "Expand",
  collapse: "Collapse",
  redacted: "Hidden: secret or sensitive value",
  redactedValue: "hidden",
  keys: (n) => (n === 1 ? "1 field" : `${n} fields`),

  runs: "Runs",
  filterRuns: "Filter runs by status",
  allRuns: "All",
  noRuns: "No runs yet. Runs appear here as soon as the workflow is triggered.",
  noRunsWithStatus: (status) => `No ${status.toLowerCase()} runs.`,
  loadRunsFailed: "Couldn't load runs.",

  workflowNotFound: "Workflow not found",
  workflowNotFoundDetail: (id) => `There is no workflow with the ID “${id}”.`,
  createWorkflow: "Create this workflow",
  goBack: "Go back",
  runNotFound: "Run not found",
  runNotFoundDetail: (id) => `There is no run with the ID “${id}”. It may have been deleted.`,
  resumeHandledByApp: "This step is resumed from the app, not from here.",
  callbackBodyRequired: "Enter the callback body",
  callbackBodyExpects: (type) => `Expects ${type}`,
};

/** "just now", "5 min ago", "in a few seconds", "in 6 days". */
function relativeTime(deltaMs: number): string {
  const abs = Math.abs(deltaMs);
  // A moment ahead is still ahead: a wait ending in 30s isn't "just now".
  if (abs < 45_000) return deltaMs > 1_000 ? "in a few seconds" : "just now";
  const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto", style: "short" });
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ["minute", 60_000],
    ["hour", 3_600_000],
    ["day", 86_400_000],
    ["week", 604_800_000],
    ["month", 2_592_000_000],
    ["year", 31_536_000_000],
  ];
  let [unit, size] = units[0] as [Intl.RelativeTimeFormatUnit, number];
  for (const [u, s] of units) {
    if (abs >= s * 0.9) [unit, size] = [u, s];
  }
  return rtf.format(Math.round(deltaMs / size), unit);
}

/** `defaultLabels` with `overrides` applied (record-valued labels merge key by key). */
export function resolveLabels(overrides: Partial<FlowkitLabels> | undefined): FlowkitLabels {
  if (!overrides) return defaultLabels;
  return {
    ...defaultLabels,
    ...overrides,
    runStatus: { ...defaultLabels.runStatus, ...overrides.runStatus },
    runState: { ...defaultLabels.runState, ...overrides.runState },
    eventType: { ...defaultLabels.eventType, ...overrides.eventType },
    rulesCombinator: { ...defaultLabels.rulesCombinator, ...overrides.rulesCombinator },
    rulesJoin: { ...defaultLabels.rulesJoin, ...overrides.rulesJoin },
    ruleOps: { ...defaultLabels.ruleOps, ...overrides.ruleOps },
    ruleOpsDate: { ...defaultLabels.ruleOpsDate, ...overrides.ruleOpsDate },
    fieldTypes: { ...defaultLabels.fieldTypes, ...overrides.fieldTypes },
    testSignal: { ...defaultLabels.testSignal, ...overrides.testSignal },
  };
}
