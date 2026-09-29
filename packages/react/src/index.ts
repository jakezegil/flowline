import pkg from "../package.json" with { type: "json" };

/** Package version, read from `package.json` so it can never drift from the published version. */
export const VERSION: string = pkg.version;

export type { RunOverlay, RunStepStatus } from "./canvas/canvas-context";
export { WorkflowCanvas } from "./canvas/workflow-canvas";
export { WorkflowEditor } from "./editor/workflow-editor";
export {
  EditorContext,
  FlowlineClientContext,
  type RunChange,
  useDataPicker,
  useEditorStore,
  useEditorStoreApi,
  useIssues,
  useRun,
  useRunChanges,
  useSelection,
  useShallow,
  useStep,
  useWorkflow,
} from "./hooks";
export { bundledIconNames, type IconComponent } from "./icons";
export { defaultLabels, type FlowlineLabels } from "./labels";
export {
  BRANCH_GAP,
  CARD_H,
  CARD_W,
  JOIN_SIZE,
  LABEL_H,
  LOOP_GUTTER,
  PLACEHOLDER_H,
  V_GAP,
} from "./layout/constants";
export { type LayoutEdge, type LayoutNode, layoutTree } from "./layout/layout-tree";
export {
  CodeEditor,
  ConfigPanel,
  DataPicker,
  RefTextInput,
  SchemaForm,
  TestStep,
} from "./panel";
export {
  type FieldWidget,
  type FieldWidgetProps,
  type FlowlineNotice,
  FlowlineProvider,
  type NotifyHandler,
  useFlowline,
} from "./provider";
export { RunList } from "./run/run-list";
export { buildRunOverlay } from "./run/run-overlay";
export type { RunDisplayState } from "./run/run-status";
export { type ResumeActionContext, type ResumeActionProp, RunViewer } from "./run/run-viewer";
export {
  createEditorStore,
  type EditorActions,
  type EditorState,
  type EditorStore,
  type InsertOptions,
  type TestState,
  TRIGGER_KEY,
} from "./store/editor-store";
export type { FlowlineTheme, ThemeToken } from "./theme";
export type { NotFoundAction } from "./ui/not-found";
