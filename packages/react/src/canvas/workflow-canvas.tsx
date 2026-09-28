import { branchesFor, type Manifest, type WorkflowDoc } from "@flowkit/core";
import * as Tooltip from "@radix-ui/react-tooltip";
import {
  type AriaLabelConfig,
  Background,
  BackgroundVariant,
  type Edge,
  type Node,
  type NodeHandle,
  Panel,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  useStoreApi,
} from "@xyflow/react";
import { Maximize, Minus, Plus } from "lucide-react";
import { type JSX, type RefObject, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { EditorContext, stepIndex, useEditorStore } from "../hooks";
import { LOOP_GUTTER } from "../layout/constants";
import { type LayoutEdge, type LayoutNode, layoutTree } from "../layout/layout-tree";
import { useFlowkitAppearance } from "../provider";
import { type EditorStore, TRIGGER_KEY } from "../store/editor-store";
import { themeStyle } from "../theme";
import { AddPlaceholder } from "./add-placeholder";
import {
  CanvasUiContext,
  createCanvasUiStore,
  PortalContainerContext,
  RootElementContext,
  type RunOverlay,
  useCanvasUiApi,
} from "./canvas-context";
import { edgeTypes, type FlowEdgeData } from "./edges";
import { edgeGeometries } from "./geometry";
import { handleCanvasKey } from "./keyboard";
import { EndNode, RejoinNode } from "./rejoin-node";
import { StepCard, stepDisplayName } from "./step-card";
import { StepPicker } from "./step-picker";
import { Toasts } from "./toast";
import { TriggerCard } from "./trigger-card";

const nodeTypes = {
  trigger: TriggerCard,
  step: StepCard,
  placeholder: AddPlaceholder,
  join: RejoinNode,
  end: EndNode,
};

/** Top padding (and side padding, space permitting) of the initial fit. */
const FIT_PADDING = 100;
/** Fitting a tall workflow's height never zooms out further than this (it scrolls instead). */
const FIT_MIN_ZOOM_FOR_HEIGHT = 0.75;
/**
 * The initial fit never zooms out further than this to fit the width: on a narrow screen a
 * readable trigger, centered, beats a whole workflow too small to read (the rest is a pan away).
 */
const FIT_MIN_ZOOM_FOR_WIDTH = 0.7;
const MIN_ZOOM = 0.25;
const MAX_ZOOM = 1.5;

const EMPTY_DATA = {};

function ariaLabels(readOnly: boolean): Partial<AriaLabelConfig> {
  const nav = "Use the arrow keys to move between steps and Enter to open one.";
  const edit = `${nav} Press Delete to remove the selected step, and Escape to clear the selection.`;
  return {
    "node.a11yDescription.default": readOnly ? nav : edit,
    "node.a11yDescription.keyboardDisabled": readOnly ? nav : edit,
    "edge.a11yDescription.default": "Connection between steps.",
    "controls.ariaLabel": "Canvas controls",
    "controls.zoomIn.ariaLabel": "Zoom in",
    "controls.zoomOut.ariaLabel": "Zoom out",
    "controls.fitView.ariaLabel": "Fit workflow to view",
  };
}

function handlesOf(w: number, h: number): NodeHandle[] {
  return [
    { type: "target", position: Position.Top, x: w / 2, y: 0, width: 1, height: 1 },
    { type: "source", position: Position.Bottom, x: w / 2, y: h, width: 1, height: 1 },
  ];
}

/** Builds the xyflow node of a layout node. */
function toFlowNode(
  ln: LayoutNode,
  selection: string | null,
  label: (ln: LayoutNode) => string | undefined,
): Node {
  const base = {
    id: ln.id,
    position: { x: ln.x, y: ln.y },
    width: ln.w,
    height: ln.h,
    handles: handlesOf(ln.w, ln.h),
    draggable: false,
    connectable: false,
    deletable: false,
  };
  const ariaLabel = label(ln);
  switch (ln.kind) {
    case "trigger":
      return {
        ...base,
        type: "trigger",
        data: EMPTY_DATA,
        selected: selection === TRIGGER_KEY,
        ...(ariaLabel ? { ariaLabel } : {}),
      };
    case "step":
      return {
        ...base,
        type: "step",
        data: { stepId: ln.stepId, depth: ln.depth },
        selected: selection === ln.stepId,
        ...(ariaLabel ? { ariaLabel } : {}),
      };
    case "placeholder":
      return {
        ...base,
        type: "placeholder",
        data: { loc: ln.loc },
        selectable: false,
        focusable: false,
      };
    case "join":
      return {
        ...base,
        type: "join",
        data: { blockId: ln.blockId },
        selectable: false,
        focusable: false,
      };
    default:
      return { ...base, type: "end", data: EMPTY_DATA, selectable: false, focusable: false };
  }
}

function sameNode(a: Node, b: Node): boolean {
  return (
    a.type === b.type &&
    a.position.x === b.position.x &&
    a.position.y === b.position.y &&
    a.width === b.width &&
    a.height === b.height &&
    a.selected === b.selected &&
    a.ariaLabel === b.ariaLabel &&
    JSON.stringify(a.data) === JSON.stringify(b.data)
  );
}

/**
 * Keeps unchanged node and edge objects referentially equal across renders, so xyflow skips
 * re-rendering them (and memoized cards stay put) when an unrelated part of the doc changes.
 */
function useStable<T extends { id: string }>(items: T[], same: (a: T, b: T) => boolean): T[] {
  const cache = useRef(new Map<string, T>());
  return useMemo(() => {
    const next = new Map<string, T>();
    const out = items.map((item) => {
      const prev = cache.current.get(item.id);
      const kept = prev && same(prev, item) ? prev : item;
      next.set(item.id, kept);
      return kept;
    });
    cache.current = next;
    return out;
  }, [items, same]);
}

const sameEdge = (a: Edge<FlowEdgeData>, b: Edge<FlowEdgeData>) =>
  a.type === b.type && JSON.stringify(a.data) === JSON.stringify(b.data);

/** Builds the xyflow edges of a layout, with geometry, branch labels and leftover flags. */
function toFlowEdges(
  doc: WorkflowDoc,
  manifest: Manifest,
  nodes: LayoutNode[],
  edges: LayoutEdge[],
): Edge<FlowEdgeData>[] {
  const geometry = edgeGeometries(nodes, edges, LOOP_GUTTER);
  const steps = stepIndex(doc);
  return edges.map((le) => {
    const data: FlowEdgeData = { edge: le, geometry: geometry.get(le.id) ?? { path: "" } };
    if (le.kind === "branch") {
      const blockId = le.source.slice("step:".length);
      const step = steps.get(blockId);
      const m = step ? manifest.nodes.find((n) => n.type === step.type) : undefined;
      data.blockId = blockId;
      data.leftover = !!(m && step && !branchesFor(m, step).some((b) => b.id === le.branchId));
      data.label = m?.branches.kind === "loop" && !data.leftover ? "Each item" : le.label;
    }
    const edge: Edge<FlowEdgeData> = {
      id: le.id,
      type: le.kind,
      source: le.source,
      target: le.target,
      data,
      selectable: false,
      focusable: false,
      deletable: false,
      // Lines are decorative: branch labels and "+" buttons carry the meaning.
      domAttributes: { "aria-hidden": true },
    };
    return edge;
  });
}

/** Zoom and fit buttons. */
function Controls({ onFit }: { onFit(): void }) {
  const rf = useReactFlow();
  return (
    <Panel position="bottom-left" className="fk-controls" aria-label="Canvas controls">
      <button
        type="button"
        aria-label="Zoom out"
        title="Zoom out"
        onClick={() => rf.zoomOut({ duration: 150 })}
      >
        <Minus size={14} aria-hidden />
      </button>
      <button
        type="button"
        aria-label="Zoom in"
        title="Zoom in"
        onClick={() => rf.zoomIn({ duration: 150 })}
      >
        <Plus size={14} aria-hidden />
      </button>
      <button
        type="button"
        aria-label="Fit workflow to view"
        title="Fit workflow to view"
        onClick={onFit}
      >
        <Maximize size={14} aria-hidden />
      </button>
    </Panel>
  );
}

interface FlowProps {
  layoutRef: RefObject<ReturnType<typeof layoutTree> | null>;
  rootRef: RefObject<HTMLDivElement | null>;
  readOnly: boolean;
  colorMode: "light" | "dark" | "system";
  onStepClick?(id: string): void;
}

function CanvasFlow({ layoutRef, rootRef, readOnly, colorMode, onStepClick }: FlowProps) {
  const doc = useEditorStore((s) => s.doc);
  const manifest = useEditorStore((s) => s.manifest);
  const selection = useEditorStore((s) => s.selection);
  const select = useEditorStore((s) => s.select);
  const ui = useCanvasUiApi();
  const rf = useReactFlow();
  const flowStore = useStoreApi();

  const layout = useMemo(() => layoutTree(doc, manifest), [doc, manifest]);
  layoutRef.current = layout;

  const label = useCallback(
    (ln: LayoutNode): string | undefined => {
      if (ln.kind === "trigger") {
        const t = manifest.triggers.find((x) => x.type === doc.trigger.type);
        return `Trigger: ${t?.name ?? doc.trigger.type}`;
      }
      if (ln.kind !== "step") return undefined;
      const step = stepIndex(doc).get(ln.stepId);
      if (!step) return undefined;
      const name = stepDisplayName(
        step,
        manifest.nodes.find((n) => n.type === step.type),
      );
      return step.disabled ? `${name} (disabled)` : name;
    },
    [doc, manifest],
  );
  const rawNodes = useMemo(
    () => layout.nodes.map((ln) => toFlowNode(ln, selection, label)),
    [layout, selection, label],
  );
  const nodes = useStable(rawNodes, sameNode);
  const rawEdges = useMemo(
    () => toFlowEdges(doc, manifest, layout.nodes, layout.edges),
    [doc, manifest, layout],
  );
  const edges = useStable(rawEdges, sameEdge);

  /**
   * Fits the workflow, anchored to the top. The initial fit only zooms out to a readable zoom
   * (a tall or wide workflow then pans); `whole` (the "Fit" button) fits everything.
   */
  const fitTop = useCallback(
    (duration = 0, whole = false) => {
      const { width: W, height: H } = flowStore.getState();
      const l = layoutRef.current;
      if (!l || W === 0 || H === 0) return;
      const padX = Math.min(FIT_PADDING, W / 16);
      const padTop = Math.min(FIT_PADDING, H / 8);
      const byWidth = (W - 2 * padX) / l.width;
      const byHeight = (H - padTop - padX) / l.height;
      const zoom = whole
        ? Math.max(MIN_ZOOM, Math.min(1, byWidth, byHeight))
        : Math.min(
            1,
            Math.max(byWidth, FIT_MIN_ZOOM_FOR_WIDTH),
            Math.max(byHeight, FIT_MIN_ZOOM_FOR_HEIGHT),
          );
      rf.setViewport({ x: W / 2, y: padTop, zoom }, { duration });
    },
    [rf, flowStore, layoutRef],
  );

  // Refit when a different workflow is loaded.
  const docId = doc.id;
  const fitted = useRef<string | null>(null);
  useEffect(() => {
    if (fitted.current !== null && fitted.current !== docId) fitTop();
    fitted.current = docId;
  }, [docId, fitTop]);

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      edgeTypes={edgeTypes}
      aria-label="Workflow canvas"
      colorMode={colorMode}
      ariaLabelConfig={ariaLabels(readOnly)}
      nodesDraggable={false}
      nodesConnectable={false}
      elementsSelectable
      nodesFocusable
      edgesFocusable={false}
      panOnScroll
      zoomOnScroll
      zoomOnDoubleClick={false}
      minZoom={MIN_ZOOM}
      maxZoom={MAX_ZOOM}
      deleteKeyCode={null}
      selectionKeyCode={null}
      multiSelectionKeyCode={null}
      onInit={() => fitTop()}
      onNodeClick={(_, node) => {
        const key =
          node.type === "trigger"
            ? TRIGGER_KEY
            : node.type === "step"
              ? (node.data as { stepId: string }).stepId
              : null;
        if (key === null) return;
        select(key);
        onStepClick?.(key);
      }}
      onPaneClick={() => {
        select(null);
        rootRef.current?.focus({ preventScroll: true });
      }}
      onMoveStart={(event) => {
        if (event) ui.getState().closePicker();
      }}
    >
      <Background variant={BackgroundVariant.Dots} gap={20} size={1.25} color="var(--fk-dot)" />
      <Controls onFit={() => fitTop(200, true)} />
    </ReactFlow>
  );
}

/**
 * The workflow canvas: the tree of step cards with "+" buttons on every edge, a searchable step
 * picker, right-click and "…" menus, keyboard navigation in tree order and undoable shortcuts.
 * Cards are fixed-size and laid out deterministically; positions animate on change.
 *
 * Works on its own (it provides the editor store to everything inside) or under a
 * `<FlowkitProvider>`, whose theme and icons it uses.
 *
 * @example
 * const store = createEditorStore({ doc, manifest });
 * <div style={{ height: 600 }}><WorkflowCanvas store={store} onStepClick={openPanel} /></div>
 */
export function WorkflowCanvas(props: {
  store: EditorStore;
  /** Hides "+" buttons and menus and disables editing shortcuts. */
  readOnly?: boolean;
  /** Run state to paint on the cards (run viewer). */
  overlay?: RunOverlay;
  /** Called when a step (or `"__trigger"`) is clicked or opened with Enter. */
  onStepClick?(id: string): void;
}): JSX.Element {
  const { store, readOnly = false, overlay, onStepClick } = props;
  const { theme } = useFlowkitAppearance();
  const [ui] = useState(() => createCanvasUiStore({ readOnly, overlay }));
  const rootRef = useRef<HTMLDivElement>(null);
  const layoutRef = useRef<ReturnType<typeof layoutTree> | null>(null);
  const [portal, setPortal] = useState<HTMLDivElement | null>(null);
  const getRoot = useCallback(() => rootRef.current, []);
  const colorMode = theme.colorMode ?? "system";

  useEffect(() => {
    ui.setState(
      readOnly ? { readOnly, overlay, picker: null, renaming: null } : { readOnly, overlay },
    );
  }, [ui, readOnly, overlay]);

  useEffect(() => {
    store.getState().hydrateLocal();
  }, [store]);

  const style = useMemo(() => themeStyle(theme.tokens), [theme.tokens]);

  return (
    <EditorContext.Provider value={store}>
      <CanvasUiContext.Provider value={ui}>
        <RootElementContext.Provider value={getRoot}>
          <PortalContainerContext.Provider value={portal}>
            <Tooltip.Provider delayDuration={300} skipDelayDuration={100}>
              {/* biome-ignore lint/a11y/noStaticElementInteractions: keyboard shortcuts for the canvas region; its nodes and buttons are the focusable controls. */}
              <div
                ref={rootRef}
                className="fk-root fk-canvas"
                data-fk-theme={colorMode}
                data-readonly={readOnly || undefined}
                style={style}
                tabIndex={-1}
                onKeyDown={(e) => {
                  const handled = handleCanvasKey(e, {
                    store,
                    ui,
                    root: getRoot,
                    layout: () => layoutRef.current ?? { nodes: [], edges: [] },
                    ...(onStepClick ? { onStepClick } : {}),
                  });
                  if (handled) e.preventDefault();
                }}
              >
                <ReactFlowProvider>
                  <CanvasFlow
                    layoutRef={layoutRef}
                    rootRef={rootRef}
                    readOnly={readOnly}
                    colorMode={colorMode}
                    {...(onStepClick ? { onStepClick } : {})}
                  />
                </ReactFlowProvider>
                <StepPicker />
                <Toasts />
                <div ref={setPortal} className="fk-portal" />
              </div>
            </Tooltip.Provider>
          </PortalContainerContext.Provider>
        </RootElementContext.Provider>
      </CanvasUiContext.Provider>
    </EditorContext.Provider>
  );
}
