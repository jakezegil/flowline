/**
 * The inline note editor shared by step notes and section notes.
 *
 * @module
 */
import { NOTE_MAX_CHARS } from "@flowlinejs/core";
import { type JSX, useEffect, useRef, useState } from "react";
import { useLabels } from "./canvas-context";

/**
 * A note's inline `<textarea>`: autofocused, at most `NOTE_MAX_CHARS` long. ⌘Enter (Ctrl+Enter)
 * or blur saves, Escape cancels. `onDone` gets the text to save, or `null` when there is nothing
 * to save (cancelled, or the text still equals `base`, the note the editor started from, so an
 * edit made meanwhile elsewhere is never overwritten), and whether it ended from the keyboard
 * (focus should then go back to the canvas).
 *
 * A text over `NOTE_MAX_CHARS` (a hand-edited note) can't be saved: the editor stays open with a
 * hint and a Shorten action that cuts it to the limit and saves.
 */
export function NoteEditor({
  initial,
  base = initial,
  label,
  onDone,
  onDraft,
}: {
  /** The text shown on mount (a draft, else the note). */
  initial: string;
  /** The note the edit started from (default `initial`). */
  base?: string;
  /** The field's accessible name. */
  label: string;
  onDone(text: string | null, keyboard: boolean): void;
  /** Called with the text on every change, to keep a draft. */
  onDraft?(text: string): void;
}): JSX.Element {
  const labels = useLabels();
  const ref = useRef<HTMLTextAreaElement>(null);
  const done = useRef(false);
  const [length, setLength] = useState(initial.length);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus({ preventScroll: true });
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);
  const finish = (text: string | null, keyboard = false) => {
    if (done.current) return;
    if (text !== null && text !== base && text.length > NOTE_MAX_CHARS) return;
    done.current = true;
    onDone(text === base ? null : text, keyboard);
  };
  const over = length > NOTE_MAX_CHARS;
  return (
    <>
      <textarea
        ref={ref}
        className="fl-note-editor nodrag nopan nowheel"
        defaultValue={initial}
        maxLength={NOTE_MAX_CHARS}
        aria-label={label}
        aria-invalid={over || undefined}
        onClick={(e) => e.stopPropagation()}
        onDoubleClick={(e) => e.stopPropagation()}
        onChange={(e) => {
          setLength(e.currentTarget.value.length);
          onDraft?.(e.currentTarget.value);
        }}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Escape") {
            e.preventDefault();
            finish(null, true);
          } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            finish(e.currentTarget.value, true);
          }
        }}
        onBlur={(e) => finish(e.currentTarget.value)}
      />
      {over && (
        <div className="fl-note-editor__hint nodrag nopan" role="status">
          <span>{labels.noteTooLong(length, NOTE_MAX_CHARS)}</span>
          <button
            type="button"
            className="fl-note__shorten"
            // Keeps the textarea focused, so its blur doesn't run first.
            onMouseDown={(e) => e.preventDefault()}
            onClick={(e) => {
              e.stopPropagation();
              finish((ref.current?.value ?? "").slice(0, NOTE_MAX_CHARS), true);
            }}
          >
            {labels.shortenNote}
          </button>
        </div>
      )}
    </>
  );
}

/** A note's text as saved: blank text removes the note (`null`). */
export const savedNote = (text: string): string | null => (text.trim() === "" ? null : text);
