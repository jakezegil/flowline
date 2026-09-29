// A named import (no `with { type: "json" }`) lets esbuild/Rollup tree-shake the JSON module
// down to this one property, so the bundled dist doesn't ship the rest of package.json
// (scripts, devDependencies, ...). See packages/react/src/index.test.ts.
import { version } from "../package.json";

/** Package version, read from `package.json` so it can never drift from the published version. */
export const VERSION: string = version;

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
  NOTE_GAP,
  NOTE_W,
  PLACEHOLDER_H,
  SECTION_HEADER_H,
  SECTION_PAD,
  V_GAP,
} from "./layout/constants";
export {
  type LayoutEdge,
  type LayoutNode,
  type LayoutNote,
  type LayoutSection,
  layoutTree,
} from "./layout/layout-tree";
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
