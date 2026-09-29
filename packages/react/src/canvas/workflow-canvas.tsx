import { branchesFor, type Manifest, type WorkflowDoc } from "@flowlinejs/core";
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
import {
  type JSX,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useStore } from "zustand";
import { EditorContext, stepIndex, useEditorStore } from "../hooks";
import type { FlowlineLabels } from "../labels";
import { LOOP_GUTTER, SECTION_HEADER_H, SECTION_PAD } from "../layout/constants";
import {
  type LayoutEdge,
  type LayoutNode,
  type LayoutNote,
  type LayoutSection,
  layoutTree,
} from "../layout/layout-tree";
import { useFlowlineAppearance } from "../provider";
import { type EditorStore, holdReadOnly, TRIGGER_KEY } from "../store/editor-store";
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
import { fitViewport, motionDuration, revealViewport } from "./fit";
import { settleFlash } from "./flash";
import { type CanvasRect, edgeGeometries } from "./geometry";
import { handleCanvasKey } from "./keyboard";
import { NoteCard } from "./note-node";
import { EndNode, RejoinNode } from "./rejoin-node";
import { excerpt, SectionHeader, SectionRegion, sectionOfNode, sectionTitle } from "./section-node";
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
  section: SectionRegion,
  sectionHeader: SectionHeader,
  note: NoteCard,
};

/** A selected card closer than this (px) to the pane's edge is panned back into view. */
const PAN_MARGIN = 24;
const MIN_ZOOM = 0.25;
const MAX_ZOOM = 1.5;

const EMPTY_DATA = {};

function ariaLabels(labels: FlowlineLabels, readOnly: boolean): Partial<AriaLabelConfig> {
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

/** Top offset of a section's header chip in its region, and the chip's height. */
const CHIP_TOP = 6;
const CHIP_H = 22;
/** Room the chip leaves before the edge entering the section (which runs down its header band). */
const CHIP_EDGE_GAP = 8;
/** Characters of a sticky note in its accessible name (the full text stays in its `title`). */
const NOTE_NAME_MAX = 140;

/**
 * The xyflow nodes of a section: its region (below the edges, inert) and its header chip (a
 * node of its own at the region's top-left, focusable on a read-only canvas, where the chip is
 * not a button). `edgeX` is the x of the edge entering the section (its first member's centre):
 * the chip ends {@link CHIP_EDGE_GAP} short of it, so it never covers that line.
 */
function sectionNodes(
  ls: LayoutSection,
  readOnly: boolean,
  headerLabel: string,
  edgeX: number | undefined,
): [Node, Node] {
  const data = { sectionId: ls.sectionId, color: ls.color };
  const common = { draggable: false, connectable: false, deletable: false, selectable: false };
  const suffix = ls.id.slice("section:".length);
  const left = ls.x + SECTION_PAD;
  const right = Math.min(
    ls.x + ls.w - SECTION_PAD,
    edgeX === undefined ? Number.POSITIVE_INFINITY : edgeX - CHIP_EDGE_GAP,
  );
  return [
    {
      ...common,
      id: ls.id,
      type: "section",
      position: { x: ls.x, y: ls.y },
      width: ls.w,
      height: ls.h,
      data,
      focusable: false,
      // Behind the cards and the edges. Nested regions come later (see below), so they draw over
      // their parents'.
      zIndex: -1,
      style: { pointerEvents: "none" },
    },
    {
      ...common,
      id: `sectionHeader:${suffix}`,
      type: "sectionHeader",
      position: { x: left, y: ls.y + CHIP_TOP },
      width: Math.max(0, right - left),
      height: Math.min(CHIP_H, SECTION_HEADER_H - CHIP_TOP),
      data,
      focusable: readOnly,
      style: { pointerEvents: "none" },
      ...(readOnly ? { ariaLabel: headerLabel } : {}),
    },
  ];
}

/** The xyflow node of a step's note. */
function noteNode(ln: LayoutNote, ariaLabel: string): Node {
  return {
    id: ln.id,
    type: "note",
    position: { x: ln.x, y: ln.y },
    width: ln.w,
    height: ln.h,
    data: { stepId: ln.stepId },
    draggable: false,
    connectable: false,
    deletable: false,
    selectable: false,
    focusable: true,
    ariaLabel,
  };
}

/** A region's rectangle, for routing edges around it. */
const rectOf = (ls: LayoutSection): CanvasRect => ({ x: ls.x, y: ls.y, w: ls.w, h: ls.h });

function sameNode(a: Node, b: Node): boolean {
  return (
    a.type === b.type &&
    a.zIndex === b.zIndex &&
    a.focusable === b.focusable &&
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
  sections: LayoutSection[],
  eachItem: string,
): Edge<FlowEdgeData>[] {
  const geometry = edgeGeometries(nodes, edges, LOOP_GUTTER, sections.map(rectOf));
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
    <Panel position="bottom-left" className="fl-controls" aria-label={labels.controls}>
      <button
        type="button"
        aria-label={labels.zoomOut}
        title={labels.zoomOut}
        onClick={() => rf.zoomOut({ duration: motionDuration(150) })}
      >
        <Minus size={14} aria-hidden />
      </button>
      <button
        type="button"
        aria-label={labels.zoomIn}
        title={labels.zoomIn}
        onClick={() => rf.zoomIn({ duration: motionDuration(150) })}
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
  colorMode: "light" | "dark" | "system";
  onStepClick?(id: string): void;
}

function CanvasFlow({ layoutRef, rootRef, colorMode, onStepClick }: FlowProps) {
  const readOnly = useEditorStore((s) => s.readOnly);
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
      const shown = step.disabled ? labels.disabledNode(name) : name;
      return typeof step.note === "string" && step.note !== ""
        ? labels.stepWithNote(shown, step.note)
        : shown;
    },
    [doc, manifest, labels],
  );
  const rawNodes = useMemo(() => {
    // Regions first (they sit behind everything). Each header chip comes right before its
    // section's first card and each note right after its card, so Tab walks them in reading order.
    const out: Node[] = [];
    const chips = new Map<string, Node[]>();
    const regions = [...layout.sections].sort((a, b) => a.depth - b.depth);
    const byId = new Map(layout.nodes.map((n) => [n.id, n]));
    for (const ls of regions) {
      const section = sectionOfNode(doc.sections, ls.id, ls.sectionId);
      const note =
        typeof section?.note === "string" && section.note !== "" ? section.note : undefined;
      const firstCard = byId.get(`step:${section?.first ?? ""}`);
      const [region, chip] = sectionNodes(
        ls,
        readOnly,
        labels.sectionHeader(sectionTitle(section, labels.untitledSection), note),
        firstCard ? firstCard.x + firstCard.w / 2 : undefined,
      );
      out.push(region);
      const first = `step:${section?.first ?? ""}`;
      chips.set(first, [...(chips.get(first) ?? []), chip]);
    }
    const notes = new Map(layout.notes.map((n) => [`step:${n.stepId}`, n]));
    const steps = stepIndex(doc);
    for (const ln of layout.nodes) {
      out.push(...(chips.get(ln.id) ?? []));
      out.push(toFlowNode(ln, selection, label));
      const note = notes.get(ln.id);
      const text = note ? steps.get(note.stepId)?.note : undefined;
      if (note && text) out.push(noteNode(note, labels.noteLabel(excerpt(text, NOTE_NAME_MAX))));
    }
    return out;
  }, [layout, selection, label, doc, readOnly, labels]);
  const nodes = useStable(rawNodes, sameNode);
  const rawEdges = useMemo(
    () => toFlowEdges(doc, manifest, layout.nodes, layout.edges, layout.sections, labels.eachItem),
    [doc, manifest, layout, labels.eachItem],
  );
  const edges = useStable(rawEdges, sameEdge);

  /**
   * Fits the workflow, anchored to the top. The initial fit only zooms out to a readable zoom
   * (a tall or wide workflow then pans); `whole` (the "Fit" button) fits as much as stays legible.
   */
  const fitTop = useCallback(
    (duration = 0, whole = false) => {
      const { width: W, height: H } = flowStore.getState();
      const l = layoutRef.current;
      if (!l || W === 0 || H === 0) return;
      rf.setViewport(fitViewport({ width: W, height: H }, l, { whole, minZoom: MIN_ZOOM }), {
        duration: motionDuration(duration),
      });
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
   * Pans the selected card on screen with the smallest move, bringing a block's branch heads
   * along when they fit (so a side panel opening doesn't hide the card or its paths). `focus` (a
   * selection made before the first fit, e.g. a run opening on its failed step) instead centers
   * it at a readable zoom of at least 1.
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
      const heads = l.edges
        .filter((e) => e.kind === "branch" && e.source === id)
        .flatMap((e) => l.nodes.find((n) => n.id === e.target) ?? []);
      const pane = { width: W, height: H };
      const current = transform[2];
      if (focus) {
        if (current < 1 || revealViewport(pane, transform, node, [], PAN_MARGIN)) {
          const zoom = Math.max(current, 1);
          rf.setCenter(node.x + node.w / 2, node.y + node.h / 2, {
            zoom,
            duration: motionDuration(duration),
          });
        }
        return;
      }
      const next = revealViewport(pane, transform, node, heads, PAN_MARGIN);
      if (next) rf.setViewport(next, { duration: motionDuration(duration) });
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
      attributionPosition="bottom-left"
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
      <Background variant={BackgroundVariant.Dots} gap={20} size={1.25} color="var(--fl-dot)" />
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
 * `<FlowlineProvider>`, whose theme and icons it uses.
 *
 * @example
 * const store = createEditorStore({ doc, manifest });
 * <div style={{ height: 600 }}><WorkflowCanvas store={store} onStepClick={openPanel} /></div>
 */
export function WorkflowCanvas(props: {
  store: EditorStore;
  /**
   * Hides "+" buttons and menus and disables editing shortcuts. Sets the store's `readOnly` flag
   * while mounted (restoring the previous value on unmount), so every edit through the store,
   * an agent bridge's included, is rejected too. A store that is already read-only renders
   * read-only without it.
   */
  readOnly?: boolean;
  /** Run state to paint on the cards (run viewer). */
  overlay?: RunOverlay;
  /** Called when a step (or `"__trigger"`) is clicked or opened with Enter. */
  onStepClick?(id: string): void;
}): JSX.Element {
  const { store, readOnly: readOnlyProp = false, overlay, onStepClick } = props;
  const { theme, labels, onNotify } = useFlowlineAppearance();
  const [ui] = useState(() =>
    createCanvasUiStore({ overlay, labels, ...(onNotify ? { notify: onNotify } : {}) }),
  );
  // A flash set before this canvas mounted is old news: don't play it.
  useState(() => settleFlash(store));
  const readOnly = useStore(store, (s) => s.readOnly);
  const rootRef = useRef<HTMLDivElement>(null);
  const layoutRef = useRef<ReturnType<typeof layoutTree> | null>(null);
  const [portal, setPortal] = useState<HTMLDivElement | null>(null);
  const getRoot = useCallback(() => rootRef.current, []);
  const colorMode = theme.colorMode ?? "system";

  // Before paint, so a read-only canvas never shows a frame of edit controls. Holds stack, so
  // two read-only canvases on one store (or a host's own setReadOnly) don't undo each other.
  useLayoutEffect(() => (readOnlyProp ? holdReadOnly(store) : undefined), [store, readOnlyProp]);
  useEffect(() => {
    ui.setState(readOnly ? { overlay, picker: null, renaming: null } : { overlay });
  }, [ui, readOnly, overlay]);
  useEffect(() => {
    if (ui.getState().labels !== labels) ui.setState({ labels });
  }, [ui, labels]);
  useEffect(() => {
    if (ui.getState().notify !== onNotify) ui.setState({ notify: onNotify });
  }, [ui, onNotify]);

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
                className="fl-root fl-canvas"
                data-fl-theme={colorMode}
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
                    colorMode={colorMode}
                    {...(onStepClick ? { onStepClick } : {})}
                  />
                </ReactFlowProvider>
                <StepPicker />
                <Toasts />
                <div ref={setPortal} className="fl-portal" />
              </div>
            </Tooltip.Provider>
          </PortalContainerContext.Provider>
        </RootElementContext.Provider>
      </CanvasUiContext.Provider>
    </EditorContext.Provider>
  );
}
