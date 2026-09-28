/** Package version. */
export const VERSION = "0.1.0";

export type { RunOverlay, RunStepStatus } from "./canvas/canvas-context";
export { WorkflowCanvas } from "./canvas/workflow-canvas";

export {
  EditorContext,
  FlowkitClientContext,
  useDataPicker,
  useEditorStore,
  useEditorStoreApi,
  useIssues,
  useRun,
  useSelection,
  useShallow,
  useStep,
  useWorkflow,
} from "./hooks";
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
  type FieldWidget,
  type FieldWidgetProps,
  FlowkitProvider,
  useFlowkit,
} from "./provider";
export {
  createEditorStore,
  type EditorActions,
  type EditorState,
  type EditorStore,
  type InsertOptions,
  type TestState,
  TRIGGER_KEY,
} from "./store/editor-store";
export type { FlowkitTheme, ThemeToken } from "./theme";
