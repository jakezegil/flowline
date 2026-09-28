/**
 * CodeMirror support for reference pills: a pill is the text `{{ref}}` in the document, tracked
 * in a state field and drawn as an atomic widget, so the cursor steps over it and Backspace
 * deletes it whole. Pills come from the picker, the `{{` autocomplete, the initial value and
 * `{{ref}}` text that is pasted or typed (normalized to `{{ref}}`, whitespace dropped).
 *
 * Pill marks are part of undo history: a transaction that deletes pills records effects that
 * re-add them, so undo and redo bring back pills rather than their bare `{{ref}}` text.
 *
 * @module
 */

import { invertedEffects, isolateHistory } from "@codemirror/commands";
import {
  type ChangeDesc,
  type ChangeSpec,
  EditorState,
  type Extension,
  Facet,
  RangeSet,
  RangeSetBuilder,
  RangeValue,
  StateEffect,
  StateField,
} from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  hoverTooltip,
  WidgetType,
} from "@codemirror/view";
import type { IconComponent } from "../../icons";
import { fillIcon } from "./icon-markup";
import { findRefs, type PillInfo, type RefPart } from "./ref-model";

/** Marks a pill's range in the document. */
class PillMark extends RangeValue {
  // Text typed right at either edge of a pill stays outside it.
  override startSide = 1;
  override endSide = -1;
  constructor(readonly ref: string) {
    super();
  }
  override eq(other: RangeValue): boolean {
    return other instanceof PillMark && other.ref === this.ref;
  }
}

/** A pill's range and reference. */
type PillRange = { from: number; to: number; ref: string };

/** A pill range through a change mapping; gone if its text was deleted. */
function mapRange(p: PillRange, mapping: ChangeDesc): PillRange | undefined {
  const from = mapping.mapPos(p.from, 1);
  const to = mapping.mapPos(p.to, -1);
  return to > from ? { from, to, ref: p.ref } : undefined;
}

/** Replaces every pill (the whole set, e.g. when the value changes from outside). */
export const setPills = StateEffect.define<PillRange[]>({
  map: (list, mapping) => list.flatMap((p) => mapRange(p, mapping) ?? []),
});
/** Adds one pill over existing `{{ref}}` text (positions after the transaction's changes). */
export const addPill = StateEffect.define<PillRange>({ map: mapRange });

function buildMarks(
  list: readonly { from: number; to: number; ref: string }[],
): RangeSet<PillMark> {
  const builder = new RangeSetBuilder<PillMark>();
  for (const p of [...list].sort((a, b) => a.from - b.from))
    builder.add(p.from, p.to, new PillMark(p.ref));
  return builder.finish();
}

/** The pill ranges of the document. Configure its start value with {@link pillsFor}. */
export const pillField = StateField.define<RangeSet<PillMark>>({
  create: () => RangeSet.empty,
  update(marks, tr) {
    let next = marks.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(setPills)) next = buildMarks(e.value);
      else if (e.is(addPill)) {
        const { from, to, ref } = e.value;
        // Replaces any pill it overlaps (undo can re-add a pill that survived).
        next = next.update({
          filter: (f, t) => t <= from || f >= to,
          filterFrom: from,
          filterTo: to,
          add: [new PillMark(ref).range(from, to)],
          sort: true,
        });
      }
    }
    if (tr.docChanged || tr.effects.length > 0) {
      // A pill whose text was edited (only possible programmatically) stops being a pill.
      const doc = tr.newDoc;
      next = next.update({
        filter: (from, to, m) => to > from && doc.sliceString(from, to) === `{{${m.ref}}}`,
      });
    }
    return next;
  },
});

/** Document text and pill ranges for some parts. */
export function partsToDoc(parts: readonly RefPart[]): {
  doc: string;
  pills: { from: number; to: number; ref: string }[];
} {
  let doc = "";
  const pills: { from: number; to: number; ref: string }[] = [];
  for (const part of parts) {
    if ("text" in part) doc += part.text;
    else {
      const text = `{{${part.ref}}}`;
      pills.push({ from: doc.length, to: doc.length + text.length, ref: part.ref });
      doc += text;
    }
  }
  return { doc, pills };
}

/** The document as text and pill parts. */
export function docParts(state: EditorState): RefPart[] {
  const parts: RefPart[] = [];
  let pos = 0;
  const doc = state.doc;
  const iter = state.field(pillField).iter();
  for (; iter.value; iter.next()) {
    if (iter.from > pos) parts.push({ text: doc.sliceString(pos, iter.from) });
    parts.push({ ref: iter.value.ref });
    pos = iter.to;
  }
  if (pos < doc.length) parts.push({ text: doc.sliceString(pos) });
  return parts;
}

/** The number of pills in the document. */
export function pillCount(state: EditorState): number {
  return state.field(pillField).size;
}

/** How pills look up their label, icon and state. */
export interface PillResolver {
  info(ref: string): PillInfo;
  icon(name: string | undefined): IconComponent;
  /** Accessible name of a pill. */
  ariaLabel(info: PillInfo): string;
  /** Tooltip text of a stale pill. */
  staleHint: string;
  /** Tooltip label before a sample value. */
  sampleLabel: string;
  /** A sample value for the tooltip, if one is known. */
  sample(ref: string): string | undefined;
}

/** The resolver pills are drawn with; reconfigure it when scope or labels change. */
export const pillResolver = Facet.define<PillResolver, PillResolver | null>({
  combine: (values) => values[values.length - 1] ?? null,
});

class PillWidget extends WidgetType {
  constructor(
    readonly info: PillInfo,
    private readonly resolver: PillResolver,
  ) {
    super();
  }
  override eq(other: PillWidget): boolean {
    const a = this.info;
    const b = other.info;
    return (
      a.ref === b.ref &&
      a.label === b.label &&
      a.icon === b.icon &&
      a.type === b.type &&
      a.stale === b.stale
    );
  }
  override toDOM(): HTMLElement {
    const { info } = this;
    const el = document.createElement("span");
    el.className = info.stale ? "fl-ref-pill fl-ref-pill--stale" : "fl-ref-pill";
    el.setAttribute("role", "img");
    el.setAttribute("aria-label", this.resolver.ariaLabel(info));
    el.dataset.ref = info.ref;
    const icon = document.createElement("span");
    icon.className = "fl-ref-pill__icon";
    icon.setAttribute("aria-hidden", "true");
    // Markup, not a React root: CodeMirror may reuse this DOM without destroying the widget.
    fillIcon(icon, this.resolver.icon(info.icon));
    el.append(icon);
    const head = document.createElement("span");
    head.className = "fl-ref-pill__head";
    head.textContent = info.head;
    el.append(head);
    if (info.path) {
      const sep = document.createElement("span");
      sep.className = "fl-ref-pill__sep";
      sep.textContent = "›";
      const path = document.createElement("span");
      path.className = "fl-ref-pill__path";
      path.textContent = info.path;
      el.append(sep, path);
    }
    return el;
  }
  override ignoreEvent(): boolean {
    return false;
  }
}

function pillDecorations(state: EditorState): DecorationSet {
  const resolver = state.facet(pillResolver);
  if (!resolver) return Decoration.none;
  const builder = new RangeSetBuilder<Decoration>();
  const iter = state.field(pillField).iter();
  for (; iter.value; iter.next()) {
    const info = resolver.info(iter.value.ref);
    builder.add(iter.from, iter.to, Decoration.replace({ widget: new PillWidget(info, resolver) }));
  }
  return builder.finish();
}

const decorationField = StateField.define<DecorationSet>({
  create: pillDecorations,
  update(deco, tr) {
    const changed =
      tr.docChanged ||
      tr.startState.field(pillField) !== tr.state.field(pillField) ||
      tr.startState.facet(pillResolver) !== tr.state.facet(pillResolver);
    return changed ? pillDecorations(tr.state) : deco;
  },
  provide: (f) => [
    EditorView.decorations.from(f),
    EditorView.atomicRanges.of((view) => view.state.field(f)),
  ],
});

/** Turns pill hover cards off (while a popover sits over the field) or back on. */
export const setPillHover = StateEffect.define<boolean>();

const pillHoverOn = StateField.define<boolean>({
  create: () => true,
  update(on, tr) {
    for (const e of tr.effects) if (e.is(setPillHover)) on = e.value;
    return on;
  },
});

/** A hover card on a pill: its full path, type, sample value and, if stale, why. */
const pillHover = hoverTooltip(
  (view, pos) => {
    const resolver = view.state.facet(pillResolver);
    if (!resolver || !view.state.field(pillHoverOn)) return null;
    let found: { from: number; to: number; ref: string } | null = null;
    view.state.field(pillField).between(pos, pos, (from, to, m) => {
      if (pos >= from && pos <= to) found = { from, to, ref: m.ref };
    });
    if (!found) return null;
    const { from, to, ref } = found as { from: number; to: number; ref: string };
    return {
      pos: from,
      end: to,
      above: true,
      create() {
        const info = resolver.info(ref);
        const dom = document.createElement("div");
        dom.className = "fl-ref-card";
        const title = document.createElement("div");
        title.className = "fl-ref-card__title";
        title.textContent = info.label;
        const meta = document.createElement("div");
        meta.className = "fl-ref-card__meta";
        const code = document.createElement("code");
        code.textContent = info.ref;
        const type = document.createElement("span");
        type.className = "fl-ref-card__type";
        type.textContent = info.type;
        meta.append(code, type);
        dom.append(title, meta);
        const sample = resolver.sample(ref);
        if (sample !== undefined) {
          const row = document.createElement("div");
          row.className = "fl-ref-card__sample";
          const label = document.createElement("span");
          label.textContent = resolver.sampleLabel;
          const value = document.createElement("span");
          value.textContent = sample;
          row.append(label, value);
          dom.append(row);
        }
        if (info.stale) {
          const warn = document.createElement("div");
          warn.className = "fl-ref-card__warn";
          warn.textContent = resolver.staleHint;
          dom.append(warn);
        }
        return { dom };
      },
    };
  },
  { hoverTime: 250 },
);

/** Undo re-adds the pills a transaction deleted (in its start document's positions). */
const pillHistory = invertedEffects.of((tr) => {
  if (!tr.docChanged) return [];
  const out: StateEffect<PillRange>[] = [];
  const marks = tr.startState.field(pillField, false);
  marks?.between(0, tr.startState.doc.length, (from, to, m) => {
    if (tr.changes.touchesRange(from, to)) out.push(addPill.of({ from, to, ref: m.ref }));
  });
  return out;
});

/**
 * Typed, pasted or dropped `{{ ref }}` text becomes a pill, normalized to `{{ref}}`. Only
 * references the edit touches convert, so literal text elsewhere stays as it is.
 */
const pillInput = EditorState.transactionFilter.of((tr) => {
  if (!tr.docChanged || !tr.isUserEvent("input") || tr.isUserEvent("input.complete")) return tr;
  const marks = tr.startState.field(pillField, false)?.map(tr.changes);
  if (!marks) return tr;
  const doc = tr.newDoc;
  const added = tr.effects.flatMap((e) => (e.is(addPill) ? [e.value] : []));
  const isPill = (from: number, to: number) => {
    let hit = added.some((p) => p.from < to && p.to > from);
    marks.between(from, to, (f, t) => {
      if (f < to && t > from) hit = true;
    });
    return hit;
  };
  const found = new Map<number, PillRange>();
  tr.changes.iterChangedRanges((_fa, _ta, fromB, toB) => {
    if (toB === fromB) return;
    const start = doc.lineAt(fromB).from;
    const end = doc.lineAt(toB).to;
    for (const [f, t, ref] of findRefs(doc.sliceString(start, end))) {
      const from = start + f;
      const to = start + t;
      if (from < toB && to > fromB && !isPill(from, to)) found.set(from, { from, to, ref });
    }
  });
  if (found.size === 0) return tr;
  const changes: ChangeSpec[] = [];
  const effects: StateEffect<PillRange>[] = [];
  let delta = 0;
  for (const p of [...found.values()].sort((a, b) => a.from - b.from)) {
    const text = `{{${p.ref}}}`;
    if (doc.sliceString(p.from, p.to) !== text)
      changes.push({ from: p.from, to: p.to, insert: text });
    effects.push(
      addPill.of({ from: p.from + delta, to: p.from + delta + text.length, ref: p.ref }),
    );
    delta += text.length - (p.to - p.from);
  }
  return [tr, { changes, effects, sequential: true }];
});

/** Pill support, starting with the pills of `pills` (from {@link partsToDoc}). */
export function pillsFor(pills: PillRange[]): Extension {
  return [
    pillField.init(() => buildMarks(pills)),
    decorationField,
    pillHoverOn,
    pillHover,
    pillHistory,
    pillInput,
  ];
}

/** Inserts a pill for `ref` over `from`–`to` (default: the selection) and puts the cursor after it. */
export function insertPill(
  view: EditorView,
  ref: string,
  range?: { from: number; to: number },
): void {
  const sel = view.state.selection.main;
  const from = range?.from ?? sel.from;
  const to = range?.to ?? sel.to;
  const text = `{{${ref}}}`;
  view.dispatch({
    changes: { from, to, insert: text },
    effects: addPill.of({ from, to: from + text.length, ref }),
    selection: { anchor: from + text.length },
    userEvent: "input.complete",
    // Each insert is its own undo step.
    annotations: isolateHistory.of("full"),
    scrollIntoView: true,
  });
}
