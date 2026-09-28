import { CompletionContext, currentCompletions } from "@codemirror/autocomplete";
import { undo } from "@codemirror/commands";
import type { EditorState } from "@codemirror/state";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { editorView, setupCodeMirrorDom, typeInto } from "../../test/codemirror-dom";
import { loopEntry, scope } from "../../test/picker-fixtures";
import { CodeEditor, scopeCompletions } from "./code-editor";

beforeAll(setupCodeMirrorDom);
afterEach(cleanup);

/** Completion labels at the end of `doc` in the editor labelled "Code". */
function completeAt(doc: string): string[] {
  const view = editorView("Code");
  act(() => {
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: doc } });
  });
  const state: EditorState = view.state;
  const result = scopeCompletions(new CompletionContext(state, doc.length, true));
  return result ? result.options.map((o) => o.label) : [];
}

describe("CodeEditor", () => {
  test("shows the value and emits edits", () => {
    const onChange = vi.fn();
    render(<CodeEditor ariaLabel="Code" value="return 1;" onChange={onChange} scope={scope} />);
    const view = editorView("Code");
    expect(view.state.doc.toString()).toBe("return 1;");
    act(() => {
      view.dispatch({ selection: { anchor: view.state.doc.length } });
      typeInto(view, "\n");
    });
    expect(onChange).toHaveBeenLastCalledWith("return 1;\n");
  });

  test("a new value from outside replaces the code without echoing it", () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <CodeEditor ariaLabel="Code" value="a" onChange={onChange} scope={scope} />,
    );
    rerender(<CodeEditor ariaLabel="Code" value="b" onChange={onChange} scope={scope} />);
    expect(editorView("Code").state.doc.toString()).toBe("b");
    expect(onChange).not.toHaveBeenCalled();
    // …and undo doesn't bring the old code back.
    act(() => {
      undo(editorView("Code"));
    });
    expect(editorView("Code").state.doc.toString()).toBe("b");
    expect(onChange).not.toHaveBeenCalled();
  });

  test("completes steps, their fields, trigger fields and loop", () => {
    const { rerender } = render(
      <CodeEditor ariaLabel="Code" value="" onChange={() => {}} scope={scope} />,
    );
    expect(completeAt("return steps.")).toEqual(["load", "fetch"]);
    expect(completeAt("return steps.load.")).toEqual(["email", "score", "tags", "company"]);
    expect(completeAt("return steps.load.company.do")).toEqual(["domain"]);
    expect(completeAt("return trigger.")).toEqual(["name", "amount"]);
    expect(completeAt("return tr")).toEqual(["trigger", "steps"]);
    rerender(
      <CodeEditor ariaLabel="Code" value="" onChange={() => {}} scope={[...scope, loopEntry]} />,
    );
    expect(completeAt("loop.")).toEqual(["item", "index"]);
    expect(completeAt("x")).toContain("loop");
  });

  test("Escape closes completions and never reaches an enclosing handler", async () => {
    const outer = vi.fn();
    render(
      // biome-ignore lint/a11y/noStaticElementInteractions: test harness
      <div onKeyDown={outer}>
        <CodeEditor ariaLabel="Code" value="" onChange={() => {}} scope={scope} />
      </div>,
    );
    const view = editorView("Code");
    act(() => typeInto(view, "steps."));
    await waitFor(() => expect(currentCompletions(view.state).length).toBeGreaterThan(0));
    const content = document.querySelector(".cm-content") as HTMLElement;
    fireEvent.keyDown(content, { key: "Escape", keyCode: 27 });
    expect(currentCompletions(view.state)).toHaveLength(0);
    expect(outer).not.toHaveBeenCalled();
    // M5: nothing left to close, Escape only releases Tab (the hint's "Escape, then Tab"); it
    // still doesn't close the enclosing panel.
    fireEvent.keyDown(content, { key: "Escape", keyCode: 27 });
    expect(outer).not.toHaveBeenCalled();
  });

  test("is labelled for screen readers and can be read-only", () => {
    render(<CodeEditor ariaLabel="Code" value="" onChange={() => {}} scope={scope} readOnly />);
    const content = document.querySelector(".cm-content") as HTMLElement;
    expect(content.getAttribute("aria-label")).toBe("Code");
    expect(content.getAttribute("contenteditable")).toBe("false");
    expect(
      document.getElementById(content.getAttribute("aria-describedby") ?? "")?.textContent,
    ).toMatch(/Escape, then Tab/);
  });
});
