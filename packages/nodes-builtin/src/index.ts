/**
 * `@flowline/nodes-builtin`: the `core.*` nodes and triggers every Flowline engine provides.
 *
 * @module
 */
import { definePlugin, type PluginDefinition } from "@flowline/core";
import { httpRequest } from "./http";
import { conditionNode, forEachNode, stopNode, switchNode } from "./logic";
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

/** Package version. */
export const VERSION = "0.1.0";

export { httpRequest as httpRequestNode } from "./http";
export { conditionNode, forEachNode, stopNode, switchNode } from "./logic";
export {
  and,
  ConditionRulesSchema,
  contains,
  type EqualsOptions,
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
  type RuleOptions,
  RuleSchema,
  startsWith,
} from "./rules";
export { callSubflowNode } from "./subflow";
export { delayNode, MAX_DURATION_MS, parseDuration, waitForCallbackNode } from "./time";
export { transform as transformNode } from "./transform";
export {
  eventTrigger,
  manualTrigger,
  scheduleTrigger,
  subflowTrigger,
  webhookTrigger,
} from "./triggers";

/**
 * The built-in `core` plugin: logic, timing, sub-flow, HTTP request and transform nodes plus the
 * event, webhook, manual, schedule and sub-flow triggers. `createEngine` registers it
 * automatically (unless `builtins: false`); add it to your own registry to build a manifest for
 * the editor.
 */
export const builtinPlugin: PluginDefinition = definePlugin({
  id: "core",
  name: "Built-in",
  icon: "blocks",
  description: "Logic, timing, sub-flows, HTTP requests, transforms and the standard triggers.",
  nodes: [
    conditionNode,
    switchNode,
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
