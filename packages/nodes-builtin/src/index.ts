/**
 * `@flowlinejs/nodes-builtin`: the `core.*` nodes and triggers every Flowline engine provides.
 *
 * @module
 */
import type { PluginDefinition } from "@flowlinejs/core";
import { createBuiltinPlugin } from "./builtin-plugin";

/** Package version. */
export const VERSION = "0.1.0";

export type { RuleOperatorMeta, RuleValueType } from "@flowlinejs/core";
export { type BuiltinOptions, createBuiltinPlugin } from "./builtin-plugin";
export { httpRequest as httpRequestNode } from "./http";
export { conditionNode, forEachNode, stopNode, switchNode } from "./logic";
export {
  and,
  type CompareMode,
  type ConditionRules,
  ConditionRulesSchema,
  type ConditionRulesSchemaOptions,
  type CustomOperator,
  contains,
  createConditionRulesSchema,
  custom,
  type EqualsOptions,
  type EvaluateOptions,
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
  loosely,
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
  strictEquals,
  strictly,
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
 * The built-in `core` plugin with the defaults: `createBuiltinPlugin()` (loose comparisons, no
 * custom rule operators). It holds logic, timing, sub-flow, HTTP request and transform nodes plus
 * the event, webhook, manual, schedule and sub-flow triggers. `createEngine` registers it
 * automatically (unless `builtins: false`, or the registry already has a `core` plugin, e.g. one
 * from {@link createBuiltinPlugin}); add it to your own registry to build a manifest for the
 * editor.
 */
export const builtinPlugin: PluginDefinition = createBuiltinPlugin();
