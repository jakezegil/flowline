/**
 * CodeMirror support for reference pills: a pill is the text `{{ref}}` in the document, tracked
 * in a state field and drawn as an atomic widget, so the cursor steps over it and Backspace
 * deletes it whole. Pills come from the picker, the `{{` autocomplete, the initial value and
 * pasted `{{ref}}` text.
 *
 * @module
 */

import {
  type EditorState,
  type Extension,
  Facet,
  RangeSet,
  RangeSetBuilder,
  RangeValue,
  StateEffect,
  StateField,
  type Transaction,
} from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  hoverTooltip,
  WidgetType,
} from "@codemirror/view";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { IconComponent } from "../../icons";
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

/** Replaces every pill (the whole set, e.g. when the value changes from outside). */
export const setPills = StateEffect.define<{ from: number; to: number; ref: string }[]>();
/** Adds one pill over existing `{{ref}}` text. */
const addPill = StateEffect.define<{ from: number; to: number; ref: string }>();

function buildMarks(
  list: readonly { from: number; to: number; ref: string }[],
): RangeSet<PillMark> {
  const builder = new RangeSetBuilder<PillMark>();
  for (const p of [...list].sort((a, b) => a.from - b.from))
    builder.add(p.from, p.to, new PillMark(p.ref));
  return builder.finish();
}

/** Pills in pasted or dropped text. */
function pastedPills(tr: Transaction): { from: number; to: number; ref: string }[] {
  if (!tr.isUserEvent("input.paste") && !tr.isUserEvent("input.drop")) return [];
  const out: { from: number; to: number; ref: string }[] = [];
  tr.changes.iterChanges((_fa, _ta, fromB, _tb, inserted) => {
    for (const [from, to, ref] of findRefs(inserted.toString())) {
      out.push({ from: fromB + from, to: fromB + to, ref });
    }
  });
  return out;
}

/** The pill ranges of the document. Configure its start value with {@link pillsFor}. */
export const pillField = StateField.define<RangeSet<PillMark>>({
  create: () => RangeSet.empty,
  update(marks, tr) {
    let next = marks.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(setPills)) next = buildMarks(e.value);
      else if (e.is(addPill))
        next = next.update({
          add: [new PillMark(e.value.ref).range(e.value.from, e.value.to)],
          sort: true,
        });
    }
    const pasted = pastedPills(tr);
    if (pasted.length)
      next = next.update({
        add: pasted.map((p) => new PillMark(p.ref).range(p.from, p.to)),
        sort: true,
      });
    if (tr.docChanged) {
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
  private root: Root | null = null;
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
    el.className = info.stale ? "fk-ref-pill fk-ref-pill--stale" : "fk-ref-pill";
    el.setAttribute("role", "img");
    el.setAttribute("aria-label", this.resolver.ariaLabel(info));
    el.dataset.ref = info.ref;
    const icon = document.createElement("span");
    icon.className = "fk-ref-pill__icon";
    icon.setAttribute("aria-hidden", "true");
    el.append(icon);
    const Icon = this.resolver.icon(info.icon);
    this.root = createRoot(icon);
    this.root.render(createElement(Icon, { size: 12 }));
    const head = document.createElement("span");
    head.className = "fk-ref-pill__head";
    head.textContent = info.head;
    el.append(head);
    if (info.path) {
      const sep = document.createElement("span");
      sep.className = "fk-ref-pill__sep";
      sep.textContent = "›";
      const path = document.createElement("span");
      path.className = "fk-ref-pill__path";
      path.textContent = info.path;
      el.append(sep, path);
    }
    return el;
  }
  override destroy(): void {
    const root = this.root;
    this.root = null;
    // Unmounting synchronously while React renders warns, so defer it.
    if (root) queueMicrotask(() => root.unmount());
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

/** A hover card on a pill: its full path, type, sample value and, if stale, why. */
const pillHover = hoverTooltip(
  (view, pos) => {
    const resolver = view.state.facet(pillResolver);
    if (!resolver) return null;
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
        dom.className = "fk-ref-card";
        const title = document.createElement("div");
        title.className = "fk-ref-card__title";
        title.textContent = info.label;
        const meta = document.createElement("div");
        meta.className = "fk-ref-card__meta";
        const code = document.createElement("code");
        code.textContent = info.ref;
        const type = document.createElement("span");
        type.className = "fk-ref-card__type";
        type.textContent = info.type;
        meta.append(code, type);
        dom.append(title, meta);
        const sample = resolver.sample(ref);
        if (sample !== undefined) {
          const row = document.createElement("div");
          row.className = "fk-ref-card__sample";
          const label = document.createElement("span");
          label.textContent = resolver.sampleLabel;
          const value = document.createElement("span");
          value.textContent = sample;
          row.append(label, value);
          dom.append(row);
        }
        if (info.stale) {
          const warn = document.createElement("div");
          warn.className = "fk-ref-card__warn";
          warn.textContent = resolver.staleHint;
          dom.append(warn);
        }
        return { dom };
      },
    };
  },
  { hoverTime: 250 },
);

/** Pill support, starting with the pills of `pills` (from {@link partsToDoc}). */
export function pillsFor(pills: { from: number; to: number; ref: string }[]): Extension {
  return [pillField.init(() => buildMarks(pills)), decorationField, pillHover];
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
    scrollIntoView: true,
  });
}
