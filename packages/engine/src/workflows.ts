/**
 * The workflow management API behind the editor: saving and publishing versions, server-side
 * validation, the sub-flow catalogue, run inspection and step tests.
 *
 * @module
 */
import {
  describeSubflowOutput,
  dropHiddenFields,
  type FlowlineServices,
  hasErrors,
  type Issue,
  isSignal,
  type JournalEntry,
  type NodeManifest,
  payloadSchemaFor,
  type RunDetail,
  resolveValue,
  type Step,
  type SubflowInfo,
  secretExprPath,
  subflowOutputSchema,
  type TestStepRequest,
  type TestStepResponse,
  type ValidationContext,
  validateWorkflow,
  type WorkflowDoc,
  type WorkflowVersion,
  walkSteps,
} from "@flowlinejs/core";
import type { z } from "zod";
import { createNodeContext } from "./context";
import type { EngineCore } from "./engine";
import {
  EngineNotFoundError,
  FlowlineValidationError,
  RetryableError,
  WorkflowExistsError,
} from "./errors";
import { createGuardedFetch, type GuardedFetch } from "./http";
import { redactBySchema } from "./redact";
import { type Run, stoppedAtOf } from "./storage";
import { DEFAULT_BASE_PATH, errorMessage, isPlainObject, secretRefMessage } from "./util";

const WORKFLOW_ID = /^[a-z0-9][a-z0-9-_]*$/;
const SLUG = /^[A-Za-z0-9_-]{22,128}$/;
const DEFAULT_TIMEOUT_MS = 300_000;

/** Why `steps` is not a list of well-formed steps, or `undefined`. */
function stepsProblem(steps: unknown, where: string): string | undefined {
  if (!Array.isArray(steps)) return `${where} must be a list`;
  for (const s of steps) {
    if (!isPlainObject(s) || typeof s.id !== "string" || typeof s.type !== "string") {
      return `${where} must contain steps with an id and a type`;
    }
    if (!isPlainObject(s.config)) return `Step "${s.id}" needs a config object`;
    if (s.branches !== undefined) {
      if (!isPlainObject(s.branches)) return `Step "${s.id}" has invalid branches`;
      for (const [key, list] of Object.entries(s.branches)) {
        const problem = stepsProblem(list, `Branch "${key}" of step "${s.id}"`);
        if (problem) return problem;
      }
    }
  }
  return undefined;
}

/** @internal Why `doc` is not a structurally valid workflow document, or `undefined`. */
export function docShapeProblem(doc: unknown): string | undefined {
  if (!isPlainObject(doc)) return "The workflow must be an object";
  if (typeof doc.id !== "string" || !WORKFLOW_ID.test(doc.id)) {
    return "The workflow id must be lowercase letters, digits, - and _";
  }
  if (typeof doc.name !== "string") return "The workflow needs a name";
  const trigger = doc.trigger;
  if (
    !isPlainObject(trigger) ||
    typeof trigger.type !== "string" ||
    !isPlainObject(trigger.config)
  ) {
    return "The workflow needs a trigger with a type and a config object";
  }
  if (doc.output !== undefined && !isPlainObject(doc.output)) return "output must be an object";
  return stepsProblem(doc.steps, "steps");
}

/**
 * @internal The message of a rejected publish, naming the first error so that a failing test or
 * startup log says what is wrong: `Workflow "x" has errors: step "email": "To" is required (+2 more)`.
 */
export function errorSummary(workflowId: string, issues: readonly Issue[]): string {
  const errors = issues.filter((i) => i.severity === "error");
  const first = errors[0];
  if (!first) return `Workflow "${workflowId}" has errors`;
  const where = first.stepId !== undefined ? `step "${first.stepId}": ` : "";
  const more = errors.length > 1 ? ` (+${errors.length - 1} more)` : "";
  return `Workflow "${workflowId}" has errors: ${where}${first.message}${more}`;
}

/** A fresh webhook slug: 24 random base64url characters (144 bits). */
function newSlug(): string {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(18));
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

/** @internal The editor-facing API of an engine. */
export interface Workflows {
  saveWorkflow(
    tenantId: string,
    doc: WorkflowDoc,
    actor: string,
    opts?: { create?: boolean },
  ): Promise<WorkflowVersion>;
  publish(tenantId: string, workflowId: string, version: number, actor: string): Promise<void>;
  validate(tenantId: string, doc: WorkflowDoc): Promise<Issue[]>;
  listSubflows(tenantId: string): Promise<SubflowInfo[]>;
  getRunDetail(tenantId: string, runId: string): Promise<RunDetail | null>;
  testStep(tenantId: string, req: TestStepRequest): Promise<TestStepResponse>;
}

/** @internal Create the workflow management API of an engine. */
export function createWorkflows(core: EngineCore): Workflows {
  const { storage, registry, clock } = core;
  let http: GuardedFetch | undefined;
  let nodes: Map<string, NodeManifest> | undefined;
  const nodeManifest = (type: string) => {
    nodes ??= new Map(registry.manifest().nodes.map((n) => [n.type, n]));
    return nodes.get(type);
  };

  const listSubflows = async (tenantId: string): Promise<SubflowInfo[]> => {
    const manifest = registry.manifest();
    const triggers = new Map(manifest.triggers.map((t) => [t.type, t]));
    const declared: SubflowInfo[] = [];
    const docs = new Map<string, WorkflowDoc>();
    for (const v of await storage.listPublished({ tenantId })) {
      const t = triggers.get(v.doc.trigger.type);
      if (t?.kind !== "subflow") continue;
      // Declarations hidden by showIf don't exist for callers.
      const config = dropHiddenFields(v.doc.trigger.config, t.config);
      const trigger = { ...v.doc.trigger, config: config as typeof v.doc.trigger.config };
      docs.set(v.workflowId, v.doc);
      declared.push({
        id: v.workflowId,
        name: v.doc.name,
        input: payloadSchemaFor(t, trigger),
        output: subflowOutputSchema(t, trigger) ?? {},
      });
    }
    // Declared `object`/`array` outputs get the shape of what the mapping puts there, so callers
    // can browse into them. References into other sub-flows resolve against their declarations.
    const plain = Object.fromEntries(declared.map((s) => [s.id, s]));
    const out = declared.map((s) => {
      const doc = docs.get(s.id);
      const output = doc ? describeSubflowOutput(doc, manifest, { subflows: plain }) : undefined;
      return output ? { ...s, output } : s;
    });
    return out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  };

  /** The tenant's secret names for the validator; none when `secrets.list` is absent or fails. */
  const secretNames = async (tenantId: string): Promise<{ secrets?: string[] }> => {
    const store = core.opts.secrets;
    if (!store?.list) return {};
    try {
      const names = await store.list(tenantId);
      return Array.isArray(names) ? { secrets: names } : {};
    } catch (err) {
      core.logger?.warn("secrets.list failed; secret names are not checked", {
        tenantId,
        error: errorMessage(err),
      });
      return {};
    }
  };

  const validate = async (tenantId: string, doc: WorkflowDoc): Promise<Issue[]> => {
    const subflows: NonNullable<ValidationContext["subflows"]> = {};
    for (const s of await listSubflows(tenantId)) {
      subflows[s.id] = { name: s.name, input: s.input, output: s.output };
    }
    const net = core.opts.http;
    const network =
      net?.allowPrivateNetworks !== undefined || net?.allowHosts !== undefined
        ? {
            ...(net.allowPrivateNetworks !== undefined
              ? { allowPrivateNetworks: net.allowPrivateNetworks }
              : {}),
            ...(net.allowHosts !== undefined ? { allowHosts: net.allowHosts } : {}),
          }
        : undefined;
    return validateWorkflow(doc, registry.manifest(), {
      subflows,
      ...(network ? { network } : {}),
      ...(await secretNames(tenantId)),
    });
  };

  /** The run as shown to the editor: no lease or callback state, sensitive values masked. */
  const runView = (run: Run, doc: WorkflowDoc): RunDetail["run"] => {
    const steps = new Map<string, Step>();
    walkSteps(doc, (step) => steps.set(step.id, step));
    const journal: Record<string, JournalEntry> = {};
    for (const [path, entry] of Object.entries(run.journal)) {
      const stepId = path.slice(path.lastIndexOf("/") + 1);
      const step = steps.get(stepId);
      const m = step ? nodeManifest(step.type) : undefined;
      const shown: Record<string, unknown> = { ...entry };
      if (m) {
        if ("input" in entry && entry.input !== undefined) {
          shown.input = redactBySchema(entry.input, m.input, { mask: "all" });
        }
        if ("output" in entry && entry.output !== undefined && m.output.kind === "schema") {
          shown.output = redactBySchema(entry.output, m.output.schema, { mask: "all" });
        }
      }
      Object.defineProperty(journal, path, {
        value: shown,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    const triggerManifest = registry.manifest().triggers.find((t) => t.type === doc.trigger.type);
    const trigger =
      triggerManifest?.payload.kind === "schema"
        ? redactBySchema(run.trigger, triggerManifest.payload.schema, { mask: "all" })
        : run.trigger;
    const view: RunDetail["run"] = {
      id: run.id,
      workflowId: run.workflowId,
      version: run.version,
      status: run.status,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
      startedBy: run.startedBy,
      trigger,
      journal,
    };
    if (run.error !== undefined) view.error = run.error;
    if (run.output !== undefined) view.output = run.output;
    if (run.wakeAt !== undefined) view.wakeAt = run.wakeAt;
    if (run.parent !== undefined) view.parent = run.parent;
    const stoppedAt = stoppedAtOf(run);
    if (stoppedAt !== undefined) view.stoppedAt = stoppedAt;
    return view;
  };

  return {
    listSubflows,
    validate,

    async saveWorkflow(tenantId, doc, actor, opts = {}) {
      const problem = docShapeProblem(doc);
      if (problem) throw new FlowlineValidationError(problem, []);
      let saved = doc;
      if (registry.getTrigger(doc.trigger.type)?.kind === "webhook") {
        const current = doc.trigger.config.slug;
        if (typeof current !== "string" || !SLUG.test(current)) {
          const previous = (await storage.getLatestVersion(tenantId, doc.id))?.doc.trigger.config
            .slug;
          const slug = typeof previous === "string" && SLUG.test(previous) ? previous : newSlug();
          saved = { ...doc, trigger: { ...doc.trigger, config: { ...doc.trigger.config, slug } } };
        }
      }
      const now = clock();
      const v = opts.create
        ? await storage.createWorkflowVersion(tenantId, saved, actor, now)
        : await storage.saveWorkflowVersion(tenantId, saved, actor, now);
      if (!v) throw new WorkflowExistsError(`Workflow "${doc.id}" already exists`);
      await storage.appendWorkflowAudit({
        tenantId,
        workflowId: v.workflowId,
        version: v.version,
        action: "saved",
        actor,
        at: now,
      });
      return v;
    },

    async publish(tenantId, workflowId, version, actor) {
      const v = await storage.getWorkflowVersion(tenantId, workflowId, version);
      if (!v)
        throw new EngineNotFoundError(`Workflow "${workflowId}" version ${version} not found`);
      const issues = await validate(tenantId, v.doc);
      if (hasErrors(issues)) {
        throw new FlowlineValidationError(errorSummary(workflowId, issues), issues);
      }
      const now = clock();
      await storage.publishVersion(tenantId, workflowId, version, now);
      await storage.appendWorkflowAudit({
        tenantId,
        workflowId,
        version,
        action: "published",
        actor,
        at: now,
      });
    },

    async getRunDetail(tenantId, runId) {
      const run = await storage.getRun(tenantId, runId);
      if (!run) return null;
      const v = await storage.getWorkflowVersion(tenantId, run.workflowId, run.version);
      if (!v) throw new Error(`Workflow "${run.workflowId}" version ${run.version} not found`);
      const events = await storage.listEvents(tenantId, runId);
      return { run: runView(run, v.doc), events, doc: v.doc };
    },

    async testStep(tenantId, req) {
      const t0 = performance.now();
      const elapsed = () => Math.max(0, Math.round((performance.now() - t0) * 100) / 100);
      const fail = (error: string, input?: unknown): TestStepResponse => ({
        ok: false,
        error,
        durationMs: elapsed(),
        ...(input !== undefined ? { input } : {}),
      });
      const step = req.step;
      const node = registry.getNode(step?.type);
      const manifest = node ? nodeManifest(step.type) : undefined;
      if (!node || !manifest) return fail(`Unknown step type "${step?.type}"`);
      const label = step.name ?? step.id;
      const runId = `test_${globalThis.crypto.randomUUID().replace(/-/g, "")}`;
      const scope = {
        trigger: req.triggerSample,
        steps: isPlainObject(req.samples) ? { ...req.samples } : {},
        run: { id: runId },
      };
      const secretRef = secretExprPath(step.config ?? {}, manifest.input);
      if (secretRef !== undefined) return fail(secretRefMessage(label, secretRef));
      let resolved: Record<string, unknown>;
      try {
        resolved = structuredClone(
          Object.fromEntries(
            Object.entries(step.config ?? {}).map(([k, v]) => [k, resolveValue(v, scope)]),
          ),
        );
      } catch (err) {
        return fail(`Step "${label}": ${errorMessage(err)}`);
      }
      // Fields hidden by `showIf` (judged on the resolved values) never reach the handler.
      resolved = dropHiddenFields(resolved, manifest.input) as Record<string, unknown>;
      const shownInput = (v: unknown) => redactBySchema(v, manifest.input, { mask: "secret" });
      const parsed = await node.input.safeParseAsync(resolved);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        const field = issue && issue.path.length > 0 ? `field "${issue.path.join(".")}" ` : "";
        return fail(
          `Step "${label}": ${field}${issue?.message ?? "invalid input"}`,
          shownInput(resolved),
        );
      }
      const input = shownInput(parsed.data);

      const controller = new AbortController();
      const timer = setTimeout(
        () => controller.abort(new RetryableError("timed out")),
        node.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      );
      const aborted = new Promise<never>((_, reject) => {
        controller.signal.addEventListener("abort", () => reject(controller.signal.reason), {
          once: true,
        });
      });
      aborted.catch(() => {});
      http ??= createGuardedFetch({
        ...core.opts.http,
        ...(core.logger ? { logger: core.logger } : {}),
      });
      let result: unknown;
      try {
        const ctx = createNodeContext({
          runId,
          tenantId,
          workflowId: req.doc?.id ?? "test",
          stepId: step.id,
          stepPath: step.id,
          attempt: 1,
          idempotencyKey: runId,
          services: core.opts.services ?? ({} as FlowlineServices),
          ...(core.logger ? { logger: core.logger } : {}),
          signal: controller.signal,
          clock,
          scope,
          ...(core.opts.secrets ? { secrets: core.opts.secrets } : {}),
          ...(core.opts.transform ? { transform: core.opts.transform } : {}),
          http,
          // Reported, not executed: no token is stored, so the URL resumes nothing.
          callback: async ({ timeoutMs }) => ({
            token: "test",
            resumeUrl: `${core.opts.publicUrl ?? ""}${core.opts.basePath ?? DEFAULT_BASE_PATH}/resume/test`,
            expiresAt: clock() + timeoutMs,
          }),
        });
        const handler = Promise.resolve().then(() => node.run({ input: parsed.data, ctx }));
        handler.catch(() => {});
        result = await Promise.race([handler, aborted]);
      } catch (err) {
        return fail(errorMessage(err), input);
      } finally {
        clearTimeout(timer);
      }

      const done = (extra: Partial<TestStepResponse>): TestStepResponse => ({
        ok: true,
        input,
        durationMs: elapsed(),
        ...extra,
      });
      /** Validated output with `secret` fields masked, as the journal stores it. */
      const checkOutput = async (value: unknown) => {
        if (!node.output) return { ok: true as const, value };
        const res = await (node.output as z.ZodType).safeParseAsync(value);
        if (!res.success) {
          return { ok: false as const, message: res.error.issues[0]?.message ?? "invalid output" };
        }
        const shown =
          manifest.output.kind === "schema"
            ? redactBySchema(res.data, manifest.output.schema, { mask: "secret" })
            : res.data;
        return { ok: true as const, value: shown };
      };
      if (isSignal(result)) {
        switch (result.kind) {
          case "branch": {
            if (result.output === undefined) return done({ branch: result.branch });
            const out = await checkOutput(result.output);
            if (!out.ok) return fail(`Step "${label}": output ${out.message}`, input);
            return done({ branch: result.branch, output: out.value });
          }
          case "loop":
            return done({ output: { items: result.items } });
          case "suspend":
            return done({ signal: "suspend" });
          case "stop":
            return done({ signal: "stop", output: { stopped: true, reason: result.reason } });
          case "subflow":
            return done({
              signal: "subflow",
              output: { workflowId: result.workflowId, input: result.input },
            });
        }
      }
      const out = await checkOutput(result);
      if (!out.ok) return fail(`Step "${label}": output ${out.message}`, input);
      return done({ output: out.value });
    },
  };
}
