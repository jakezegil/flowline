/**
 * The range toolbar: a bar over the canvas while a run of steps is selected, with the range's
 * actions. The range's right-click menu offers the same items (see {@link rangeItems}).
 *
 * @module
 */

import { Panel } from "@xyflow/react";
import {
  ArrowDown,
  ArrowUp,
  Copy,
  CopyPlus,
  Group,
  type LucideIcon,
  Trash2,
  X,
} from "lucide-react";
import { type KeyboardEvent, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useEditorStore, useEditorStoreApi } from "../hooks";
import type { FlowlineLabels } from "../labels";
import { type RangeActions, rangeActions, rangeIds } from "./actions";
import { RootElementContext, useCanvasUiApi, useLabels } from "./canvas-context";
import { isMac } from "./keyboard";

/** One action on a range, as a toolbar button and a menu item. */
export interface RangeItem {
  id: "group" | "duplicate" | "copy" | "moveUp" | "moveDown" | "remove" | "clear";
  icon: LucideIcon;
  label: string;
  /** The shortcut shown next to it. */
  kbd?: string;
  run(): void;
  danger?: boolean;
}

/**
 * The items of a range, in toolbar order. A read-only canvas gets only Copy and Clear.
 */
export function rangeItems(
  labels: FlowlineLabels,
  actions: RangeActions,
  readOnly: boolean,
): RangeItem[] {
  const mac = isMac();
  const m = mac ? "⌘" : "Ctrl+";
  const alt = mac ? "⌥" : "Alt+";
  const all: RangeItem[] = [
    { id: "group", icon: Group, label: labels.groupIntoSection, kbd: `${m}G`, run: actions.group },
    {
      id: "duplicate",
      icon: CopyPlus,
      label: labels.duplicate,
      kbd: `${m}D`,
      run: actions.duplicate,
    },
    { id: "copy", icon: Copy, label: labels.copy, kbd: `${m}C`, run: actions.copy },
    { id: "moveUp", icon: ArrowUp, label: labels.moveUp, kbd: `${alt}↑`, run: actions.moveUp },
    {
      id: "moveDown",
      icon: ArrowDown,
      label: labels.moveDown,
      kbd: `${alt}↓`,
      run: actions.moveDown,
    },
    { id: "remove", icon: Trash2, label: labels.delete, run: actions.remove, danger: true },
    { id: "clear", icon: X, label: labels.clearRange, kbd: "Esc", run: actions.clear },
  ];
  return readOnly ? all.filter((i) => i.id === "copy" || i.id === "clear") : all;
}

/** Keys of the toolbar that move between its buttons: ←/→ (wrapping), Home and End. */
const ROVE_KEYS = new Set(["ArrowLeft", "ArrowRight", "Home", "End"]);

/**
 * Announces range changes to screen readers through the toast region's live region:
 * `rangeSelected(n)` when the count changes, `rangeCleared` when the range goes away.
 */
export function RangeAnnouncer(): null {
  const ui = useCanvasUiApi();
  const labels = useLabels();
  const count = useEditorStore((s) => rangeIds(s.doc, s.range).size);
  const prev = useRef(count);
  useEffect(() => {
    if (count === prev.current) return;
    const was = prev.current;
    prev.current = count;
    if (count > 0) ui.getState().announce(labels.rangeSelected(count));
    else if (was > 0) ui.getState().announce(labels.rangeCleared);
  }, [count, ui, labels]);
  return null;
}

/**
 * The range toolbar (top center of the canvas): the count of selected steps and the range's
 * actions. Rendered only while the store has a range. It is one tab stop: ←/→, Home and End move
 * between its buttons, and Esc clears the range.
 */
export function RangeBar() {
  const store = useEditorStoreApi();
  const ui = useCanvasUiApi();
  const root = useContext(RootElementContext);
  const labels = useLabels();
  const range = useEditorStore((s) => s.range);
  const readOnly = useEditorStore((s) => s.readOnly);
  const count = useEditorStore((s) => rangeIds(s.doc, s.range).size);
  const [current, setCurrent] = useState<RangeItem["id"] | null>(null);
  // Bound to the current range (the store's range object changes with it).
  // biome-ignore lint/correctness/useExhaustiveDependencies: rebinds when the range changes.
  const actions = useMemo(() => rangeActions(store, ui, root), [store, ui, root, range]);
  if (!actions || count === 0) return null;
  const caption = labels.rangeSelected(count);
  const items = rangeItems(labels, actions, readOnly);
  const tabStop = items.some((i) => i.id === current) ? current : items[0]?.id;
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.shiftKey || e.altKey || e.metaKey || e.ctrlKey) return;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      actions.clear();
      return;
    }
    if (!ROVE_KEYS.has(e.key)) return;
    const buttons = Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>("button"));
    const at = buttons.indexOf(e.target as HTMLButtonElement);
    if (at === -1) return;
    e.preventDefault();
    e.stopPropagation();
    const n = buttons.length;
    const next =
      e.key === "Home"
        ? 0
        : e.key === "End"
          ? n - 1
          : (at + (e.key === "ArrowLeft" ? -1 : 1) + n) % n;
    buttons[next]?.focus();
  };
  return (
    <Panel position="top-center" className="fl-range-bar nodrag nopan">
      <div
        role="toolbar"
        aria-label={caption}
        aria-orientation="horizontal"
        className="fl-range-bar__inner"
        onKeyDown={onKeyDown}
      >
        <span className="fl-range-bar__count" aria-hidden>
          {caption}
        </span>
        {items.map((item) => {
          const Icon = item.icon;
          const tip = item.kbd ? `${item.label} (${item.kbd})` : item.label;
          return (
            <button
              key={item.id}
              type="button"
              className="fl-range-bar__button"
              data-action={item.id}
              data-danger={item.danger || undefined}
              aria-label={item.label}
              title={tip}
              tabIndex={item.id === tabStop ? 0 : -1}
              onFocus={() => setCurrent(item.id)}
              onClick={item.run}
            >
              <Icon size={14} aria-hidden />
              {item.id === "group" && <span className="fl-range-bar__label">{item.label}</span>}
            </button>
          );
        })}
      </div>
    </Panel>
  );
}
