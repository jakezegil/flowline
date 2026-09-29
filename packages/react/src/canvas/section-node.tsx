/**
 * Section nodes: the coloured region drawn behind a section's member cards, and its header chip
 * (a separate, focusable node at the region's top-left, so it stacks above the edges while the
 * region stays below them).
 *
 * @module
 */
import { type AnnotationColor, isAnnotationColor, type Section } from "@flowlinejs/core";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import type { Node, NodeProps } from "@xyflow/react";
import { Pencil, StickyNote, TriangleAlert, Ungroup, Wrench } from "lucide-react";
import { type JSX, memo, useContext, useEffect, useMemo, useRef } from "react";
import { useEditorStore, useEditorStoreApi } from "../hooks";
import { nodeElement, sectionActions, sectionRepair } from "./actions";
import {
  type CanvasUiStore,
  PortalContainerContext,
  RootElementContext,
  sectionNoteKey,
  useCanvasUi,
  useCanvasUiApi,
  useLabels,
} from "./canvas-context";
import { ColorSubmenu, dropdownKit, Row, useKeepEditorFocus } from "./context-menu";
import { useFlash } from "./flash";
import { NoteEditor, savedNote } from "./note-editor";

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

/** A section's shown title: its own, else the `untitledSection` label. */
export function sectionTitle(section: Section | undefined, untitled: string): string {
  const title = typeof section?.title === "string" ? section.title.trim() : "";
  return title || untitled;
}

/**
 * For a section ID the doc repeats: whether this occurrence changed with the flash `token`, so
 * only the occurrence a command edited flashes (commands act on one of them). Always true for an
 * ID the doc doesn't repeat.
 */
function useOccurrenceGate(section: Section | undefined): (token: number) => boolean {
  const repeated = useEditorStore((s) => {
    const all = s.doc.sections;
    if (!Array.isArray(all) || !section) return false;
    let n = 0;
    for (const x of all) if (x?.id === section.id) n++;
    return n > 1;
  });
  const json = JSON.stringify(section ?? null);
  // The section as of the last commit, and the verdict for the latest token.
  const before = useRef(json);
  const latch = useRef<{ token: number; changed: boolean } | null>(null);
  useEffect(() => {
    before.current = json;
  });
  return (token) => {
    if (!repeated) return true;
    if (latch.current?.token !== token) {
      latch.current = { token, changed: json !== before.current };
    }
    return latch.current.changed;
  };
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
  // Keyed by node, not section ID: a repeated ID draws two regions that flash on their own.
  const gate = useOccurrenceGate(section);
  const flash = useFlash(store, "section", data.sectionId, { key: id, gate });
  return (
    // biome-ignore lint/a11y/useSemanticElements: a drawn region grouping cards on the canvas, not a form fieldset.
    <div
      className="fl-section"
      role="group"
      aria-label={labels.sectionRegion(sectionTitle(section, labels.untitledSection))}
      data-color={drawColor(data.color)}
      data-flash={flash.flash}
      onAnimationEnd={flash.onAnimationEnd}
    />
  );
});

/**
 * A section's inline title field. Enter or blur saves, Escape keeps the old title. `keyboard` is
 * true when it ended with Enter or Escape (focus should go back to the chip).
 */
function TitleInput({
  initial,
  onDone,
}: {
  initial: string;
  onDone(title: string | null, keyboard: boolean): void;
}) {
  const labels = useLabels();
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  useEffect(() => {
    ref.current?.focus({ preventScroll: true });
    ref.current?.select();
  }, []);
  const finish = (title: string | null, keyboard = false) => {
    if (done.current) return;
    done.current = true;
    onDone(title, keyboard);
  };
  return (
    <input
      ref={ref}
      className="fl-section-title-input nodrag nopan"
      defaultValue={initial}
      aria-label={labels.sectionTitleInput}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") finish(e.currentTarget.value, true);
        if (e.key === "Escape") finish(null, true);
      }}
      onBlur={(e) => finish(e.currentTarget.value)}
    />
  );
}

/**
 * Focuses the header chip of the canvas node `nodeId` once the next layout has rendered, unless
 * an inline editor opened meanwhile (it keeps focus).
 */
function focusChip(root: HTMLElement | null, ui: CanvasUiStore, nodeId: string): void {
  requestAnimationFrame(() => {
    const s = ui.getState();
    if (s.editingNote !== null || s.renamingSection !== null) return;
    nodeElement(root, nodeId)?.querySelector<HTMLElement>("button")?.focus({ preventScroll: true });
  });
}

/**
 * A section's header chip: a colour swatch and the title, plus a one-line excerpt of the
 * section's note. In the editor it is a button opening the section's menu (Rename, Color, Note,
 * Fix when an issue has a repair, Ungroup); a section with an issue shows a warning badge. The
 * title and note edit inline. Plain text on a read-only canvas, whose node itself is then
 * focusable and named.
 */
export const SectionHeader = memo(function SectionHeader({
  id,
  data,
}: NodeProps<SectionHeaderNode>): JSX.Element | null {
  const labels = useLabels();
  const readOnly = useEditorStore((s) => s.readOnly);
  const root = useContext(RootElementContext);
  const store = useEditorStoreApi();
  const ui = useCanvasUiApi();
  const container = useContext(PortalContainerContext);
  const keepEditorFocus = useKeepEditorFocus();
  const section = useSection(id, data.sectionId);
  const sectionId = data.sectionId;
  const renaming = useCanvasUi((s) => s.renamingSection === sectionId);
  const editingNote = useCanvasUi((s) => s.editingNote === sectionNoteKey(sectionId));
  const issues = useEditorStore((s) => s.issues);
  const doc = useEditorStore((s) => s.doc);
  const own = useMemo(() => issues.filter((i) => i.sectionId === sectionId), [issues, sectionId]);
  const fixable = useMemo(() => sectionRepair(doc, own, sectionId), [doc, own, sectionId]);
  const actions = useMemo(
    () => sectionActions(store, ui, root, sectionId),
    [store, ui, root, sectionId],
  );
  if (!section) return null;
  const title = sectionTitle(section, labels.untitledSection);
  const note = typeof section.note === "string" && section.note !== "" ? section.note : undefined;
  const color = drawColor(data.color);
  const warn = own.length > 0 && !readOnly;
  const content = (
    <>
      <span className="fl-section-chip__swatch" aria-hidden />
      <span className="fl-section-chip__title">{title}</span>
      {note !== undefined && (
        <span className="fl-section-chip__note">{excerpt(note, NOTE_EXCERPT)}</span>
      )}
      {warn && (
        <span className="fl-section-chip__warn" aria-hidden>
          <TriangleAlert size={12} strokeWidth={2.25} />
        </span>
      )}
    </>
  );
  if (readOnly) {
    return (
      <div className="fl-section-head">
        <div className="fl-section-chip" data-color={color} title={note ?? title} aria-hidden>
          {content}
        </div>
      </div>
    );
  }
  if (renaming) {
    return (
      <div className="fl-section-head">
        <TitleInput
          initial={typeof section.title === "string" ? section.title : ""}
          onDone={(value, keyboard) => {
            ui.getState().stopSectionRename();
            if (value !== null) store.getState().updateSection(sectionId, { title: value.trim() });
            if (keyboard) focusChip(root(), ui, id);
          }}
        />
      </div>
    );
  }
  const M = dropdownKit;
  return (
    <div className="fl-section-head">
      <DropdownMenu.Root modal={false}>
        <DropdownMenu.Trigger asChild>
          <button
            type="button"
            className="fl-section-chip nodrag nopan"
            data-color={color}
            data-warn={warn || undefined}
            aria-label={labels.sectionHeader(title, note)}
            {...(warn ? { "aria-description": own.map((i) => i.message).join("; ") } : {})}
            title={note ?? title}
            onClick={(e) => e.stopPropagation()}
            onDoubleClick={(e) => e.stopPropagation()}
          >
            {content}
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal container={container}>
          <DropdownMenu.Content
            className="fl-menu"
            align="start"
            side="bottom"
            sideOffset={6}
            collisionPadding={8}
            aria-label={labels.sectionMenu(title)}
            onClick={(e) => e.stopPropagation()}
            onCloseAutoFocus={keepEditorFocus}
          >
            <M.Item className="fl-menu__item" onSelect={actions.rename}>
              <Row icon={Pencil} label={labels.renameSection} />
            </M.Item>
            <ColorSubmenu kit={M} current={section.color} onPick={actions.setColor} />
            <M.Item className="fl-menu__item" onSelect={actions.editNote}>
              <Row icon={StickyNote} label={labels.sectionNote} />
            </M.Item>
            {fixable && (
              <M.Item className="fl-menu__item" onSelect={actions.repair}>
                <Row icon={Wrench} label={labels.fixIssue} />
              </M.Item>
            )}
            <M.Separator className="fl-menu__sep" />
            <M.Item className="fl-menu__item" data-danger onSelect={actions.ungroup}>
              <Row icon={Ungroup} label={labels.ungroup} />
            </M.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
      {editingNote && (
        <div className="fl-section-note" data-color={color}>
          <NoteEditor
            initial={note ?? ""}
            label={labels.sectionNote}
            onDone={(value, keyboard) => {
              ui.getState().stopNoteEdit();
              if (value !== null) {
                store.getState().updateSection(sectionId, { note: savedNote(value) });
              }
              if (keyboard) focusChip(root(), ui, id);
            }}
          />
        </div>
      )}
    </div>
  );
});
