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

  // Edges and placeholders
  /** The "+" buttons on connections. */
  addStepHere: string;
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
  /** Issues pill accessible description. */
  showNextIssue: string;
  /** Issues pill tooltip while cycling through the steps with issues: "Step 2 of 3 with issues". */
  issuePosition(i: number, n: number): string;
  save: string;
  saving: string;
  saved(version: number): string;
  saveFailed(message: string): string;
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
  publishFailed(message: string): string;
  showIssues: string;
  closePanel: string;
  /** Right-panel placeholder until a configuration panel is plugged in. */
  panelPlaceholder: string;
  stepSettings: string;

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

const nav = "Use the arrow keys to move between steps and Enter to open one.";

/** The English defaults. */
export const defaultLabels: FlowkitLabels = {
  canvas: "Workflow canvas",
  canvasHelpReadOnly: nav,
  canvasHelp: `${nav} Press Delete to remove the selected step, and Escape to clear the selection.`,
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

  addStepHere: "Add step here",
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
  showNextIssue: "Select the next step with an issue",
  issuePosition: (i, n) => `Step ${i} of ${n} with issues`,
  save: "Save",
  saving: "Saving…",
  saved: (v) => `Saved as v${v}`,
  saveFailed: (m) => `Couldn't save. ${m}`,
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
  publishFailed: (m) => `Couldn't publish. ${m}`,
  showIssues: "Show",
  closePanel: "Close panel",
  panelPlaceholder: "Settings for this step appear here.",
  stepSettings: "Step settings",

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

/** "just now", "5 min ago", "in 6 days". */
function relativeTime(deltaMs: number): string {
  const abs = Math.abs(deltaMs);
  if (abs < 45_000) return "just now";
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

/** `defaultLabels` with `overrides` applied (run statuses merge key by key). */
export function resolveLabels(overrides: Partial<FlowkitLabels> | undefined): FlowkitLabels {
  if (!overrides) return defaultLabels;
  return {
    ...defaultLabels,
    ...overrides,
    runStatus: { ...defaultLabels.runStatus, ...overrides.runStatus },
    runState: { ...defaultLabels.runState, ...overrides.runState },
    eventType: { ...defaultLabels.eventType, ...overrides.eventType },
  };
}
