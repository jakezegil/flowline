/**
 * The commands `apply` runs on a workflow doc, their results and errors, plus the internal
 * handler contract the command modules share.
 *
 * @module
 */
import type { ValidationContext } from "../scope";
import type { AnnotationColor, Manifest, NodeManifest, ValueExpr, WorkflowDoc } from "../types";
import type { Issue } from "../validate";
import type { FollowUp, Where } from "./read-types";

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
/**
 * One new step in an `insertSteps`/`replaceSteps` command, with its branches as nested fragments.
 *
 * - `ref` names the step `"$<ref>"` in later fragments and commands of the batch (in step
 *   arguments and in `steps.$<ref>…` refs and templates). It follows the step ID rule.
 * - `id` defaults to one generated from `type`.
 * - `config` is merged over the node's defaults.
 * - `branches` keys must be branches the node declares; missing declared branches are added.
 *
 * @example
 * { ref: "deal", type: "crm.getDeal", config: { dealId: { $ref: "trigger.deal.id" } } }
 * { type: "flow.if", branches: { else: [{ type: "crm.sendEmail", config: { to: { $ref: "steps.$deal.deal.ownerId" } } }] } }
 */
export interface Fragment {
  /** A batch-local name: `"$<ref>"` names this step later in the fragment and the batch. */
  ref?: string;
  /** The new step's ID; generated from `type` when absent. */
  id?: string;
  /** The node type. */
  type: string;
  /** A display name. */
  name?: string;
  /** Config, merged over the node's defaults. */
  config?: Record<string, ValueExpr>;
  /** A note (at most 4000 characters). */
  note?: string;
  /** A colour. */
  color?: AnnotationColor;
  /** Whether the step is disabled. */
  disabled?: boolean;
  /** Steps in each branch, by branch ID. */
  branches?: Record<string, Fragment[]>;
}

/**
 * One step's edit in an `updateSteps` command: fields to `set`, and a `config` patch.
 *
 * - `set.name` is trimmed; `""` clears the display name.
 * - `set.note: null` (or `""`) and `set.color: null` remove the field.
 * - `config` merges keys; `null` removes a key.
 *
 * @example
 * { id: "notify", set: { name: "Tell the owner", color: "blue" }, config: { subject: "Hi" } }
 */
export interface StepUpdate {
  /** The step to update. */
  id: StepRef;
  /** Fields to set. */
  set?: { name?: string; disabled?: boolean; note?: string | null; color?: AnnotationColor | null };
  /** Config keys to set; `null` removes a key. */
  config?: ConfigPatch;
}

/**
 * The bulk commands.
 *
 * - `insertSteps` inserts a run of new steps (with nested branches) at `at`. The whole fragment
 *   is validated at once: an unknown node type or branch, an invalid config value, or a ref that
 *   is unknown, malformed or out of scope at its position fails the batch; a missing required
 *   field and warnings are only reported. The reject list goes by code, not severity: a
 *   disabled fragment (or one inside a disabled block) with such a problem fails too, although
 *   the validator reports it there as a warning. `section` wraps the inserted top-level run in a new
 *   section (`section.overlap` if that overlaps one in the same list). `$n` is the first
 *   top-level inserted step.
 * - `replaceSteps` removes the run `first`…`last` (one list, in order; `run.invalid` otherwise)
 *   and inserts `steps` in its place, validated as in `insertSteps`. A section holding the whole
 *   run holds the new steps; a section holding part of it shrinks to its remaining members, and
 *   one inside the replaced steps is removed. Replacing a run with identical steps changes nothing. Refs elsewhere to the removed steps are reported, not rejected. `$n`
 *   is the first new top-level step.
 * - `duplicateSteps` copies the run `first`…`last` (with subtrees) with fresh IDs, right after
 *   `last` unless `at` says otherwise; refs inside the copy to steps of the run point at their
 *   copies. Each top-level copy is named `"<name> (copy)"`, `"(copy 2)"`, …. Copies placed right
 *   after `last` join a section that `last` ends. `$n` is the first copy.
 * - `updateSteps` applies `updates` in order (a later update sees earlier ones), or applies one
 *   `set`/`config` to every step `where` matches.
 * - `replaceInConfig` replaces every occurrence of `find` (plain, case-sensitive) in string
 *   values and `$tpl` text of step config (not in `$ref`s, `{{ }}` refs or the trigger), in
 *   every step or the ones `where` matches. `expect` counts the steps changed.
 * - `moveSteps` moves the run as a block; `to` is resolved after the run is taken out, and a
 *   target in the run's subtree fails with `move.intoSelf`. A section equal to or inside the run
 *   moves with it; a section holding part of it keeps the members that land in its span.
 * - `removeSteps` removes the given steps, the run `first`…`last`, or the `where` matches
 *   (a step inside another removed step goes with it). Dangling refs are reported.
 * - `wrapSteps` puts the run in branch `in.branch` of a new `in.type` step, in the run's
 *   place. The wrapper replaces the run in a section holding it (or holding part of it); a
 *   section inside the run moves into the branch. `$n` is the wrapper.
 * - `unwrapStep` replaces a branching step with the steps of its branch `keep`; the other
 *   branches' steps are removed. A lifted section overlapping an outer one is dropped.
 *
 * Every selector (`where`) form requires `expect`: a different match count fails with
 * `expect.mismatch` (hint `{ matched }`), and `expect: 0` with no match changes nothing.
 *
 * @example
 * { op: "insertSteps", at: { after: "getDeal" }, steps: [{ type: "crm.sendEmail", config: { subject: "Hi" } }] }
 * { op: "replaceSteps", first: "notify", last: "notify", steps: [{ type: "flow.stop" }] }
 */
export type BulkCommand =
  | {
      op: "insertSteps";
      at: At;
      steps: Fragment[];
      section?: SectionInput;
      /**
       * @internal The store's paste: IDs, config and branches as given (no defaults, no branch
       * sync, unknown types allowed), and validation issues are only reported.
       */
      verbatim?: boolean;
    }
  | { op: "replaceSteps"; first: StepRef; last: StepRef; steps: Fragment[] }
  | { op: "duplicateSteps"; first: StepRef; last: StepRef; at?: At }
  | { op: "updateSteps"; updates: StepUpdate[] }
  | {
      op: "updateSteps";
      where: Where;
      set?: StepUpdate["set"];
      config?: ConfigPatch;
      expect: number;
    }
  | { op: "replaceInConfig"; find: string; replace: string; where?: Where; expect: number }
  | { op: "moveSteps"; first: StepRef; last: StepRef; to: At }
  | { op: "removeSteps"; ids: StepRef[] }
  | { op: "removeSteps"; first: StepRef; last: StepRef }
  | { op: "removeSteps"; where: Where; expect: number }
  | {
      op: "wrapSteps";
      first: StepRef;
      last: StepRef;
      in: { type: string; branch: string; config?: Record<string, ValueExpr> };
    }
  | { op: "unwrapStep"; id: StepRef; keep: string };

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
  | "placeholder.kind"
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
   * for unknown placeholders, `{ expected, got, note }` for a placeholder of the wrong kind (a
   * section's `$n` where a step ID goes, or the reverse).
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
  /** Step placeholders defined so far → real step IDs. */
  placeholders: Map<string, string>;
  /** Section placeholders defined so far (`$n` of an `addSection`) → real section IDs. */
  sectionPlaceholders: Map<string, string>;
  /** Placeholders used or created so far, of both kinds → real IDs (the result's `ids`). */
  used: Map<string, string>;
  /** Old → new step IDs so far (the result's `renamed`). */
  renamed: Map<string, string>;
}

/** @internal A handler's result: the new doc (the input doc when nothing changed) and the step it created. */
export interface HandlerResult {
  doc: WorkflowDoc;
  /** The step or section ID `$<index+1>` names. */
  created?: string;
  /** What `created` is. Default `"step"`. */
  kind?: PlaceholderKind;
}

/** @internal What a placeholder names: a step, or a section. */
export type PlaceholderKind = "step" | "section";

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
