import type { z } from "zod";
import { FlowkitDefinitionError, type NodeDefinition, type TriggerDefinition } from "./define";
import { isValidStepId, RESERVED_STEP_IDS, STEP_ID_PATTERN } from "./ids";
import { parseRefPath, parseTemplate } from "./refs";
import type { RefExpr, Step, TplExpr, ValueExpr, WorkflowDoc } from "./types";

const WORKFLOW_ID = /^[a-z0-9][a-z0-9-_]*$/;

/**
 * Create a reference expression (`{ $ref: path }`). The path syntax is checked immediately.
 *
 * @throws {@link FlowkitRefError} if `path` is not a valid reference path.
 *
 * @example
 * ```ts
 * ref("steps.loadContact.email") // → { $ref: "steps.loadContact.email" }
 * ```
 */
export function ref(path: string): RefExpr {
  parseRefPath(path);
  return { $ref: path };
}

/**
 * Create a template expression (`{ $tpl: template }`). Every `{{ path }}` inside is checked
 * immediately.
 *
 * @throws {@link FlowkitRefError} if an interpolated path is not a valid reference path.
 *
 * @example
 * ```ts
 * tpl("Congrats on {{trigger.deal.name}}")
 * ```
 */
export function tpl(template: string): TplExpr {
  for (const part of parseTemplate(template)) {
    if ("ref" in part) parseRefPath(part.ref);
  }
  return { $tpl: template };
}

/**
 * A config value of type `T` where a {@link RefExpr} or {@link TplExpr} may stand in for the
 * value itself or for any nested property or array element.
 */
export type DeepExpr<T> = T extends readonly (infer E)[]
  ? DeepExpr<E>[] | RefExpr | TplExpr
  : T extends object
    ? { [K in keyof T]: DeepExpr<T[K]> } | RefExpr | TplExpr
    : T | RefExpr | TplExpr;

/**
 * The config accepted by {@link StepsBuilder.step} for node `N`: its input schema's input type
 * (`z.input`, so fields with defaults are optional) with references allowed at any depth.
 */
export type ConfigOf<N extends { input: z.ZodType }> = StepConfig<z.input<N["input"]>>;

/**
 * The config accepted by {@link WorkflowBuilder.trigger} for trigger `T`: its config schema's
 * input type with references (rooted at `trigger.`) allowed at any depth.
 */
export type TriggerConfigOf<T extends { config: z.ZodType }> = StepConfig<z.input<T["config"]>>;

/**
 * A config object with fields `I` where references may stand in at any depth. Compile errors
 * name it with the plain field types, e.g. `StepConfig<{ baseUrl: string; token: string }>`.
 */
export type StepConfig<I> = { [K in keyof I]: DeepExpr<I[K]> };

/**
 * The config arguments of a builder method: optional when `{}` is a valid config (an empty
 * schema, or one whose fields are all optional or defaulted), required otherwise. Checked with
 * `{}` rather than `object`, because Zod types the input of `z.object({})` as
 * `Record<string, never>`, which `object` is not assignable to.
 */
// biome-ignore lint/complexity/noBannedTypes: `{}` is exactly "a config with no required fields"
type ConfigArgs<C, Rest extends unknown[] = []> = {} extends C
  ? [config?: C, ...rest: Rest]
  : [config: C, ...rest: Rest];

/** The `branches` argument of {@link StepsBuilder.step}. */
type BranchFillers = Record<string, (b: StepsBuilder) => StepsBuilder>;

// biome-ignore lint/suspicious/noExplicitAny: any node definition
type AnyNode = NodeDefinition<any, any, any>;
// biome-ignore lint/suspicious/noExplicitAny: any trigger definition
type AnyTrigger = TriggerDefinition<any, any>;

/** Builds a list of steps; the root {@link WorkflowBuilder} and every branch builder are one. */
export interface StepsBuilder {
  /**
   * Append a step running `node` with `config`. `config` may be omitted when every config field is
   * optional. For branching or looping nodes, `branches` maps each branch ID (e.g. `if`/`else`,
   * switch case IDs, forEach's `body`) to a callback that adds the branch's steps to the builder
   * it receives and returns it.
   *
   * @throws {@link FlowkitDefinitionError} if `id` is not a valid step ID or is already used
   * anywhere in the workflow.
   */
  step<N extends AnyNode>(
    id: string,
    node: N,
    ...args: ConfigArgs<ConfigOf<N>, [branches?: BranchFillers]>
  ): this;
}

/** Fluent builder for a {@link WorkflowDoc}, created with {@link workflow}. */
export interface WorkflowBuilder extends StepsBuilder {
  /**
   * Set the trigger. `config` may be omitted when every config field is optional. Calling it
   * again replaces the trigger.
   */
  trigger<T extends AnyTrigger>(t: T, ...config: ConfigArgs<TriggerConfigOf<T>>): this;
  /** Set the output mapping evaluated at the end of a run (for sub-flows). */
  output(map: Record<string, ValueExpr>): this;
  /**
   * Produce the workflow document. Each call returns a fresh copy. The builder does not check
   * the doc against a registry; use `validateWorkflow` for that.
   *
   * @throws {@link FlowkitDefinitionError} if no trigger was set.
   */
  build(): WorkflowDoc;
}

/** Deep-copies a config value, dropping `undefined` object properties (not JSON-representable). */
function cleanValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(cleanValue);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (v !== undefined) out[k] = cleanValue(v);
    }
    return out;
  }
  return value;
}

function cleanConfig(config: unknown): Record<string, ValueExpr> {
  return (cleanValue(config ?? {}) ?? {}) as Record<string, ValueExpr>;
}

const STEPS = Symbol("flowkit.builderSteps");

class StepsBuilderImpl implements StepsBuilder {
  readonly [STEPS]: Step[] = [];

  constructor(protected readonly usedIds: Set<string>) {}

  step<N extends AnyNode>(
    id: string,
    node: N,
    ...[config, branches]: [config?: unknown, branches?: BranchFillers]
  ): this {
    if (!isValidStepId(id)) {
      throw new FlowkitDefinitionError(
        `Invalid step id "${id}": must match ${STEP_ID_PATTERN} (letters, digits, underscores; not starting with a digit) and not be one of ${[...RESERVED_STEP_IDS].join(", ")}`,
      );
    }
    if (this.usedIds.has(id)) {
      throw new FlowkitDefinitionError(
        `Duplicate step id "${id}": step ids must be unique within a workflow`,
      );
    }
    this.usedIds.add(id);

    const step: Step = { id, type: node.type, config: cleanConfig(config) };
    if (branches !== undefined) {
      step.branches = {};
      for (const [branchId, fill] of Object.entries(branches)) {
        const child = new StepsBuilderImpl(this.usedIds);
        const result = fill(child);
        if (!(result instanceof StepsBuilderImpl)) {
          throw new FlowkitDefinitionError(
            `Branch "${branchId}" of step "${id}" must return the builder it was given`,
          );
        }
        step.branches[branchId] = result[STEPS];
      }
    }
    this[STEPS].push(step);
    return this;
  }
}

class WorkflowBuilderImpl extends StepsBuilderImpl implements WorkflowBuilder {
  #trigger: WorkflowDoc["trigger"] | undefined;
  #output: Record<string, ValueExpr> | undefined;

  constructor(
    private readonly id: string,
    private readonly meta: { name?: string; description?: string },
  ) {
    super(new Set());
  }

  trigger<T extends AnyTrigger>(t: T, ...args: [config?: unknown]): this {
    this.#trigger = { type: t.type, config: cleanConfig(args[0]) };
    return this;
  }

  output(map: Record<string, ValueExpr>): this {
    this.#output = cleanConfig(map);
    return this;
  }

  build(): WorkflowDoc {
    if (this.#trigger === undefined) {
      throw new FlowkitDefinitionError(
        `workflow "${this.id}" has no trigger; call .trigger() before .build()`,
      );
    }
    const doc: WorkflowDoc = {
      id: this.id,
      name: this.meta.name ?? this.id,
      ...(this.meta.description !== undefined ? { description: this.meta.description } : {}),
      trigger: this.#trigger,
      steps: this[STEPS],
      ...(this.#output !== undefined ? { output: this.#output } : {}),
    };
    return structuredClone(doc);
  }
}

/**
 * Start building a workflow in code. Config passed to `.trigger()` and `.step()` is type-checked
 * against the definitions' schemas, with {@link ref} and {@link tpl} allowed anywhere.
 *
 * @param id - Workflow ID, matching `/^[a-z0-9][a-z0-9-_]*$/`.
 * @param meta - Display name (defaults to `id`) and description.
 * @throws {@link FlowkitDefinitionError} if `id` is invalid.
 *
 * @example
 * ```ts
 * import { ref, workflow } from "@flowkit/core";
 * import { and, conditionNode, delayNode, eq, eventTrigger, stopNode } from "@flowkit/nodes-builtin";
 *
 * const dealWon = workflow("deal-won", { name: "Deal won follow-up" })
 *   .trigger(eventTrigger, { event: "deal.updated" })
 *   .step("check", conditionNode, { rules: and(eq(ref("trigger.stage"), "won")) }, {
 *     if: (b) => b.step("wait", delayNode, { duration: "2d" }),
 *     else: (b) => b.step("halt", stopNode, { reason: "Not won" }),
 *   })
 *   .build();
 * ```
 * (This example is compiled by `@flowkit/nodes-builtin`'s `builder-example.test.ts`.)
 */
export function workflow(
  id: string,
  meta: { name?: string; description?: string } = {},
): WorkflowBuilder {
  if (typeof id !== "string" || !WORKFLOW_ID.test(id)) {
    throw new FlowkitDefinitionError(
      `Invalid workflow id "${id}": must match ${WORKFLOW_ID} (lowercase letters, digits, "-", "_")`,
    );
  }
  return new WorkflowBuilderImpl(id, meta);
}
