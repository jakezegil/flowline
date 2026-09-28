/**
 * The `{{` autocomplete of a reference input: typing `{{` lists every value in scope (the same
 * rows as the data picker), filtered fuzzily on labels and paths; choosing one inserts a pill.
 *
 * @module
 */

import {
  autocompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult,
} from "@codemirror/autocomplete";
import { type Extension, Facet } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import type { IconComponent } from "../../icons";
import { bestScore } from "./fuzzy";
import { fillIcon } from "./icon-markup";
import { insertPill } from "./pills";
import type { PickerNode } from "./schema-tree";

/** Most options the autocomplete lists. */
const MAX_OPTIONS = 60;

/** What the autocomplete offers: the picker's rows, their labels and icons. */
export interface RefCompletionSource {
  /** Every insertable row, in picker order. */
  nodes(): readonly PickerNode[];
  icon(name: string | undefined): IconComponent;
  /** A one-line sample of a row, if it has one. */
  sample(node: PickerNode): string | undefined;
}

/** The autocomplete's rows; reconfigure when scope or samples change. */
export const refCompletionSource = Facet.define<RefCompletionSource, RefCompletionSource | null>({
  combine: (values) => values[values.length - 1] ?? null,
});

interface RefCompletion extends Completion {
  node: PickerNode;
  sampleText?: string;
}

/** `Load contact › email` */
export function nodeLabel(node: PickerNode): string {
  return node.pathLabel ? `${node.entry.label} › ${node.pathLabel}` : node.entry.label;
}

function refOptions(context: CompletionContext): CompletionResult | null {
  const source = context.state.facet(refCompletionSource);
  if (!source) return null;
  const match = context.matchBefore(/\{\{[^{}]*$/);
  if (!match) return null;
  // `\{{` is an escaped literal, not a reference.
  if (match.from > 0 && context.state.sliceDoc(match.from - 1, match.from) === "\\") return null;
  const query = match.text.slice(2).trim();
  const scored: { node: PickerNode; score: number; order: number }[] = [];
  const nodes = source.nodes().filter((n) => n.insertable);
  // Rows containing the query as typed win outright; scattered fuzzy matches (on the label
  // only, as ref paths share letters) are the fallback.
  const q = query.toLowerCase();
  const direct = nodes.filter((n) => `${nodeLabel(n)}\n${n.ref}`.toLowerCase().includes(q));
  (direct.length > 0 ? direct : nodes).forEach((node, order) => {
    const score = bestScore(
      query,
      direct.length > 0 ? [nodeLabel(node), node.ref] : [nodeLabel(node)],
    );
    if (score !== null) scored.push({ node, score, order });
  });
  if (query) scored.sort((a, b) => b.score - a.score || a.order - b.order);
  const options: RefCompletion[] = scored.slice(0, MAX_OPTIONS).map(({ node }, i) => {
    const sampleText = source.sample(node);
    return {
      label: nodeLabel(node),
      detail: node.typeLabel,
      type: "fl-ref",
      boost: -i,
      node,
      ...(sampleText !== undefined ? { sampleText } : {}),
      apply: (view: EditorView, _c: Completion, _from: number, to: number) => {
        // Swallow a `}}` the user already typed after the query.
        const after = view.state.sliceDoc(to, to + 2) === "}}" ? to + 2 : to;
        insertPill(view, node.ref, { from: match.from, to: after });
      },
    };
  });
  if (options.length === 0) return null;
  return { from: match.from, options, filter: false };
}

/** The `{{` autocomplete. */
export function refAutocomplete(): Extension {
  return autocompletion({
    override: [refOptions],
    icons: false,
    closeOnBlur: true,
    tooltipClass: () => "fl-ref-complete",
    optionClass: () => "fl-ref-option",
    addToOptions: [
      {
        position: 20,
        render(completion, state) {
          const source = state.facet(refCompletionSource);
          const el = document.createElement("span");
          el.className = "fl-ref-option__icon";
          el.setAttribute("aria-hidden", "true");
          const node = (completion as RefCompletion).node;
          if (source && node) fillIcon(el, source.icon(node.entry.icon));
          return el;
        },
      },
      {
        position: 90,
        render(completion) {
          const sample = (completion as RefCompletion).sampleText;
          if (sample === undefined || sample === "") return null;
          const el = document.createElement("span");
          el.className = "fl-ref-option__sample";
          el.textContent = sample;
          return el;
        },
      },
    ],
  });
}
