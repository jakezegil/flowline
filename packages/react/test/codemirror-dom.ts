import { EditorView } from "@codemirror/view";
import { setupDom } from "./dom";

/** jsdom lacks the layout APIs CodeMirror measures with; stub them (plus {@link setupDom}). */
export function setupCodeMirrorDom(): void {
  setupDom();
  const rect = () => new DOMRect(0, 0, 0, 0);
  const rects = () => ({ length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] });
  Range.prototype.getBoundingClientRect = rect;
  Range.prototype.getClientRects = rects as unknown as () => DOMRectList;
  globalThis.requestAnimationFrame ??= (cb) =>
    setTimeout(() => cb(Date.now()), 0) as unknown as number;
  document.elementFromPoint ??= () => null;
}

/** The CodeMirror view of the editor with accessible name `label`. */
export function editorView(label: string): EditorView {
  const content = document.querySelector(`.cm-content[aria-label="${label}"]`);
  if (!(content instanceof HTMLElement)) throw new Error(`No editor labelled ${label}`);
  const view = EditorView.findFromDOM(content);
  if (!view) throw new Error(`No view for ${label}`);
  return view;
}

/** Types `text` at the cursor as a user would (a `input.type` transaction). */
export function typeInto(view: EditorView, text: string): void {
  for (const ch of text) {
    view.dispatch(view.state.replaceSelection(ch), { userEvent: "input.type" });
  }
}
