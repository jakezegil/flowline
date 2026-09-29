/**
 * Types shared by the agent reads: their inputs, follow-up calls and results.
 *
 * @module
 */
import type { ValidationContext } from "../scope";
import type {
  AnnotationColor,
  BranchSpec,
  JSONSchema,
  Manifest,
  RuleOperatorMeta,
  ValueExpr,
  WorkflowDoc,
} from "../types";
import type { Issue } from "../validate";

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
  /**
   * What was left out:
   * - `config`: config values
   * - `notes`: the full text of cut notes, step names and section titles
   * - `branch`: a collapsed branch
   * - `steps`: a list's tail
   * - `sections`: sections whose steps are all missing, folded into one line (their issues)
   */
  what: "config" | "notes" | "branch" | "steps" | "sections";
  /** For `branch` and `steps` in a branch: the step that owns the branch. */
  stepId?: string;
  /** For `branch` and `steps` in a branch: the branch ID. */
  branch?: string;
  /** How many steps were left out (for `notes`: texts cut; for `sections`: sections). */
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

/** One `{{ }}` ref in scope at a step, as `availableRefs` lists it. */
export interface RefInfo {
  /** The ref path, e.g. `"trigger"`, `"steps.getDeal"`, `"steps.getDeal.deal.ownerId"`, `"loop"`. */
  ref: string;
  /** Its type, as `describeType` gives it: `"string"`, `"{ id, email }"`, `"number[]"`, `"any"`. */
  type: string;
  /** Display label: the step's name or node label, the trigger's name, or a property's name. */
  label: string;
  /** The step (or an enclosing block) is disabled, so the value is undefined at runtime. */
  disabled?: boolean;
  /** How many child properties it has, when it is an object with properties (drill in with `path`). */
  children?: number;
}

/** A section as a step read shows it. */
export interface SectionInfo {
  /** Section ID. */
  id: string;
  /** Its title (cut at 500 chars unless `full: true`). */
  title: string;
  /** Its colour; an unknown colour shows as `gray`. */
  color: AnnotationColor;
  /** Its note (cut at 500 chars unless `full: true`), when it has one. */
  note?: string;
}

/**
 * Everything a read returns about one step. Strings longer than 500 chars (config values, the
 * name, the note, section titles and notes, branch labels) are cut to 500 with `…(+N chars)`
 * unless the read was called with `full: true`; `cut` then lists their paths and `full` is the
 * call that returns the step uncut.
 */
export interface StepDetail {
  /** Step ID. */
  id: string;
  /** Node type. */
  type: string;
  /** The node's label, or the type when the node type is unknown. */
  nodeLabel: string;
  /** The step's name override, when set. */
  name?: string;
  /** Set when the step is disabled. */
  disabled?: boolean;
  /** The step's note, when it has one. */
  note?: string;
  /** The step's accent colour, when set (an unknown colour shows as `gray`). */
  color?: AnnotationColor;
  /** The innermost section the step is a member of. */
  section?: SectionInfo;
  /**
   * Other sections whose `first` is this step (broken or overlapping ones, which `section`
   * doesn't name), so their notes and titles can be read here too.
   */
  heads?: SectionInfo[];
  /** Where the step sits: its parent step and branch (none at the top level) and its index. */
  location: { parentId: string | null; branch?: string; index: number };
  /** Config values (with `include: ["config"]`). */
  config?: Record<string, ValueExpr>;
  /** The node's input schema, compacted by `compactSchema` (with `include: ["schema"]`). */
  schema?: JSONSchema;
  /** The refs in scope at the step, top level (with `include: ["refs"]`). */
  refs?: RefInfo[];
  /** The step's validation issues (section issues included, where it is the section's `first`). */
  issues: Issue[];
  /** The step's branches, declared ones first, with the number of steps directly in each. */
  branches?: { id: string; label: string; steps: number }[];
  /** Paths whose strings were cut (pass full: true for the whole text), e.g. "config.body", "note". */
  cut?: string[];
  /** When something was cut: the call that returns this step uncut. */
  full?: FollowUp;
}

/** What each read returns, by tool name. */
export interface ReadResults {
  /** The workflow as an outline. */
  overview: OutlineResult;
  /** Part of the workflow as an outline. */
  outline: OutlineResult;
  /** One step, with config, compact schema and refs. */
  focus: StepDetail;
  /**
   * Steps by ID (unknown IDs in `missing`) or by selector. `next` pages on when more steps
   * match; `full` returns every step of this page that had a string cut, uncut.
   */
  getSteps: { steps: StepDetail[]; missing: string[]; next?: FollowUp; full?: FollowUp };
  /** How many steps a selector matches, with each one's outline line. */
  findSteps: { count: number; matches: { id: string; line: string }[] };
  /** The refs in scope at a step. */
  availableRefs: { refs: RefInfo[] };
  /** Node types matching a query and category, best match first. */
  listNodeTypes: {
    types: { type: string; label: string; description?: string; category?: string }[];
  };
  /** Full descriptions of node types; types not in the manifest are listed in `unknown`. */
  describeNodeTypes: {
    types: {
      type: string;
      label: string;
      /** The compact input schema. */
      input: JSONSchema;
      /**
       * `ids`: the fixed branch IDs (static branches, a loop's body, or those appended after
       * config-driven ones). `fromConfig`: where config-driven branch IDs come from, e.g.
       * `"cases[].id"`.
       */
      branches: { kind: BranchSpec["kind"]; ids?: string[]; fromConfig?: string };
      /** The compact output schema, or the config path that declares the output. */
      output: JSONSchema | { declaredBy: string };
      /** Host rule operators the node's input offers (`x-flowline.operators`). */
      operators?: RuleOperatorMeta[];
    }[];
    /** Requested types that aren't in the manifest. */
    unknown: string[];
  };
  /** Validation issues, with counts by severity. */
  getIssues: { issues: Issue[]; errors: number; warnings: number };
}

/** A read, callable uniformly as reads[name](doc, manifest, args). */
export type ReadFn<K extends ReadToolName> = (
  doc: WorkflowDoc,
  manifest: Manifest,
  args: ReadArgs[K],
  opts?: ReadOptions,
) => ReadResults[K];
