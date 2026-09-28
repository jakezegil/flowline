import { findStep, type Manifest, type NodeManifest } from "@flowkit/core";
import * as Popover from "@radix-ui/react-popover";
import { Command } from "cmdk";
import { Search } from "lucide-react";
import { type KeyboardEvent, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useEditorStore, useEditorStoreApi } from "../hooks";
import { useFlowkitAppearance } from "../provider";
import { focusNode } from "./actions";
import { PortalContainerContext, RootElementContext, useCanvasUi } from "./canvas-context";

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
export function pickerTabs(manifest: Manifest): PickerTab[] {
  const withNodes = new Set(manifest.nodes.map((n) => n.plugin));
  const tabs: PickerTab[] = [{ id: "all", label: "All" }];
  if (withNodes.has(CORE_PLUGIN)) tabs.push({ id: CORE_PLUGIN, label: "Logic" });
  for (const p of manifest.plugins) {
    if (p.id !== CORE_PLUGIN && withNodes.has(p.id)) tabs.push({ id: p.id, label: p.name });
  }
  return tabs;
}

/**
 * The picker's sections for `tab`: in "All", one per plugin (built-ins first); in a plugin tab,
 * one per node category (uncategorized nodes first, without a heading).
 */
export function pickerGroups(manifest: Manifest, tab: string, exclude?: string): PickerGroup[] {
  const nodes = manifest.nodes.filter((n) => n.type !== exclude);
  if (tab === "all") {
    const tabs = pickerTabs(manifest).slice(1);
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
  const [tab, setTab] = useState("all");
  const [query, setQuery] = useState("");

  const request = picker?.request;
  const replacing = request?.mode === "replace" ? request.stepId : undefined;
  const currentType = useEditorStore((s) =>
    replacing ? findStep(s.doc, replacing)?.step.type : undefined,
  );

  // Every opening starts fresh.
  useEffect(() => {
    if (picker) {
      setTab("all");
      setQuery("");
    }
  }, [picker]);

  const anchor = useRef({
    getBoundingClientRect: () => topCenterOf(root()),
  });
  anchor.current.getBoundingClientRect = () =>
    picker?.anchor?.isConnected ? picker.anchor.getBoundingClientRect() : topCenterOf(root());

  const tabs = useMemo(() => pickerTabs(manifest), [manifest]);
  const groups = useMemo(
    () => pickerGroups(manifest, tab, currentType),
    [manifest, tab, currentType],
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
    closePicker();
    focusNode(root(), focus);
  };

  const onInputKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (query !== "" || (e.key !== "ArrowLeft" && e.key !== "ArrowRight")) return;
    e.preventDefault();
    const i = tabs.findIndex((t) => t.id === tab);
    const next = tabs[(i + (e.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length];
    if (next) setTab(next.id);
  };

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
          aria-label={replacing ? "Replace step" : "Add step"}
          onCloseAutoFocus={(e) => e.preventDefault()}
        >
          <Command label={replacing ? "Replace step" : "Add step"} loop>
            <div className="fk-picker__search">
              <Search size={14} aria-hidden />
              <Command.Input
                autoFocus
                value={query}
                onValueChange={setQuery}
                onKeyDown={onInputKey}
                placeholder={replacing ? "Replace with…" : "Search steps"}
              />
            </div>
            <div className="fk-picker__tabs" role="tablist" aria-label="Step categories">
              {tabs.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  role="tab"
                  aria-selected={t.id === tab}
                  className="fk-picker__tab"
                  onClick={() => setTab(t.id)}
                >
                  {t.label}
                </button>
              ))}
            </div>
            <Command.List className="fk-picker__list">
              <Command.Empty className="fk-picker__empty">No steps match “{query}”.</Command.Empty>
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
          </Command>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
