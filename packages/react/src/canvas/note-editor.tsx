/**
 * The inline note editor shared by step notes and section notes.
 *
 * @module
 */
import { NOTE_MAX_CHARS } from "@flowlinejs/core";
import { type JSX, useEffect, useRef } from "react";

/**
 * A note's inline `<textarea>`: autofocused, at most `NOTE_MAX_CHARS` long. ⌘Enter (Ctrl+Enter)
 * or blur saves, Escape cancels. `onDone` gets the text (`null` when cancelled) and whether it
 * ended from the keyboard (focus should then go back to the canvas).
 */
export function NoteEditor({
  initial,
  label,
  className,
  onDone,
}: {
  initial: string;
  /** The field's accessible name. */
  label: string;
  className?: string;
  onDone(text: string | null, keyboard: boolean): void;
}): JSX.Element {
  const ref = useRef<HTMLTextAreaElement>(null);
  const done = useRef(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus({ preventScroll: true });
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);
  const finish = (text: string | null, keyboard = false) => {
    if (done.current) return;
    done.current = true;
    onDone(text, keyboard);
  };
  return (
    <textarea
      ref={ref}
      className={`fl-note-editor nodrag nopan nowheel${className ? ` ${className}` : ""}`}
      defaultValue={initial}
      maxLength={NOTE_MAX_CHARS}
      aria-label={label}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
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
  );
}

/** A note's text as saved: blank text removes the note (`null`). */
export const savedNote = (text: string): string | null => (text.trim() === "" ? null : text);
