import { findStep, type Manifest, type NodeManifest } from "@flowline/core";
import * as Popover from "@radix-ui/react-popover";
import { Command } from "cmdk";
import { Search } from "lucide-react";
import { type KeyboardEvent, useContext, useEffect, useId, useMemo, useRef, useState } from "react";
import { useEditorStore, useEditorStoreApi } from "../hooks";
import { defaultLabels, type FlowlineLabels } from "../labels";
import { useFlowlineAppearance } from "../provider";
import { focusNode, nodeElement, nodeIdOf } from "./actions";
import {
  type PickerRequest,
  PortalContainerContext,
  RootElementContext,
  useCanvasUi,
  useLabels,
} from "./canvas-context";

/** Plugin ID of Flowline's built-in nodes, listed under "Logic". */
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
  labels: Pick<FlowlineLabels, "tabAll" | "tabLogic"> = defaultLabels,
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
  labels: Pick<FlowlineLabels, "tabAll" | "tabLogic"> = defaultLabels,
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

/** Lower-case words of a text, split at spaces, punctuation and camelCase (`crm.sendEmail`). */
function wordsOf(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/**
 * How well a node matches a picker search: higher is better, `0` for no match. Every query word
 * must start a word of the node's name, keywords, category, plugin name or type (or, from three
 * letters, occur inside the name). The name counts most: an exact name wins, then a name that
 * starts with the query, then one containing it as words; keywords and the category come next,
 * the plugin and type last. A word of four letters or more one typo away from a name or keyword
 * word (or its start) still matches, below any exact match. Descriptions aren't searched (their
 * many words match almost anything).
 */
/**
 * Whether `a` and `b` are at most one typo apart: one letter added, dropped, changed, or two
 * neighbours swapped ("emial" and "email").
 */
function oneTypo(a: string, b: string): boolean {
  if (a === b) return true;
  const la = a.length;
  const lb = b.length;
  if (Math.abs(la - lb) > 1) return false;
  let i = 0;
  while (i < la && i < lb && a[i] === b[i]) i++;
  if (la === lb) {
    // Changed letter, or swapped neighbours.
    if (a.slice(i + 1) === b.slice(i + 1)) return true;
    return a[i] === b[i + 1] && a[i + 1] === b[i] && a.slice(i + 2) === b.slice(i + 2);
  }
  // Added or dropped letter.
  return la > lb ? a.slice(i + 1) === b.slice(i) : a.slice(i) === b.slice(i + 1);
}

/** Whether token `t` (four letters or more) is one typo from a word of `words` or its start. */
function nearly(t: string, words: readonly string[]): boolean {
  if (t.length < 4) return false;
  return words.some(
    (w) =>
      oneTypo(t, w) ||
      oneTypo(t, w.slice(0, t.length)) ||
      (w.length > t.length && oneTypo(t, w.slice(0, t.length + 1))),
  );
}

export function stepMatchScore(node: NodeManifest, query: string, pluginName = ""): number {
  const q = query.trim().toLowerCase().replace(/\s+/g, " ");
  if (q === "") return 1;
  const name = node.name.toLowerCase();
  const nameWords = wordsOf(node.name);
  const keywordWords = [...(node.keywords ?? []), node.category ?? ""].flatMap(wordsOf);
  const otherWords = [...wordsOf(pluginName), ...wordsOf(node.type)];
  let score = 0;
  for (const t of wordsOf(q)) {
    if (nameWords.includes(t)) score += 30;
    else if (nameWords.some((w) => w.startsWith(t))) score += 20;
    else if (t.length >= 3 && name.includes(t)) score += 10;
    else if (keywordWords.some((w) => w.startsWith(t))) score += 8;
    else if (otherWords.some((w) => w.startsWith(t))) score += 3;
    // Typo tolerance, below every exact match: "emial" still finds Send email.
    else if (nearly(t, nameWords)) score += 5;
    else if (nearly(t, keywordWords)) score += 2;
    else return 0;
  }
  if (score === 0) return 0;
  if (name === q) score += 1000;
  else if (name.startsWith(q)) score += 500;
  else if (` ${name}`.includes(` ${q}`)) score += 200;
  // The query names the category or a keyword (or is one typo from one).
  const names = (k: string) => k.startsWith(q) || nearly(q, [k]);
  if (node.category && names(node.category.toLowerCase())) score += 40;
  if ((node.keywords ?? []).some((k) => names(k.toLowerCase()))) score += 40;
  return score;
}

/** The nodes of `groups` matching `query`, best first (ties keep their order). */
export function rankSteps(
  groups: PickerGroup[],
  query: string,
  pluginName: (plugin: string) => string = () => "",
): NodeManifest[] {
  return groups
    .flatMap((g) => g.nodes)
    .map((node, i) => ({ node, i, score: stepMatchScore(node, query, pluginName(node.plugin)) }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .map((r) => r.node);
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
  const { resolveIcon } = useFlowlineAppearance();
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
  const lastRequest = useRef<PickerRequest | undefined>(undefined);
  useEffect(() => {
    if (picker) {
      lastRequest.current = picker.request;
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
    // The opener was re-rendered away: its replacement (the "+" at the same spot, or the card
    // being replaced), else the selected card.
    const req = lastRequest.current;
    const again =
      req?.mode === "insert"
        ? root()?.querySelector<HTMLElement>(
            `.fl-add[data-insert-at="${req.loc.parentId ?? ""}/${req.loc.branch ?? ""}/${req.loc.index}"]`,
          )
        : req?.mode === "replace"
          ? nodeElement(root(), nodeIdOf(req.stepId))
          : null;
    if (again) {
      again.focus({ preventScroll: true });
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
  // Searching lists the matches best first, across the tab's sections.
  const searching = query.trim() !== "";
  const shown = useMemo<PickerGroup[]>(
    () =>
      searching ? [{ nodes: rankSteps(groups, query, (id) => pluginName.get(id) ?? "") }] : groups,
    [searching, groups, query, pluginName],
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
          className="fl-picker"
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
          <Command label={labels.searchSteps} loop shouldFilter={false}>
            <div className="fl-picker__search">
              <Search size={14} aria-hidden />
              <Command.Input
                autoFocus
                aria-label={labels.searchSteps}
                value={query}
                onValueChange={setQuery}
                onKeyDown={onInputKey}
                placeholder={replacing ? labels.replaceWith : labels.searchSteps}
              />
            </div>
            <div
              className="fl-picker__tabs"
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
                  className="fl-picker__tab"
                  onClick={() => setTab(t.id)}
                >
                  {t.label}
                </button>
              ))}
            </div>
            <div role="tabpanel" id={panelId} aria-labelledby={tabId(tab)}>
              <Command.List className="fl-picker__list">
                <Command.Empty className="fl-picker__empty">
                  {labels.noMatches(query)}
                </Command.Empty>
                {shown.map((g) => (
                  <Command.Group
                    key={g.heading ?? ""}
                    heading={g.heading}
                    className="fl-picker__group"
                  >
                    {g.nodes.map((n) => {
                      const Icon = resolveIcon(n.icon);
                      return (
                        <Command.Item
                          key={n.type}
                          value={n.type}
                          onSelect={() => pick(n.type)}
                          className="fl-picker__item"
                        >
                          <span
                            className="fl-picker__icon"
                            data-tone={n.branches.kind === "none" ? "action" : "control"}
                            aria-hidden
                          >
                            <Icon size={16} />
                          </span>
                          <span className="fl-picker__text">
                            <span className="fl-picker__name">{n.name}</span>
                            {n.description && (
                              <span className="fl-picker__desc">{n.description}</span>
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
