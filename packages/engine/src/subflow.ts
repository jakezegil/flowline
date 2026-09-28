/**
 * Sub-flow calls: resolving, validating and naming the child run of an `invokeSubflow` signal.
 * The executor performs the atomic suspend commit that creates the child.
 *
 * @module
 */
import {
  checkFields,
  configValueAt,
  type FieldDecl,
  type Registry,
  type SubflowSignal,
  type WorkflowDoc,
} from "@flowkit/core";
import type { z } from "zod";
import { sha256Hex } from "./context";
import type { NewRun, Run, StorageAdapter } from "./storage";

/** Sub-flow levels allowed below a root run. */
const MAX_SUBFLOW_DEPTH = 8;
/** Candidate child ids tried before giving up (see {@link subflowRunId}). */
const MAX_CHILD_ID_ATTEMPTS = 1000;
const FINISHED: ReadonlySet<Run["status"]> = new Set(["completed", "failed", "cancelled"]);

/** What {@link startSubflow} needs from the executor. */
export interface SubflowEnv<T> {
  storage: StorageAdapter;
  registry: Registry;
  /** The calling (parent) run. */
  run: Run;
  /** Path of the calling step. */
  path: string;
  /** Attempt of the calling step. */
  attempt: number;
  /** Fail the calling step fatally. */
  fail(message: string, code: string): Promise<T>;
  /** Suspend the calling step on `child`, creating it in the same atomic commit. */
  suspend(child: NewRun): Promise<T>;
}

/** Number of ancestors of `run` (0 for a root run), counted up to the nesting cap. */
async function nestingDepth(storage: StorageAdapter, run: Run): Promise<number> {
  let depth = 0;
  let parent = run.parent;
  while (parent && depth < MAX_SUBFLOW_DEPTH) {
    depth++;
    parent = (await storage.getRunById(parent.runId))?.parent;
  }
  return depth;
}

/**
 * The trigger payload for a run of `child`: `input`, checked against the child trigger's payload
 * schema or declared fields.
 */
async function subflowPayload(
  registry: Registry,
  child: WorkflowDoc,
  input: unknown,
): Promise<{ ok: true; value: unknown } | { ok: false; message: string }> {
  let value: unknown;
  try {
    value = structuredClone(input);
  } catch {
    return { ok: false, message: "must be JSON-serializable" };
  }
  const trigger = registry.getTrigger(child.trigger.type);
  if (trigger?.payload) {
    const res = await (trigger.payload as z.ZodType).safeParseAsync(value);
    if (res.success) return { ok: true, value: res.data };
    const issue = res.error.issues[0];
    const field = issue && issue.path.length > 0 ? `field "${issue.path.join(".")}" ` : "";
    return { ok: false, message: `${field}${issue?.message ?? "is invalid"}` };
  }
  if (trigger?.dynamicPayload?.kind === "fields") {
    const decls = configValueAt(child.trigger.config, trigger.dynamicPayload.configPath);
    const problem = checkFields(Array.isArray(decls) ? (decls as FieldDecl[]) : [], value);
    if (problem !== undefined) return { ok: false, message: problem };
  }
  return { ok: true, value };
}

/**
 * @internal Why `output` (a finished sub-flow run's mapped output) does not match the output
 * fields its workflow declares, prefixed `Sub-flow output: `; `undefined` when it matches or
 * nothing is declared. A missing output mapping counts as `{}`.
 *
 * Contract for every trigger of kind `subflow` (`core.subflow` and plugin sub-flow triggers alike,
 * see `TriggerKind` in `@flowkit/core`): the declared output is the `FieldDecl` list at config path
 * `"output"`. A plugin trigger that keeps its output fields anywhere else is not checked.
 */
export function subflowOutputProblem(
  registry: Registry,
  doc: WorkflowDoc,
  output: unknown,
): string | undefined {
  if (registry.getTrigger(doc.trigger.type)?.kind !== "subflow") return undefined;
  const decls = configValueAt(doc.trigger.config, "output");
  if (!Array.isArray(decls)) return undefined;
  const problem = checkFields(decls as FieldDecl[], output ?? {});
  return problem === undefined ? undefined : `Sub-flow output: ${problem}`;
}

/**
 * The child run id for the step at `path`: `sub_` + the first 24 hex digits of
 * sha256(`runId:path:attempt`), so re-executing the same call names the same child. If that id
 * already belongs to a finished run (the step was retried with `retryRun`, or the handler starts
 * another sub-flow after resuming), the seed gets a `:n` suffix until the id is free. `undefined`
 * after {@link MAX_CHILD_ID_ATTEMPTS} taken ids.
 */
async function subflowRunId(
  storage: StorageAdapter,
  runId: string,
  path: string,
  attempt: number,
): Promise<string | undefined> {
  for (let n = 0; n < MAX_CHILD_ID_ATTEMPTS; n++) {
    const seed = `${runId}:${path}:${attempt}${n === 0 ? "" : `:${n}`}`;
    const id = `sub_${(await sha256Hex(seed)).slice(0, 24)}`;
    const existing = await storage.getRunById(id);
    if (!existing || !FINISHED.has(existing.status)) return id;
  }
  return undefined;
}

/**
 * @internal Handle an `invokeSubflow` signal: load the child's published version (same tenant),
 * enforce the nesting cap, validate the input and suspend the calling step on a new child run.
 * Failures are fatal with codes `subflow.unknown`, `subflow.depth`, `subflow.input` and
 * `subflow.id`.
 */
export async function startSubflow<T>(sig: SubflowSignal, env: SubflowEnv<T>): Promise<T> {
  const { storage, run } = env;
  const child = await storage.getPublishedVersion(run.tenantId, sig.workflowId);
  if (!child) return env.fail(`Sub-flow "${sig.workflowId}" is not published`, "subflow.unknown");
  if ((await nestingDepth(storage, run)) >= MAX_SUBFLOW_DEPTH) {
    return env.fail("Sub-flow nesting too deep", "subflow.depth");
  }
  const payload = await subflowPayload(env.registry, child.doc, sig.input);
  if (!payload.ok) {
    return env.fail(`Sub-flow "${sig.workflowId}" input: ${payload.message}`, "subflow.input");
  }
  const id = await subflowRunId(storage, run.id, env.path, env.attempt);
  if (id === undefined) {
    return env.fail(`Sub-flow "${sig.workflowId}": no free child run id`, "subflow.id");
  }
  return env.suspend({
    id,
    tenantId: run.tenantId,
    workflowId: child.workflowId,
    version: child.version,
    status: "queued",
    trigger: payload.value,
    journal: {},
    attempt: 1,
    startedBy: { kind: "subflow", parentRunId: run.id, parentStepPath: env.path },
    parent: { runId: run.id, stepPath: env.path },
  });
}
