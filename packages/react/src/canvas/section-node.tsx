/**
 * Section nodes: the coloured region drawn behind a section's member cards, and its header chip
 * (a separate, focusable node at the region's top-left, so it stacks above the edges while the
 * region stays below them).
 *
 * @module
 */
import { type AnnotationColor, isAnnotationColor, type Section } from "@flowlinejs/core";
import type { Node, NodeProps } from "@xyflow/react";
import { type JSX, memo, useContext } from "react";
import { useEditorStore, useEditorStoreApi } from "../hooks";
import { focusNode } from "./actions";
import { RootElementContext, useLabels } from "./canvas-context";
import { useFlash } from "./flash";

/** Data of a section region or header node. */
export interface SectionNodeData extends Record<string, unknown> {
  /** The section's ID in the doc. */
  sectionId: string;
  /** The region's colour (`"gray"` for a colour outside the palette). */
  color: AnnotationColor;
}

/** A section's region node. */
export type SectionRegionNode = Node<SectionNodeData, "section">;
/** A section's header chip node. */
export type SectionHeaderNode = Node<SectionNodeData, "sectionHeader">;

/** Characters of a section's note shown on its header chip. */
const NOTE_EXCERPT = 60;

/**
 * The doc section a node draws. A node ID ends in `~<index>` when the doc repeats the section's
 * ID; that index picks the right one.
 */
export function sectionOfNode(
  sections: readonly Section[] | undefined,
  nodeId: string,
  sectionId: string,
): Section | undefined {
  if (!Array.isArray(sections)) return undefined;
  const m = /~(\d+)$/.exec(nodeId);
  const at = m ? sections[Number(m[1])] : undefined;
  if (at?.id === sectionId) return at;
  return sections.find((s) => s?.id === sectionId);
}

/** The colour to draw: the palette colour, else gray. */
export const drawColor = (c: unknown): AnnotationColor => (isAnnotationColor(c) ? c : "gray");

/** One line of a note, cut to `max` characters with an ellipsis. */
export function excerpt(note: string, max: number): string {
  const line = note.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}

function useSection(id: string, sectionId: string): Section | undefined {
  return useEditorStore((s) => sectionOfNode(s.doc.sections, id, sectionId));
}

/**
 * A section's coloured region: behind its members' cards and below the edges, neither
 * selectable nor focusable. A group named by the section's title.
 */
export const SectionRegion = memo(function SectionRegion({
  id,
  data,
}: NodeProps<SectionRegionNode>): JSX.Element {
  const labels = useLabels();
  const store = useEditorStoreApi();
  const section = useSection(id, data.sectionId);
  const flash = useFlash(store, "section", data.sectionId);
  return (
    // biome-ignore lint/a11y/useSemanticElements: a drawn region grouping cards on the canvas, not a form fieldset.
    <div
      className="fl-section"
      role="group"
      aria-label={labels.sectionRegion(section?.title ?? "")}
      data-color={drawColor(data.color)}
      data-flash={flash.flashing || undefined}
      onAnimationEnd={flash.onAnimationEnd}
    />
  );
});

/**
 * A section's header chip: a colour swatch and the title, plus a one-line excerpt of the
 * section's note. A button in the editor (it focuses the section's first card); plain text on a
 * read-only canvas, whose node itself is then focusable and named.
 */
export const SectionHeader = memo(function SectionHeader({
  id,
  data,
}: NodeProps<SectionHeaderNode>): JSX.Element | null {
  const labels = useLabels();
  const readOnly = useEditorStore((s) => s.readOnly);
  const root = useContext(RootElementContext);
  const section = useSection(id, data.sectionId);
  if (!section) return null;
  const title = typeof section.title === "string" ? section.title : "";
  const note = typeof section.note === "string" && section.note !== "" ? section.note : undefined;
  const content = (
    <>
      <span className="fl-section-chip__swatch" aria-hidden />
      <span className="fl-section-chip__title">{title.trim() || labels.untitledSection}</span>
      {note !== undefined && (
        <span className="fl-section-chip__note">{excerpt(note, NOTE_EXCERPT)}</span>
      )}
    </>
  );
  const color = drawColor(data.color);
  return (
    <div className="fl-section-head">
      {readOnly ? (
        <div className="fl-section-chip" data-color={color} title={note ?? title} aria-hidden>
          {content}
        </div>
      ) : (
        <button
          type="button"
          className="fl-section-chip nodrag nopan"
          data-color={color}
          aria-label={labels.sectionHeader(title, note)}
          title={note ?? title}
          onClick={(e) => {
            e.stopPropagation();
            focusNode(root(), section.first);
          }}
        >
          {content}
        </button>
      )}
    </div>
  );
});
