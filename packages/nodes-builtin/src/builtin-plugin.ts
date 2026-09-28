/**
 * The built-in `core` plugin and its factory.
 *
 * @module
 */
import { definePlugin, FlowlineDefinitionError, type PluginDefinition } from "@flowlinejs/core";
import { httpRequest } from "./http";
import {
  conditionNode,
  createConditionNode,
  createSwitchNode,
  forEachNode,
  stopNode,
  switchNode,
} from "./logic";
import { type CompareMode, type CustomOperator, isBuiltinRuleOp } from "./rules";
import { callSubflowNode } from "./subflow";
import { delayNode, waitForCallbackNode } from "./time";
import { transform } from "./transform";
import {
  eventTrigger,
  manualTrigger,
  scheduleTrigger,
  subflowTrigger,
  webhookTrigger,
} from "./triggers";

/** Options of {@link createBuiltinPlugin}. */
export interface BuiltinOptions {
  /**
   * Default compare mode of `core.condition` and `core.switch` (published as the schema default
   * of their `compare` fields). A rule set or switch that sets `compare` itself keeps it.
   * Default `"loose"`.
   */
  compare?: CompareMode;
  /** Additional rule operators for `core.condition`, offered in the editor by label. */
  operators?: CustomOperator[];
}

/**
 * The built-in `core` plugin with host choices applied: logic, timing, sub-flow, HTTP request and
 * transform nodes plus the event, webhook, manual, schedule and sub-flow triggers. Register it in
 * your registry so the engine and the editor manifest agree; `createEngine` then doesn't add
 * {@link builtinPlugin} (it adds it only when the registry has no plugin with ID `"core"`).
 *
 * @example
 * ```ts
 * const registry = createRegistry([
 *   createBuiltinPlugin({ compare: "strict", operators: [isUnassigned] }),
 *   crmPlugin,
 * ]);
 * ```
 *
 * @throws {@link FlowlineDefinitionError} when two operators share an id, or one uses the id of
 * a built-in operator (`eq`, `contains`, …).
 */
export function createBuiltinPlugin(opts: BuiltinOptions = {}): PluginDefinition {
  const compare = opts.compare ?? "loose";
  const operators = [...(opts.operators ?? [])];
  const seen = new Set<string>();
  for (const { id } of operators) {
    if (isBuiltinRuleOp(id)) {
      throw new FlowlineDefinitionError(
        `Custom rule operator "${id}" has the id of a built-in operator; choose another id`,
      );
    }
    if (seen.has(id)) {
      throw new FlowlineDefinitionError(`Custom rule operator "${id}" is registered twice`);
    }
    seen.add(id);
  }
  // The defaults reuse the exported `conditionNode` / `switchNode` instances.
  const logic = { compare, operators };
  const condition =
    compare === "loose" && operators.length === 0 ? conditionNode : createConditionNode(logic);
  const switchStep = compare === "loose" ? switchNode : createSwitchNode(logic);
  return definePlugin({
    id: "core",
    name: "Built-in",
    icon: "blocks",
    description: "Logic, timing, sub-flows, HTTP requests, transforms and the standard triggers.",
    nodes: [
      condition,
      switchStep,
      forEachNode,
      stopNode,
      delayNode,
      waitForCallbackNode,
      callSubflowNode,
      httpRequest,
      transform,
    ],
    triggers: [eventTrigger, webhookTrigger, manualTrigger, scheduleTrigger, subflowTrigger],
  });
}
