/**
 * `@flowkit/nodes-builtin`: the `core.*` nodes and triggers every Flowkit engine provides.
 *
 * @module
 */
import { definePlugin, type PluginDefinition } from "@flowkit/core";
import { conditionNode, forEachNode, stopNode, switchNode } from "./logic";
import { callSubflowNode } from "./subflow";
import { delayNode, waitForCallbackNode } from "./time";
import {
  eventTrigger,
  manualTrigger,
  scheduleTrigger,
  subflowTrigger,
  webhookTrigger,
} from "./triggers";

/** Package version. */
export const VERSION = "0.1.0";

export { conditionNode, forEachNode, stopNode, switchNode } from "./logic";
export {
  and,
  contains,
  endsWith,
  eq,
  evaluateRules,
  gt,
  gte,
  isEmpty,
  isFalse,
  isIn,
  isNotEmpty,
  isTrue,
  looseEquals,
  lt,
  lte,
  neq,
  notContains,
  or,
  RULE_OPS,
  type Rule,
  type RuleGroup,
  RuleGroupSchema,
  type RuleOp,
  RuleSchema,
  startsWith,
} from "./rules";
export { callSubflowNode } from "./subflow";
export { delayNode, parseDuration, waitForCallbackNode } from "./time";
export {
  eventTrigger,
  manualTrigger,
  scheduleTrigger,
  subflowTrigger,
  webhookTrigger,
} from "./triggers";

/**
 * The built-in `core` plugin: logic, timing and sub-flow nodes plus the event, webhook, manual,
 * schedule and sub-flow triggers. `createEngine` registers it automatically (unless
 * `builtins: false`); add it to your own registry to build a manifest for the editor.
 */
export const builtinPlugin: PluginDefinition = definePlugin({
  id: "core",
  name: "Built-in",
  icon: "blocks",
  description: "Logic, timing, sub-flows and the standard triggers.",
  nodes: [
    conditionNode,
    switchNode,
    forEachNode,
    stopNode,
    delayNode,
    waitForCallbackNode,
    callSubflowNode,
  ],
  triggers: [eventTrigger, webhookTrigger, manualTrigger, scheduleTrigger, subflowTrigger],
});
