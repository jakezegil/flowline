/**
 * Types shared by the agent reads: their inputs, follow-up calls and results.
 *
 * @module
 */
import type { ValidationContext } from "../scope";

/**
 * Steps to act on, as a selector. Fields are ANDed, and `{}` matches every step.
 *
 * @example
 * { type: "crm.sendEmail", within: { stepId: "recheck", branch: "else" } }
 */
export interface Where {
  /** Exact node type. */
  type?: string;
  /** Section ID: its members and their subtrees. */
  section?: string;
  /** Descendants (any depth) of a step, optionally of one of its branches. */
  within?: { stepId: string; branch?: string };
  /** Case-insensitive match on the display name (`name`, else the node label, else the ID). */
  nameContains?: string;
  /** A config path that is present (`configValueAt(...) !== undefined`). */
  configHas?: string;
}

/** Extra detail a step read can include: config values, the compact input schema, refs in scope. */
export type Include = "config" | "schema" | "refs";

/** Each read's input, exactly the tool's input schema. */
export interface ReadArgs {
  /** The whole workflow as an outline. `budget` is in characters (default 4000). */
  overview: { budget?: number };
  /**
   * One step's subtree (`stepId`), one branch (`stepId` + `branch`) or the top-level list, in the
   * outline format. `after` pages the listed list: only steps after that step are shown.
   */
  outline: { stepId?: string; branch?: string; after?: string; budget?: number };
  /** Everything needed to edit one step. */
  focus: { stepId: string; full?: boolean };
  /** Several steps, by ID or by selector (paged with `after`/`limit`). */
  getSteps:
    | { ids: string[]; include?: Include[]; full?: boolean }
    | { where: Where; after?: string; limit?: number; include?: Include[]; full?: boolean };
  /** IDs and one-line summaries of the steps a selector matches. */
  findSteps: { where: Where };
  /** The `{{ }}` refs in scope at a step, top level unless `path` drills in. */
  availableRefs: { stepId: string; path?: string };
  /** Node types, by search query and category. */
  listNodeTypes: { query?: string; category?: string };
  /** Full descriptions of the given node types. */
  describeNodeTypes: { types: string[] };
  /** Validation issues, optionally for one step. */
  getIssues: { stepId?: string };
}

/** The name of a read tool. */
export type ReadToolName = keyof ReadArgs;

/** A follow-up call that fetches something a read left out. */
export type FollowUp = { [K in ReadToolName]: { tool: K; args: ReadArgs[K] } }[ReadToolName];

/** Something an outline left out, with the exact call that returns it. */
export interface Omission {
  /** What was left out: config values, full notes, a collapsed branch, or a list's tail. */
  what: "config" | "notes" | "branch" | "steps";
  /** For `branch` and `steps` in a branch: the step that owns the branch. */
  stepId?: string;
  /** For `branch` and `steps` in a branch: the branch ID. */
  branch?: string;
  /** How many steps (for `notes`: notes) were left out. */
  count: number;
  /** The call that returns what was left out. */
  fetch: FollowUp;
}

/** The result of `overview` and `outline`. */
export interface OutlineResult {
  /** The outline, one line per step, section, branch or collapse marker. */
  text: string;
  /** What was left out, each with the exact call that returns it. Empty when nothing was. */
  omitted: Omission[];
  /** Counts over the whole scope read (the doc, or the outlined subtree/list). */
  totals: { steps: number; sections: number; notes: number; errors: number; warnings: number };
}

/** Options shared by the reads. */
export interface ReadOptions {
  /** Validation context, for issue counts that match the editor's. */
  ctx?: ValidationContext;
}
