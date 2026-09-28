/**
 * The data picker: a searchable, typed tree of the values a step can reference (the trigger,
 * earlier steps, the enclosing loop), with sample values where a test produced them.
 *
 * @module
 */

import type { JSONSchema, ScopeEntry } from "@flowkit/core";
import { ChevronRight, CornerDownLeft, Plus, Search } from "lucide-react";
import {
  type CSSProperties,
  type JSX,
  type KeyboardEvent,
  type Ref,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import type { IconComponent } from "../icons";
import type { FlowkitLabels } from "../labels";
import { useFlowkitAppearance } from "../provider";
import { nodeLabel } from "./picker/ref-completion";
import {
  childNodes,
  fitsFilter,
  flattenTree,
  formatSample,
  type PickerNode,
  sectionNodes,
} from "./picker/schema-tree";

/** Why keyboard focus leaves the picker (see {@link DataPickerView}'s `onExit`). */
export type PickerExit = "escape" | "tab" | "shiftTab" | "up";

/** @internal The picker with the hooks a reference input needs to host it in a popover. */
export interface DataPickerViewProps {
  scope: ScopeEntry[];
  samples: Record<string, unknown>;
  onPick(refPath: string, typeLabel: string): void;
  filterType?: JSONSchema;
  /** Called when a key should move focus back to the input (the picker doesn't move it). */
  onExit?(reason: PickerExit): void;
  searchRef?: Ref<HTMLInputElement>;
  id?: string;
  className?: string;
}

interface Row {
  node: PickerNode;
  open: boolean;
  /** No children to show (an expanded section with nothing known). */
  empty: boolean;
  /** Can be inserted as a whole. */
  pickable: boolean;
  parent: string | null;
}

/** Search tokens all appear in the row's label or ref path. */
function matches(node: PickerNode, tokens: string[]): boolean {
  const hay = `${nodeLabel(node)} ${node.ref}`.toLowerCase();
  return tokens.every((t) => hay.includes(t));
}

function useRows(
  scope: ScopeEntry[],
  samples: Record<string, unknown>,
  expanded: ReadonlySet<string>,
  query: string,
  filterType: JSONSchema | undefined,
): Row[] {
  // Rows that fit the filter, or lead to one that does (walked once, bounded).
  const relevant = useMemo(() => {
    if (!filterType) return null;
    const keep = new Set<string>();
    const flat = flattenTree(scope, samples);
    const parents = parentMap(flat);
    for (const node of flat) {
      if (node.depth > 0 && fitsFilter(node, filterType)) {
        for (let id: string | undefined = node.id; id; id = parents.get(id)) keep.add(id);
      }
    }
    return keep;
  }, [scope, samples, filterType]);

  const found = useMemo(() => {
    const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) return null;
    const flat = flattenTree(scope, samples);
    const parents = parentMap(flat);
    const keep = new Set<string>();
    for (const node of flat) {
      if (node.depth > 0 && matches(node, tokens)) {
        for (let id: string | undefined = node.id; id; id = parents.get(id)) keep.add(id);
      }
    }
    return keep;
  }, [scope, samples, query]);

  return useMemo(() => {
    const rows: Row[] = [];
    const visit = (node: PickerNode, parent: string | null) => {
      if (relevant && !relevant.has(node.id)) return;
      if (found && !found.has(node.id)) return;
      const open = node.expandable && (found ? true : expanded.has(node.id));
      const kids = open ? childNodes(node, samples) : [];
      const pickable = node.insertable && fitsFilter(node, filterType);
      const row: Row = { node, open, empty: open && kids.length === 0, pickable, parent };
      rows.push(row);
      for (const kid of kids) visit(kid, node.id);
    };
    for (const section of sectionNodes(scope, samples)) visit(section, null);
    return rows;
  }, [scope, samples, expanded, found, relevant, filterType]);
}

function parentMap(flat: readonly PickerNode[]): Map<string, string> {
  const parents = new Map<string, string>();
  const stack: PickerNode[] = [];
  for (const node of flat) {
    while (stack.length > node.depth) stack.pop();
    const parent = stack[stack.length - 1];
    if (parent) parents.set(node.id, parent.id);
    stack.push(node);
  }
  return parents;
}

/** Sections open at first: the loop, the trigger and the nearest enabled step (likeliest picks). */
function initialExpanded(scope: ScopeEntry[], samples: Record<string, unknown>): Set<string> {
  const sections = sectionNodes(scope, samples);
  const nearestStep = sections.find((s) => s.entry.kind === "step" && !s.entry.disabled);
  return new Set(
    sections.filter((s) => s.entry.kind !== "step" || s === nearestStep).map((s) => s.id),
  );
}

/** @internal {@link DataPicker} plus hosting hooks. */
export function DataPickerView(props: DataPickerViewProps): JSX.Element {
  const { scope, samples, onPick, filterType, onExit, searchRef, className } = props;
  const { labels, resolveIcon } = useFlowkitAppearance();
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(() => initialExpanded(scope, samples));
  const rows = useRows(scope, samples, expanded, query, filterType);
  const [activeId, setActiveId] = useState<string | null>(null);
  const baseId = useId();
  const treeId = `${baseId}tree`;
  const listRef = useRef<HTMLDivElement>(null);

  // New sections (a step added upstream) start expanded.
  const sectionIds = useMemo(() => sectionNodes(scope, samples).map((s) => s.id), [scope, samples]);
  const seen = useRef(new Set(sectionIds));
  useEffect(() => {
    const fresh = sectionIds.filter((id) => !seen.current.has(id));
    if (fresh.length === 0) return;
    for (const id of fresh) seen.current.add(id);
    setExpanded((prev) => new Set([...prev, ...fresh]));
  }, [sectionIds]);

  const activeIndex = Math.max(
    0,
    rows.findIndex((r) => r.node.id === activeId),
  );
  const active = rows[activeIndex];
  const rowDomId = (id: string) => `${baseId}${encodeURIComponent(id)}`;

  // Keep the active row in view as the keyboard moves it.
  const activeKey = active?.node.id;
  useEffect(() => {
    if (activeKey === undefined) return;
    listRef.current?.querySelector("[data-active]")?.scrollIntoView?.({ block: "nearest" });
  }, [activeKey]);

  const toggle = (id: string, open?: boolean) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (open ?? !next.has(id)) next.add(id);
      else next.delete(id);
      return next;
    });

  const pick = (row: Row) => {
    if (row.pickable) onPick(row.node.ref, row.node.typeLabel);
  };
  /** Enter or click: a value inserts; a group opens or closes (while searching, inserts). */
  const activate = (row: Row) => {
    if (!row.node.expandable) pick(row);
    else if (!query) toggle(row.node.id);
    else if (row.node.depth > 0) pick(row);
  };

  const move = (to: number) => {
    const row = rows[Math.min(rows.length - 1, Math.max(0, to))];
    if (row) setActiveId(row.node.id);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    const input = e.currentTarget;
    const caretAtEnd =
      input.selectionStart === input.value.length && input.selectionEnd === input.value.length;
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        move(activeIndex + 1);
        return;
      case "ArrowUp":
        e.preventDefault();
        if (activeIndex === 0 && onExit) onExit("up");
        else move(activeIndex - 1);
        return;
      case "PageDown":
        e.preventDefault();
        move(activeIndex + 8);
        return;
      case "PageUp":
        e.preventDefault();
        move(activeIndex - 8);
        return;
      case "ArrowRight":
        if (!active || !caretAtEnd || !active.node.expandable) return;
        e.preventDefault();
        if (!active.open && !query) toggle(active.node.id, true);
        else move(activeIndex + 1);
        return;
      case "ArrowLeft":
        if (!active || input.value !== "") return;
        e.preventDefault();
        if (active.open) toggle(active.node.id, false);
        else if (active.parent) setActiveId(active.parent);
        return;
      case "Enter":
        if (!active) return;
        e.preventDefault();
        if (e.shiftKey) pick(active);
        else activate(active);
        return;
      case "Escape":
        if (query) {
          e.preventDefault();
          e.stopPropagation();
          setQuery("");
        } else if (onExit) {
          e.preventDefault();
          e.stopPropagation();
          onExit("escape");
        }
        return;
      case "Tab":
        if (onExit) {
          e.preventDefault();
          onExit(e.shiftKey ? "shiftTab" : "tab");
        }
        return;
    }
  };

  const containerHint = active?.node.expandable;

  return (
    <div id={props.id} className={className ? `fk-dp ${className}` : "fk-dp"}>
      <div className="fk-dp__search">
        <Search size={14} aria-hidden />
        <input
          ref={searchRef}
          type="text"
          role="combobox"
          aria-expanded="true"
          aria-controls={treeId}
          aria-autocomplete="list"
          aria-label={labels.searchData}
          {...(active ? { "aria-activedescendant": rowDomId(active.node.id) } : {})}
          placeholder={labels.searchData}
          value={query}
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => {
            setQuery(e.target.value);
            setActiveId(null);
          }}
          onKeyDown={onKeyDown}
        />
      </div>
      {scope.length === 0 ? (
        <p className="fk-dp__empty">{labels.noScope}</p>
      ) : rows.length === 0 ? (
        <p className="fk-dp__empty">{labels.noDataMatches(query)}</p>
      ) : (
        <div
          ref={listRef}
          id={treeId}
          role="tree"
          aria-label={labels.dataPicker}
          className="fk-dp__tree"
          // Clicking rows keeps focus where it is (the search box or the input being filled).
          onMouseDown={(e) => e.preventDefault()}
        >
          {rows.map((row) => (
            <PickerRow
              key={row.node.id}
              id={rowDomId(row.node.id)}
              row={row}
              active={row === active}
              onHover={() => setActiveId(row.node.id)}
              onActivate={() => activate(row)}
              onInsert={() => pick(row)}
              icon={row.node.depth === 0 ? resolveIcon(row.node.entry.icon) : undefined}
              labels={labels}
            />
          ))}
        </div>
      )}
      <div className="fk-dp__foot" aria-hidden="true">
        <span>
          <kbd>↑</kbd>
          <kbd>↓</kbd> {labels.keyNavigate}
        </span>
        {containerHint ? (
          <>
            <span>
              <kbd>
                <CornerDownLeft size={10} />
              </kbd>{" "}
              {labels.keyExpand}
            </span>
            {active?.pickable && (
              <span>
                <kbd>⇧</kbd>
                <kbd>
                  <CornerDownLeft size={10} />
                </kbd>{" "}
                {labels.keyInsertWhole}
              </span>
            )}
          </>
        ) : (
          <span>
            <kbd>
              <CornerDownLeft size={10} />
            </kbd>{" "}
            {labels.keyInsert}
          </span>
        )}
      </div>
    </div>
  );
}

function PickerRow(props: {
  id: string;
  row: Row;
  active: boolean;
  onHover(): void;
  onActivate(): void;
  onInsert(): void;
  icon: IconComponent | undefined;
  labels: FlowkitLabels;
}): JSX.Element {
  const { id, row, active, onHover, onActivate, onInsert, icon: Icon, labels } = props;
  const { node } = row;
  const section = node.depth === 0;
  const sample = node.sample && !section ? formatSample(node.sample.value, labels) : undefined;
  const caption =
    node.entry.kind === "trigger"
      ? labels.scopeTrigger
      : node.entry.kind === "loop"
        ? labels.scopeLoop
        : node.entry.disabled
          ? labels.scopeDisabled
          : labels.scopeStep;
  return (
    // biome-ignore lint/a11y/useFocusableInteractive: rows are reached with aria-activedescendant from the search box
    // biome-ignore lint/a11y/useKeyWithClickEvents: the search box handles the keyboard for the tree
    <div
      id={id}
      role="treeitem"
      aria-level={node.depth + 1}
      aria-selected={active}
      {...(node.expandable ? { "aria-expanded": row.open } : {})}
      className={section ? "fk-dp__row fk-dp__row--section" : "fk-dp__row"}
      data-active={active || undefined}
      data-disabled={(section && node.entry.disabled) || undefined}
      data-leaf={!node.expandable || undefined}
      style={{ "--fk-dp-depth": node.depth } as CSSProperties}
      onMouseMove={active ? undefined : onHover}
      onClick={onActivate}
    >
      <span className="fk-dp__chevron" data-open={row.open || undefined} aria-hidden="true">
        {node.expandable && <ChevronRight size={13} />}
      </span>
      {section ? (
        <>
          <span className="fk-dp__icon" aria-hidden="true">
            {Icon && <Icon size={14} />}
          </span>
          <span className="fk-dp__section">
            <span className="fk-dp__section-name">{node.name}</span>
            <span className="fk-dp__caption">{row.empty ? labels.noKnownFields : caption}</span>
          </span>
        </>
      ) : (
        <>
          <span className="fk-dp__name" data-index={node.firstItem || undefined}>
            {node.firstItem ? (
              <>
                <code>[0]</code> <span className="fk-dp__muted">{labels.firstItem}</span>
              </>
            ) : (
              node.name
            )}
          </span>
          {sample !== undefined && sample !== "" && (
            <span className="fk-dp__sample" title={sample}>
              {sample}
            </span>
          )}
          <span className="fk-dp__type">{node.typeLabel}</span>
        </>
      )}
      {node.expandable && row.pickable && (
        <button
          type="button"
          tabIndex={-1}
          aria-hidden="true"
          className="fk-dp__insert"
          title={labels.insertWhole(node.name)}
          onClick={(e) => {
            e.stopPropagation();
            onInsert();
          }}
        >
          <Plus size={12} />
        </button>
      )}
    </div>
  );
}

/**
 * The data picker: sections for the trigger, each earlier step (nearest first) and, inside a
 * loop, the current item, each an expandable tree of the value's fields with their types and
 * sample values. Picking a field calls `onPick` with its reference path (`steps.load.email`).
 * `filterType` hides fields whose type can't go into a field of that schema.
 */
export function DataPicker(props: {
  scope: ScopeEntry[];
  samples: Record<string, unknown>;
  onPick(refPath: string, typeLabel: string): void;
  filterType?: JSONSchema;
}): JSX.Element {
  return <DataPickerView {...props} />;
}
