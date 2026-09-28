import { findStep, type Manifest, type NodeManifest } from "@flowkit/core";
import * as Popover from "@radix-ui/react-popover";
import { Command } from "cmdk";
import { Search } from "lucide-react";
import { type KeyboardEvent, useContext, useEffect, useId, useMemo, useRef, useState } from "react";
import { useEditorStore, useEditorStoreApi } from "../hooks";
import { defaultLabels, type FlowkitLabels } from "../labels";
import { useFlowkitAppearance } from "../provider";
import { focusNode } from "./actions";
import {
  PortalContainerContext,
  RootElementContext,
  useCanvasUi,
  useLabels,
} from "./canvas-context";

/** Plugin ID of Flowkit's built-in nodes, listed under "Logic". */
const CORE_PLUGIN = "core";

interface PickerTab {
  id: string;
  label: string;
}

/** A section of picker items with an optional heading. */
interface PickerGroup {
  heading?: string;
  nodes: NodeManifest[];
}

/** Tabs: "All", "Logic" (built-in nodes), then one per other plugin that has nodes. */
export function pickerTabs(
  manifest: Manifest,
  labels: Pick<FlowkitLabels, "tabAll" | "tabLogic"> = defaultLabels,
): PickerTab[] {
  const withNodes = new Set(manifest.nodes.map((n) => n.plugin));
  const tabs: PickerTab[] = [{ id: "all", label: labels.tabAll }];
  if (withNodes.has(CORE_PLUGIN)) tabs.push({ id: CORE_PLUGIN, label: labels.tabLogic });
  for (const p of manifest.plugins) {
    if (p.id !== CORE_PLUGIN && withNodes.has(p.id)) tabs.push({ id: p.id, label: p.name });
  }
  return tabs;
}

/**
 * The picker's sections for `tab`: in "All", one per plugin (built-ins first); in a plugin tab,
 * one per node category (uncategorized nodes first, without a heading).
 */
export function pickerGroups(
  manifest: Manifest,
  tab: string,
  exclude?: string,
  labels: Pick<FlowkitLabels, "tabAll" | "tabLogic"> = defaultLabels,
): PickerGroup[] {
  const nodes = manifest.nodes.filter((n) => n.type !== exclude);
  if (tab === "all") {
    const tabs = pickerTabs(manifest, labels).slice(1);
    return tabs
      .map((t) => ({ heading: t.label, nodes: nodes.filter((n) => n.plugin === t.id) }))
      .filter((g) => g.nodes.length > 0);
  }
  const groups = new Map<string, NodeManifest[]>();
  for (const n of nodes) {
    if (n.plugin !== tab) continue;
    const key = n.category ?? "";
    groups.set(key, [...(groups.get(key) ?? []), n]);
  }
  return [...groups].map(([heading, list]) => ({ ...(heading ? { heading } : {}), nodes: list }));
}

/** A zero-size rectangle at the top center of `el` (fallback anchor when there's no target). */
function topCenterOf(el: HTMLElement | null): DOMRect {
  const r = el?.getBoundingClientRect();
  if (!r) return new DOMRect(0, 0, 0, 0);
  return new DOMRect(r.left + r.width / 2, r.top + 56, 0, 0);
}

/**
 * The step picker: one searchable, categorized list used to add, insert and replace steps.
 * Opened by "+" buttons, empty-branch placeholders, "Replace…" and ⌘K; anchored to whatever
 * opened it. Enter (or a click) picks the highlighted step.
 */
export function StepPicker() {
  const picker = useCanvasUi((s) => s.picker);
  const closePicker = useCanvasUi((s) => s.closePicker);
  const store = useEditorStoreApi();
  const manifest = useEditorStore((s) => s.manifest);
  const container = useContext(PortalContainerContext);
  const root = useContext(RootElementContext);
  const { resolveIcon } = useFlowkitAppearance();
  const labels = useLabels();
  const idBase = useId();
  const tabId = (id: string) => `${idBase}-tab-${id}`;
  const panelId = `${idBase}-panel`;
  const tabRefs = useRef(new Map<string, HTMLButtonElement>());
  const [tab, setTab] = useState("all");
  const [query, setQuery] = useState("");

  const request = picker?.request;
  const replacing = request?.mode === "replace" ? request.stepId : undefined;
  const currentType = useEditorStore((s) =>
    replacing ? findStep(s.doc, replacing)?.step.type : undefined,
  );

  // Every opening starts fresh.
  const picked = useRef(false);
  const interactedOutside = useRef(false);
  const lastAnchor = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (picker) {
      setTab("all");
      setQuery("");
      picked.current = false;
      interactedOutside.current = false;
      lastAnchor.current = picker.anchor;
    }
  }, [picker]);

  // Dismissing with Esc returns focus to whatever opened the picker (after a pick, the new
  // step is focused; after a click elsewhere, focus stays where the click put it).
  const restoreFocus = () => {
    if (picked.current || interactedOutside.current) return;
    const el = lastAnchor.current;
    if (el?.isConnected) {
      el.focus({ preventScroll: true });
      return;
    }
    const selection = store.getState().selection;
    if (selection !== null) focusNode(root(), selection);
    else root()?.focus({ preventScroll: true });
  };

  const anchor = useRef({
    getBoundingClientRect: () => topCenterOf(root()),
  });
  anchor.current.getBoundingClientRect = () =>
    picker?.anchor?.isConnected ? picker.anchor.getBoundingClientRect() : topCenterOf(root());

  const tabs = useMemo(() => pickerTabs(manifest, labels), [manifest, labels]);
  const groups = useMemo(
    () => pickerGroups(manifest, tab, currentType, labels),
    [manifest, tab, currentType, labels],
  );
  const pluginName = useMemo(
    () => new Map(manifest.plugins.map((p) => [p.id, p.name])),
    [manifest],
  );

  const pick = (type: string) => {
    if (!request) return;
    let focus: string | undefined;
    if (request.mode === "insert") focus = store.getState().insertStep(request.loc, type);
    else {
      store.getState().replaceStep(request.stepId, type);
      focus = request.stepId;
    }
    picked.current = true;
    closePicker();
    focusNode(root(), focus);
  };

  /** The tab `delta` steps from the current one (wrapping), for arrow keys. */
  const tabBy = (delta: number) => {
    const i = tabs.findIndex((t) => t.id === tab);
    return tabs[(i + delta + tabs.length) % tabs.length];
  };

  const onInputKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (query !== "" || (e.key !== "ArrowLeft" && e.key !== "ArrowRight")) return;
    e.preventDefault();
    const next = tabBy(e.key === "ArrowRight" ? 1 : -1);
    if (next) setTab(next.id);
  };

  // Roving focus within the tab list: arrows (and Home/End) move focus and select.
  const onTabKey = (e: KeyboardEvent<HTMLDivElement>) => {
    let next: PickerTab | undefined;
    if (e.key === "ArrowRight") next = tabBy(1);
    else if (e.key === "ArrowLeft") next = tabBy(-1);
    else if (e.key === "Home") next = tabs[0];
    else if (e.key === "End") next = tabs[tabs.length - 1];
    if (!next) return;
    e.preventDefault();
    e.stopPropagation();
    setTab(next.id);
    tabRefs.current.get(next.id)?.focus();
  };

  const title = replacing ? labels.replaceStep : labels.addStep;

  return (
    <Popover.Root open={picker !== null} onOpenChange={(open) => !open && closePicker()}>
      <Popover.Anchor virtualRef={anchor} />
      <Popover.Portal container={container}>
        <Popover.Content
          className="fk-picker"
          side="bottom"
          align="center"
          sideOffset={8}
          collisionPadding={12}
          aria-label={title}
          onInteractOutside={() => {
            interactedOutside.current = true;
          }}
          onCloseAutoFocus={(e) => {
            e.preventDefault();
            restoreFocus();
          }}
        >
          <Command label={title} loop>
            <div className="fk-picker__search">
              <Search size={14} aria-hidden />
              <Command.Input
                autoFocus
                value={query}
                onValueChange={setQuery}
                onKeyDown={onInputKey}
                placeholder={replacing ? labels.replaceWith : labels.searchSteps}
              />
            </div>
            <div
              className="fk-picker__tabs"
              role="tablist"
              aria-label={labels.stepCategories}
              onKeyDown={onTabKey}
            >
              {tabs.map((t) => (
                <button
                  key={t.id}
                  ref={(el) => {
                    if (el) tabRefs.current.set(t.id, el);
                    else tabRefs.current.delete(t.id);
                  }}
                  id={tabId(t.id)}
                  type="button"
                  role="tab"
                  aria-selected={t.id === tab}
                  aria-controls={panelId}
                  tabIndex={t.id === tab ? 0 : -1}
                  className="fk-picker__tab"
                  onClick={() => setTab(t.id)}
                >
                  {t.label}
                </button>
              ))}
            </div>
            <div role="tabpanel" id={panelId} aria-labelledby={tabId(tab)}>
              <Command.List className="fk-picker__list">
                <Command.Empty className="fk-picker__empty">
                  {labels.noMatches(query)}
                </Command.Empty>
                {groups.map((g) => (
                  <Command.Group
                    key={g.heading ?? ""}
                    heading={g.heading}
                    className="fk-picker__group"
                  >
                    {g.nodes.map((n) => {
                      const Icon = resolveIcon(n.icon);
                      return (
                        <Command.Item
                          key={n.type}
                          value={n.type}
                          keywords={[
                            n.name,
                            n.description ?? "",
                            n.category ?? "",
                            pluginName.get(n.plugin) ?? "",
                          ]}
                          onSelect={() => pick(n.type)}
                          className="fk-picker__item"
                        >
                          <span
                            className="fk-picker__icon"
                            data-tone={n.branches.kind === "none" ? "action" : "control"}
                            aria-hidden
                          >
                            <Icon size={16} />
                          </span>
                          <span className="fk-picker__text">
                            <span className="fk-picker__name">{n.name}</span>
                            {n.description && (
                              <span className="fk-picker__desc">{n.description}</span>
                            )}
                          </span>
                        </Command.Item>
                      );
                    })}
                  </Command.Group>
                ))}
              </Command.List>
            </div>
          </Command>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
