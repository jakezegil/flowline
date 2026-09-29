// A named import (no `with { type: "json" }`) lets esbuild/Rollup tree-shake the JSON module
// down to this one property, so the bundled dist doesn't ship the rest of package.json
// (scripts, devDependencies, ...). See packages/core/src/index.test.ts.
import { version } from "../package.json";

/** Package version, read from `package.json` so it can never drift from the published version. */
export const VERSION: string = version;

export { apply, changedStepIds, FlowlineCommandError } from "./agent/apply";
export {
  commandCatalog,
  readArgSchemas,
  runTool,
  type ToolDefinition,
  type ToolState,
} from "./agent/catalog";
export { commandSchema, opJsonSchema } from "./agent/command-schema";
export type {
  ApplyError,
  ApplyOptions,
  ApplyResult,
  At,
  BulkCommand,
  Command,
  CommandErrorCode,
  ConfigPatch,
  Fragment,
  SectionCommand,
  SectionInput,
  SingleCommand,
  StepRef,
  StepUpdate,
} from "./agent/commands";
export { compactSchema } from "./agent/compact-schema";
export { cutString, formatCall, resultSize, stepLine } from "./agent/format";
export { outline, overview } from "./agent/outline";
export type {
  FollowUp,
  Include,
  Omission,
  OutlineResult,
  ReadArgs,
  ReadFn,
  ReadOptions,
  ReadResults,
  ReadToolName,
  RefInfo,
  SectionInfo,
  StepDetail,
  Where,
} from "./agent/read-types";
export {
  availableRefs,
  describeNodeTypes,
  findSteps,
  focus,
  getIssues,
  getSteps,
  listNodeTypes,
  reads,
} from "./agent/reads";
export { annotationRepairs } from "./agent/repairs";
export { matchSteps } from "./agent/selectors";
export {
  ANNOTATION_COLORS,
  isAnnotationColor,
  NOTE_MAX_CHARS,
  type SectionEffect,
  sectionIdFor,
  sectionOf,
  sectionRun,
  upkeepSections,
} from "./annotations";
export type {
  ApiErrorBody,
  JournalEntry,
  PublishRequest,
  RunDetail,
  RunError,
  RunEvent,
  RunEventType,
  RunOrigin,
  RunStartedResponse,
  RunStatus,
  RunSummary,
  RunWorkflowRequest,
  SubflowInfo,
  TestStepRequest,
  TestStepResponse,
  WorkflowDetail,
  WorkflowSummary,
  WorkflowVersion,
} from "./api-types";
export {
  type ConfigOf,
  type DeepExpr,
  ref,
  type StepConfig,
  type StepsBuilder,
  type TriggerConfigOf,
  tpl,
  type WorkflowBuilder,
  workflow,
} from "./builder";
export type { ClientOptions, FlowlineClient } from "./client";
export {
  type BranchSignal,
  branch,
  type CallbackHandle,
  defineNode,
  definePlugin,
  defineTrigger,
  FLOWLINE_SIGNAL,
  FlowlineDefinitionError,
  type FlowlineServices,
  invokeSubflow,
  isSignal,
  type Logger,
  type LoopSignal,
  loop,
  type NodeContext,
  type NodeDefinition,
  type NodeResult,
  type PluginDefinition,
  type PollArgs,
  type PollContext,
  type PollItem,
  type PollResult,
  type ResumeInfo,
  type RetryPolicy,
  type Signal,
  type StopSignal,
  type SubflowSignal,
  type SuspendSignal,
  stop,
  suspend,
  type TransformRuntime,
  type TriggerDedupe,
  type TriggerDefinition,
} from "./define";
export {
  type UnreachableGroup,
  unreachableSteps,
} from "./design-checks";
export { FatalError, type FatalErrorOptions, RetryableError } from "./errors";
export {
  branchesFor,
  checkFields,
  configValueAt,
  derefSchema,
  describeType,
  fieldsToJsonSchema,
  isAnySchema,
  isAssignable,
  outputSchemaFor,
  payloadSchemaFor,
  schemaAtPath,
  secretExprPath,
  subflowOutputFields,
  subflowOutputSchema,
} from "./json-schema";
export { isPrivateAddress, isPrivateHost, normalizeHost } from "./net";
export {
  collectRefs,
  FlowlineRefError,
  formatRefPath,
  isRef,
  isTpl,
  parseRefPath,
  parseTemplate,
  type RefPath,
  type RefRoot,
  type ResolveScope,
  renderTemplate,
  resolveValue,
  type TemplatePart,
} from "./refs";
export { createRegistry, type Registry } from "./registry";
export {
  availableScope,
  describeSubflowOutput,
  type ScopeEntry,
  type ValidationContext,
} from "./scope";
export {
  dropHiddenFields,
  hiddenFields,
  isFieldShown,
  showIfOf,
  showIfProblems,
} from "./show-if";
export {
  copyName,
  createStep,
  defaultConfig,
  jsonEqual,
  replaceStepType,
  syncBranches,
} from "./step-factory";
export {
  allStepIds,
  branchList,
  cloneRunWithFreshIds,
  codeBlocksRename,
  duplicateStep,
  FlowlineTreeError,
  type FoundStep,
  findStep,
  generateStepId,
  insertStep,
  isGeneratedStepId,
  moveStep,
  removeStep,
  renameStepId,
  type StepLocation,
  updateStep,
  walkSteps,
} from "./tree";
export type {
  AnnotationColor,
  BranchSpec,
  DurationInput,
  FieldDecl,
  FieldType,
  JSONSchema,
  Literal,
  Manifest,
  NodeManifest,
  OutputSpec,
  PluginManifest,
  RefExpr,
  ResumeSpec,
  RuleOperatorMeta,
  RuleValueType,
  Section,
  ShowIf,
  Step,
  TplExpr,
  TriggerConfig,
  TriggerKind,
  TriggerManifest,
  UiMeta,
  ValueExpr,
  WorkflowDoc,
} from "./types";
export { fields, secret, sensitive, UI_META_KEY, ui } from "./ui";
export { checkJson, hasErrors, type Issue, type IssueCode, validateWorkflow } from "./validate";
