/**
 * The commands `apply` runs on a workflow doc, their results and errors, plus the internal
 * handler contract the command modules share.
 *
 * @module
 */
import type { ValidationContext } from "../scope";
import type { AnnotationColor, Manifest, NodeManifest, ValueExpr, WorkflowDoc } from "../types";
import type { Issue } from "../validate";
import type { FollowUp } from "./read-types";

/**
 * A step argument: a real step ID, `"$<n>"` for the step `commands[n-1]` created in the same
 * batch (1-based), or `"$<ref>"` for a fragment step with that `ref`.
 *
 * @example
 * "getDeal" // a real ID
 * "$1"      // the step the first command created
 */
export type StepRef = string;

/**
 * Where a step goes: after or before a step, into a branch (at `index`, default the end), or at
 * the start of the top-level list. For moves, the anchor is resolved after the moved step is
 * taken out.
 *
 * @example
 * { after: "getDeal" }
 * { in: { stepId: "recheck", branch: "else" }, index: 0 }
 */
export type At =
  | { after: StepRef }
  | { before: StepRef }
  | { in: { stepId: StepRef; branch: string }; index?: number }
  | { start: true };

/** A new section's fields. `id` defaults to one derived from the title. */
export interface SectionInput {
  /** The section's title. */
  title: string;
  /** Its colour. */
  color: AnnotationColor;
  /** An optional note. */
  note?: string;
  /** An explicit section ID. */
  id?: string;
}

/** Config keys to set; `null` removes a key. */
export type ConfigPatch = Record<string, ValueExpr | null>;

/**
 * The single-step, trigger, output and workflow commands besides addStep, moveStep, removeStep
 * and setConfig.
 *
 * - `duplicateStep` copies a step (and its subtree) right after it, with fresh IDs, and names the
 *   copy `"<name> (copy)"`, `"(copy 2)"`, …; `$n` is the copy's ID.
 * - `renameStep` sets the display name (trimmed); `""` clears it.
 * - `renameStepId` changes the ID and rewrites every reference to it; `$n` is the new ID.
 * - `setType` is the editor's Replace: config resets to the new node's defaults, children are
 *   kept, and an ID generated from the old type is regenerated; `$n` is the resulting ID.
 * - `setNote`: at most 4000 chars; `null` or `""` removes the note. `setColor`: `null` removes.
 * - `setTrigger`: the same type with no `config` changes nothing, the same type with `config`
 *   merges it, another type resets the config to its defaults and then merges `config`.
 * - `setTriggerConfig` / `setOutput` set one key or merge `config`; `null` removes a key.
 *   Removing the last output key removes `output`.
 * - `renameWorkflow` sets the workflow's name (trimmed, not blank).
 *
 * @example
 * { op: "duplicateStep", id: "notify" }
 * { op: "setType", id: "notify", type: "crm.getDeal" }
 * { op: "setTrigger", type: "crm.dealStuckInStage", config: { stage: "won" } }
 */
export type SingleCommand =
  | { op: "duplicateStep"; id: StepRef }
  | { op: "renameStep"; id: StepRef; name: string }
  | { op: "renameStepId"; id: StepRef; newId: string }
  | { op: "setType"; id: StepRef; type: string }
  | { op: "setDisabled"; id: StepRef; disabled: boolean }
  | { op: "setNote"; id: StepRef; note: string | null }
  | { op: "setColor"; id: StepRef; color: AnnotationColor | null }
  | { op: "setTrigger"; type: string; config?: ConfigPatch }
  | {
      op: "setTriggerConfig";
      key: string;
      value: ValueExpr | null;
      /** @internal Store `null` as a value instead of removing the key. */
      nullIsValue?: boolean;
    }
  | { op: "setTriggerConfig"; config: ConfigPatch }
  | {
      op: "setOutput";
      key: string;
      value: ValueExpr | null;
      /** @internal Store `null` as a value instead of removing the key. */
      nullIsValue?: boolean;
    }
  | { op: "setOutput"; config: ConfigPatch }
  | { op: "renameWorkflow"; name: string };

/**
 * The section commands. Section-ID arguments accept placeholders (`$n` of an `addSection`).
 *
 * - `addSection` wraps the run `first`…`last` (one step list, in order) in a new section; it
 *   fails with `run.invalid` otherwise, and with `section.overlap` when the run overlaps a
 *   section in the same list (nesting inside a branch is fine). `$n` is the section's ID.
 * - `updateSection` changes the given fields; `note: null` or `""` removes the note, and a new
 *   `first`/`last` is checked like `addSection`'s run.
 * - `removeSection` removes the section and keeps its steps.
 *
 * When two sections share an ID, `updateSection` and `removeSection` act on the later one.
 *
 * @example
 * { op: "addSection", first: "getDeal", last: "recheck", title: "Check the deal", color: "blue" }
 * { op: "updateSection", id: "$1", color: "green" }
 */
export type SectionCommand =
  | ({ op: "addSection"; first: StepRef; last: StepRef } & SectionInput)
  | {
      op: "updateSection";
      id: StepRef;
      title?: string;
      color?: AnnotationColor;
      note?: string | null;
      first?: StepRef;
      last?: StepRef;
    }
  | { op: "removeSection"; id: StepRef };
/** The bulk commands (added by a later release step). */
export type BulkCommand = never;

/**
 * One edit `apply` runs. Every command is `{ op, … }`; step arguments accept placeholders
 * ({@link StepRef}).
 *
 * @example
 * { op: "addStep", at: { after: "getDeal" }, type: "crm.sendEmail", config: { subject: "Hi" } }
 * { op: "setConfig", id: "$1", key: "to", value: "a@b.c" }
 */
export type Command =
  | {
      op: "addStep";
      at: At;
      type: string;
      id?: string;
      name?: string;
      config?: Record<string, ValueExpr>;
      note?: string;
      color?: AnnotationColor;
      disabled?: boolean;
    }
  | { op: "moveStep"; id: StepRef; to: At }
  | { op: "removeStep"; id: StepRef }
  | {
      op: "setConfig";
      id: StepRef;
      key: string;
      value: ValueExpr | null;
      /** @internal Store `null` as a value instead of removing the key. */
      nullIsValue?: boolean;
    }
  | { op: "setConfig"; id: StepRef; config: ConfigPatch }
  | SingleCommand
  | SectionCommand
  | BulkCommand;

/** Machine-readable kind of an {@link ApplyError}. */
export type CommandErrorCode =
  | "command.invalid"
  | "step.notFound"
  | "section.notFound"
  | "placeholder.unknown"
  | "node.unknown"
  | "trigger.unknown"
  | "branch.unknown"
  | "location.invalid"
  | "id.taken"
  | "id.invalid"
  | "run.invalid"
  | "section.overlap"
  | "move.intoSelf"
  | "expect.mismatch"
  | "readOnly"
  | "config.invalid"
  | "ref.syntax"
  | "ref.unresolved"
  | "ref.outOfScope"
  | "step.invalidId"
  | "step.duplicateId";

/** Why a batch failed: which command, where in it, and a hint to fix it. */
export interface ApplyError {
  /** The failing command's index in `commands` (0-based). */
  index: number;
  /** A JSON path into the batch, e.g. `commands[2].config.to`. */
  path: string;
  /** What went wrong. */
  code: CommandErrorCode;
  /** A human-readable explanation. */
  message: string;
  /**
   * Help to fix it: `{ expected }` (a compact JSON Schema) for `command.invalid`, `{ closest }`
   * for unknown steps and node types, `{ branches }` for unknown branches, `{ defined, note }`
   * for unknown placeholders.
   */
  hint?: unknown;
}

/** The result of `apply`: the new doc and a report, or the first error. */
export type ApplyResult =
  | {
      ok: true;
      /** The new doc; the input doc itself when nothing changed. */
      doc: WorkflowDoc;
      /** Every placeholder used or created → real ID. */
      ids: Record<string, string>;
      /** Step IDs that changed identity in this batch (renameStepId, setType regeneration): old → new. */
      renamed: Record<string, string>;
      /** Outline of the changed region ("" with report: false). */
      changed: string;
      /** Validation issues the batch added and cleared (at most 20 added; the rest counted in `more`). */
      issues: { added: Issue[]; cleared: Issue[]; more?: { added: number; fetch: FollowUp } };
    }
  | {
      ok: false;
      /** The first error. */
      error: ApplyError;
      /** Further shape errors, up to 9. */
      more?: ApplyError[];
    };

/** Options of `apply`. */
export interface ApplyOptions {
  /** Validation context (secrets, network rules) for the issue delta. */
  ctx?: ValidationContext;
  /** Skip the Zod shape parse (the caller builds commands from typed code). Default false. */
  trusted?: boolean;
  /** Compute changed, the issue delta and changedStepIds. Default true. */
  report?: boolean;
}

/**
 * @internal A command failure raised by a handler: `path` is relative to the command
 * (`"id"`, `"at.in.branch"`), and `apply` prefixes `commands[<i>]`.
 */
export class CommandFailure extends Error {
  constructor(
    readonly code: CommandErrorCode,
    message: string,
    readonly path: string,
    readonly hint?: unknown,
  ) {
    super(message);
  }
}

/** @internal What a handler gets besides the doc and its command. */
export interface HandlerContext {
  /** The host manifest. */
  manifest: Manifest;
  /** The manifest's nodes by type. */
  nodes: Map<string, NodeManifest>;
  /** The running command's index. */
  index: number;
  /** Placeholders defined so far → real IDs. */
  placeholders: Map<string, string>;
  /** Placeholders used or created so far → real IDs (the result's `ids`). */
  used: Map<string, string>;
  /** Old → new step IDs so far (the result's `renamed`). */
  renamed: Map<string, string>;
}

/** @internal A handler's result: the new doc (the input doc when nothing changed) and the step it created. */
export interface HandlerResult {
  doc: WorkflowDoc;
  /** The step or section ID `$<index+1>` names. */
  created?: string;
}

/** @internal One command's implementation. Throws {@link CommandFailure}. */
export type Handler = (doc: WorkflowDoc, cmd: Command, ctx: HandlerContext) => HandlerResult;

/** Edit distance between two strings (Levenshtein). */
function distance(a: string, b: string): number {
  if (a === b) return 0;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      row[j] = Math.min(
        (prev[j] as number) + 1,
        (row[j - 1] as number) + 1,
        (prev[j - 1] as number) + cost,
      );
    }
    prev = row;
  }
  return prev[b.length] as number;
}

/** @internal Up to `n` of `candidates` closest to `target` by edit distance (ties by name). */
export function closest(target: string, candidates: Iterable<string>, n: number): string[] {
  const scored = [...new Set(candidates)].map((c) => ({ c, d: distance(target, c) }));
  scored.sort((x, y) => x.d - y.d || (x.c < y.c ? -1 : x.c > y.c ? 1 : 0));
  return scored.slice(0, n).map((s) => s.c);
}
