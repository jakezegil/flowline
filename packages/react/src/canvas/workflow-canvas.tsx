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
  useStore as useFlowStore,
  useReactFlow,
  useStoreApi,
} from "@xyflow/react";
import { Maximize, Minus, Plus } from "lucide-react";
import { type JSX, type RefObject, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { EditorContext, stepIndex, useEditorStore } from "../hooks";
import type { FlowkitLabels } from "../labels";
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
  useLabels,
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

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/** Top padding (and side padding, space permitting) of the initial fit. */
const FIT_PADDING = 100;
/**
 * The initial fit never zooms out further than this: a big workflow opens readable at the top
 * (the rest is a pan away) rather than shrunk to fit.
 */
const FIT_MIN_ZOOM = 0.6;
/**
 * Width alone never asks for less than this, so on a narrow pane the fit is driven by height
 * (or the floor above), keeping the trigger readable and centered.
 */
const FIT_MIN_ZOOM_FOR_WIDTH = 0.7;
/** A selected card closer than this (px) to the pane's edge is panned back into view. */
const PAN_MARGIN = 24;
const MIN_ZOOM = 0.25;
const MAX_ZOOM = 1.5;

const EMPTY_DATA = {};

function ariaLabels(labels: FlowkitLabels, readOnly: boolean): Partial<AriaLabelConfig> {
  const help = readOnly ? labels.canvasHelpReadOnly : labels.canvasHelp;
  return {
    "node.a11yDescription.default": help,
    "node.a11yDescription.keyboardDisabled": help,
    "edge.a11yDescription.default": labels.edgeDescription,
    "controls.ariaLabel": labels.controls,
    "controls.zoomIn.ariaLabel": labels.zoomIn,
    "controls.zoomOut.ariaLabel": labels.zoomOut,
    "controls.fitView.ariaLabel": labels.fitView,
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
  eachItem: string,
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
      data.label = m?.branches.kind === "loop" && !data.leftover ? eachItem : le.label;
    } else if (le.kind === "join") {
      data.blockId = le.target.slice("join:".length);
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
  const labels = useLabels();
  return (
    <Panel position="bottom-left" className="fk-controls" aria-label={labels.controls}>
      <button
        type="button"
        aria-label={labels.zoomOut}
        title={labels.zoomOut}
        onClick={() => rf.zoomOut({ duration: 150 })}
      >
        <Minus size={14} aria-hidden />
      </button>
      <button
        type="button"
        aria-label={labels.zoomIn}
        title={labels.zoomIn}
        onClick={() => rf.zoomIn({ duration: 150 })}
      >
        <Plus size={14} aria-hidden />
      </button>
      <button type="button" aria-label={labels.fitView} title={labels.fitView} onClick={onFit}>
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
  const labels = useLabels();
  const rf = useReactFlow();
  const flowStore = useStoreApi();
  const ariaLabelConfig = useMemo(() => ariaLabels(labels, readOnly), [labels, readOnly]);

  const layout = useMemo(() => layoutTree(doc, manifest), [doc, manifest]);
  layoutRef.current = layout;

  const label = useCallback(
    (ln: LayoutNode): string | undefined => {
      if (ln.kind === "trigger") {
        const t = manifest.triggers.find((x) => x.type === doc.trigger.type);
        return labels.triggerNode(t?.name ?? doc.trigger.type);
      }
      if (ln.kind !== "step") return undefined;
      const step = stepIndex(doc).get(ln.stepId);
      if (!step) return undefined;
      const name = stepDisplayName(
        step,
        manifest.nodes.find((n) => n.type === step.type),
      );
      return step.disabled ? labels.disabledNode(name) : name;
    },
    [doc, manifest, labels],
  );
  const rawNodes = useMemo(
    () => layout.nodes.map((ln) => toFlowNode(ln, selection, label)),
    [layout, selection, label],
  );
  const nodes = useStable(rawNodes, sameNode);
  const rawEdges = useMemo(
    () => toFlowEdges(doc, manifest, layout.nodes, layout.edges, labels.eachItem),
    [doc, manifest, layout, labels.eachItem],
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
        : clamp(Math.min(Math.max(byWidth, FIT_MIN_ZOOM_FOR_WIDTH), byHeight), FIT_MIN_ZOOM, 1);
      rf.setViewport({ x: W / 2, y: padTop, zoom }, { duration });
    },
    [rf, flowStore, layoutRef],
  );

  // Keep the selection in view: when it changes (from outside too, e.g. an issues list) and when
  // the canvas is resized (e.g. a side panel opening), pan the selected card back on screen.
  const paneW = useFlowStore((s) => s.width);
  const paneH = useFlowStore((s) => s.height);
  const selectionRef = useRef(selection);
  selectionRef.current = selection;
  /**
   * Pans the selected card on screen if it isn't. `focus` (a selection made before the first
   * fit, e.g. a run opening on its failed step) centers it at a readable zoom of at least 1.
   */
  const revealSelection = useCallback(
    (duration: number, focus = false) => {
      const l = layoutRef.current;
      const sel = selectionRef.current;
      const { width: W, height: H, transform } = flowStore.getState();
      if (sel === null || !l || W === 0 || H === 0) return;
      const id = sel === TRIGGER_KEY ? "trigger" : `step:${sel}`;
      const node = l.nodes.find((n) => n.id === id);
      if (!node) return;
      const [tx, ty, current] = transform;
      const zoom = focus ? Math.max(current, 1) : current;
      const x = node.x * zoom + tx;
      const y = node.y * zoom + ty;
      const m = PAN_MARGIN;
      const inView = x >= m && y >= m && x + node.w * zoom <= W - m && y + node.h * zoom <= H - m;
      if (zoom === current && inView) return;
      rf.setCenter(node.x + node.w / 2, node.y + node.h / 2, { zoom, duration });
    },
    [rf, flowStore, layoutRef],
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-run on selection and pane size.
  useEffect(() => {
    revealSelection(250);
  }, [selection, paneW, paneH, revealSelection]);

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
      aria-label={labels.canvas}
      colorMode={colorMode}
      ariaLabelConfig={ariaLabelConfig}
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
      onInit={() => {
        fitTop();
        // A selection made before the first fit (e.g. a run opening on its failed step): show it
        // up close.
        revealSelection(0, true);
      }}
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
  const { theme, labels } = useFlowkitAppearance();
  const [ui] = useState(() => createCanvasUiStore({ readOnly, overlay, labels }));
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
    if (ui.getState().labels !== labels) ui.setState({ labels });
  }, [ui, labels]);

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
