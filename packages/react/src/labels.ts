/**
 * Every piece of text the canvas shows or announces, so hosts can translate it. Pass overrides
 * as `<FlowkitProvider labels={...}>`; anything not overridden uses the English default.
 *
 * @module
 */

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
}

/** Formats a run duration: `850ms`, `1.2s`, `2m 5s`. */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return s ? `${m}m ${s}s` : `${m}m`;
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
};

/** `defaultLabels` with `overrides` applied (run statuses merge key by key). */
export function resolveLabels(overrides: Partial<FlowkitLabels> | undefined): FlowkitLabels {
  if (!overrides) return defaultLabels;
  return {
    ...defaultLabels,
    ...overrides,
    runStatus: { ...defaultLabels.runStatus, ...overrides.runStatus },
  };
}
