import { acceptCompletion, currentCompletions } from "@codemirror/autocomplete";
import { deleteCharBackward, redo, undo } from "@codemirror/commands";
import type { ScopeEntry, ValueExpr } from "@flowkit/core";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { editorView, setupCodeMirrorDom, typeInto } from "../../test/codemirror-dom";
import { bigScope, samples, scope } from "../../test/picker-fixtures";
import { partsToValue, valueToParts } from "./picker/ref-model";
import { RefTextInput } from "./ref-text-input";

beforeAll(setupCodeMirrorDom);
afterEach(cleanup);

type Props = Partial<Parameters<typeof RefTextInput>[0]>;

function setup(props: Props = {}) {
  const onChange = vi.fn();
  function Host() {
    const [value, setValue] = useState<ValueExpr | undefined>(props.value);
    return (
      <RefTextInput
        ariaLabel="Subject"
        scope={scope}
        samples={samples}
        {...props}
        value={value}
        onChange={(v) => {
          onChange(v);
          setValue(v);
        }}
      />
    );
  }
  render(<Host />);
  return { onChange, view: () => editorView("Subject") };
}

const pills = () => Array.from(document.querySelectorAll(".fk-ref-pill"));

/** Focuses the editor (opening the picker) and clicks the picker row whose text starts with `name`. */
function pickRow(name: string) {
  const row = screen.getAllByRole("treeitem").find((r) => r.textContent?.startsWith(name));
  if (!row) throw new Error(`No row ${name}`);
  fireEvent.click(row);
}

function focus() {
  const content = document.querySelector(".cm-content") as HTMLElement;
  act(() => {
    fireEvent.focus(content);
  });
}

describe("RefTextInput", () => {
  test("typing text emits a literal string; clearing emits undefined", () => {
    const { onChange, view } = setup();
    act(() => typeInto(view(), "Hi"));
    expect(onChange).toHaveBeenLastCalledWith("Hi");
    act(() => {
      deleteCharBackward(view());
      deleteCharBackward(view());
    });
    expect(onChange).toHaveBeenLastCalledWith(undefined);
  });

  test("inserting a pill from the picker emits { $ref }", async () => {
    const { onChange } = setup();
    focus();
    await screen.findByRole("tree");
    pickRow("name");
    expect(onChange).toHaveBeenLastCalledWith({ $ref: "trigger.name" });
    expect(pills()).toHaveLength(1);
    // The picker stays open for more inserts.
    expect(screen.getByRole("tree")).toBeTruthy();
  });

  test("text plus a pill emits { $tpl }", async () => {
    const { onChange, view } = setup();
    act(() => typeInto(view(), "Hi "));
    focus();
    await screen.findByRole("tree");
    pickRow("name");
    expect(onChange).toHaveBeenLastCalledWith({ $tpl: "Hi {{trigger.name}}" });
  });

  test("an initial $tpl renders pills with accessible names", () => {
    setup({ value: { $tpl: "Dear {{steps.load.email}}, {{trigger.amount}}" } });
    expect(pills()).toHaveLength(2);
    expect(screen.getByRole("img", { name: "Load contact › email (string)" })).toBeTruthy();
    expect(screen.getByRole("img", { name: "Trigger › amount (number)" })).toBeTruthy();
    expect(editorView("Subject").state.doc.toString()).toBe(
      "Dear {{steps.load.email}}, {{trigger.amount}}",
    );
  });

  test("a stale reference renders warning-styled", () => {
    setup({
      value: { $tpl: "{{steps.gone.id}} {{trigger.name}} {{steps.load.email}}" },
      invalidRefs: new Set(["steps.load.email"]),
    });
    const [gone, name, flagged] = pills();
    expect(gone?.classList.contains("fk-ref-pill--stale")).toBe(true);
    expect(name?.classList.contains("fk-ref-pill--stale")).toBe(false);
    expect(flagged?.classList.contains("fk-ref-pill--stale")).toBe(true);
    expect(gone?.getAttribute("aria-label")).toBe("gone › id: not available here");
  });

  test("Backspace deletes a whole pill", () => {
    const { onChange, view } = setup({ value: { $tpl: "Hi {{trigger.name}}" } });
    act(() => {
      view().dispatch({ selection: { anchor: view().state.doc.length } });
      deleteCharBackward(view());
    });
    expect(onChange).toHaveBeenLastCalledWith("Hi ");
    expect(pills()).toHaveLength(0);
  });

  test("typing {{ autocompletes over the scope and inserts a pill", async () => {
    const { onChange, view } = setup();
    act(() => typeInto(view(), "To {{ema"));
    await waitFor(() => expect(currentCompletions(view().state).length).toBeGreaterThan(0));
    expect(currentCompletions(view().state)[0]?.label).toBe("Load contact › email");
    // Completions ignore keys for a moment after opening.
    await new Promise((r) => setTimeout(r, 100));
    act(() => {
      acceptCompletion(view());
    });
    expect(onChange).toHaveBeenLastCalledWith({ $tpl: "To {{steps.load.email}}" });
    expect(pills()).toHaveLength(1);
  });

  test("pasted {{ref}} text becomes a pill", () => {
    const { onChange, view } = setup();
    act(() => {
      view().dispatch({
        changes: { from: 0, insert: "{{steps.load.score}}" },
        userEvent: "input.paste",
      });
    });
    expect(onChange).toHaveBeenLastCalledWith({ $ref: "steps.load.score" });
  });

  test("literal {{ next to pills is escaped in the template", () => {
    expect(partsToValue([{ text: "a {{b}} " }, { ref: "trigger.name" }])).toEqual({
      $tpl: "a \\{{b}} {{trigger.name}}",
    });
    expect(valueToParts({ $tpl: "a \\{{b}} {{trigger.name}}" })).toEqual([
      { text: "a {{b}} " },
      { ref: "trigger.name" },
    ]);
    // Without pills the text is a plain literal, `{{` and all.
    expect(partsToValue([{ text: "a {{b}}" }])).toBe("a {{b}}");
  });

  test("a { typed right before a pill round-trips (no broken reference)", () => {
    const parts = [{ text: "id={" }, { ref: "trigger.name" }, { text: "}" }];
    const value = partsToValue(parts);
    expect(value).toEqual({ $tpl: "id={{{trigger.name}}}" });
    expect(valueToParts(value)).toEqual(parts);
  });

  test("a single-line field keeps pasted text on one line", () => {
    const { onChange, view } = setup();
    act(() => {
      view().dispatch({ changes: { from: 0, insert: "a\nb" }, userEvent: "input.paste" });
    });
    expect(onChange).toHaveBeenLastCalledWith("a b");
  });

  test("singlePill: typing is ignored and a pick replaces the pill", async () => {
    const { onChange, view } = setup({ singlePill: true, value: { $ref: "trigger.name" } });
    act(() => typeInto(view(), "x"));
    expect(onChange).not.toHaveBeenCalled();
    focus();
    await screen.findByRole("tree");
    pickRow("amount");
    expect(onChange).toHaveBeenLastCalledWith({ $ref: "trigger.amount" });
    expect(pills()).toHaveLength(1);
    // The picker closes once the value is chosen.
    await waitFor(() => expect(screen.queryByRole("tree")).toBeNull());
  });

  test("literalOnly: no picker, and {{ stays text", () => {
    const { onChange, view } = setup({ literalOnly: true });
    focus();
    expect(screen.queryByRole("tree")).toBeNull();
    act(() => typeInto(view(), "{{trigger.name}}"));
    expect(onChange).toHaveBeenLastCalledWith("{{trigger.name}}");
    expect(pills()).toHaveLength(0);
  });

  test("a new value from outside replaces the content without echoing it back", () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <RefTextInput
        ariaLabel="Subject"
        scope={scope}
        samples={samples}
        value="one"
        onChange={onChange}
      />,
    );
    rerender(
      <RefTextInput
        ariaLabel="Subject"
        scope={scope}
        samples={samples}
        value={{ $ref: "trigger.name" }}
        onChange={onChange}
      />,
    );
    expect(editorView("Subject").state.doc.toString()).toBe("{{trigger.name}}");
    expect(pills()).toHaveLength(1);
    expect(onChange).not.toHaveBeenCalled();
  });

  test("the editor is labelled and described for screen readers", () => {
    setup();
    const content = document.querySelector(".cm-content") as HTMLElement;
    expect(content.getAttribute("aria-label")).toBe("Subject");
    expect(content.getAttribute("aria-multiline")).toBe("false");
    const hint = document.getElementById(content.getAttribute("aria-describedby") ?? "");
    expect(hint?.textContent).toBe("Type {{ to insert data, or press Down arrow to browse it.");
  });

  describe("undo and redo keep pills", () => {
    test("undoing a Backspace over a pill brings the pill back", () => {
      const { onChange, view } = setup({ value: { $tpl: "Hi {{trigger.name}}!" } });
      act(() => {
        view().dispatch({ selection: { anchor: view().state.doc.length - 1 } });
        deleteCharBackward(view());
      });
      expect(onChange).toHaveBeenLastCalledWith("Hi !");
      act(() => {
        undo(view());
      });
      expect(onChange).toHaveBeenLastCalledWith({ $tpl: "Hi {{trigger.name}}!" });
      expect(pills()).toHaveLength(1);
      act(() => {
        redo(view());
      });
      expect(onChange).toHaveBeenLastCalledWith("Hi !");
      act(() => {
        undo(view());
      });
      expect(onChange).toHaveBeenLastCalledWith({ $tpl: "Hi {{trigger.name}}!" });
    });

    test("undo and redo of picker inserts keep them pills, one pick per step", async () => {
      const { onChange, view } = setup();
      focus();
      await screen.findByRole("tree");
      pickRow("name");
      pickRow("amount");
      expect(onChange).toHaveBeenLastCalledWith({ $tpl: "{{trigger.name}}{{trigger.amount}}" });
      act(() => {
        undo(view());
      });
      expect(onChange).toHaveBeenLastCalledWith({ $ref: "trigger.name" });
      act(() => {
        redo(view());
      });
      expect(onChange).toHaveBeenLastCalledWith({ $tpl: "{{trigger.name}}{{trigger.amount}}" });
      expect(pills()).toHaveLength(2);
      act(() => {
        undo(view());
        undo(view());
        redo(view());
        redo(view());
      });
      expect(onChange).toHaveBeenLastCalledWith({ $tpl: "{{trigger.name}}{{trigger.amount}}" });
      expect(pills()).toHaveLength(2);
    });

    test("singlePill: undoing a pick restores the previous pill, never raw braces", async () => {
      const { onChange, view } = setup({ singlePill: true, value: { $ref: "trigger.name" } });
      focus();
      await screen.findByRole("tree");
      pickRow("amount");
      expect(onChange).toHaveBeenLastCalledWith({ $ref: "trigger.amount" });
      act(() => {
        undo(view());
      });
      expect(onChange).toHaveBeenLastCalledWith({ $ref: "trigger.name" });
      expect(pills()).toHaveLength(1);
      expect(document.querySelector(".cm-content")?.textContent).not.toContain("{{");
      act(() => {
        redo(view());
      });
      expect(onChange).toHaveBeenLastCalledWith({ $ref: "trigger.amount" });
      expect(document.querySelector(".cm-content")?.textContent).not.toContain("{{");
    });

    test("a value loaded from outside isn't undoable", () => {
      const onChange = vi.fn();
      const props = { ariaLabel: "Subject", scope, samples, onChange };
      const { rerender } = render(<RefTextInput {...props} value="step A value" />);
      rerender(<RefTextInput {...props} value="step B value" />);
      act(() => {
        undo(editorView("Subject"));
      });
      expect(editorView("Subject").state.doc.toString()).toBe("step B value");
      expect(onChange).not.toHaveBeenCalled();
      // Edits before an outside load don't undo into the new value either.
      act(() => typeInto(editorView("Subject"), "!"));
      rerender(<RefTextInput {...props} value={{ $ref: "trigger.name" }} />);
      onChange.mockClear();
      act(() => {
        undo(editorView("Subject"));
      });
      expect(onChange).not.toHaveBeenCalled();
      expect(pills()).toHaveLength(1);
    });
  });

  test("{{ ref }} with spaces, pasted or typed, becomes a pill", () => {
    const { onChange, view } = setup();
    act(() => {
      view().dispatch({
        changes: { from: 0, insert: "{{ trigger.amount }}" },
        userEvent: "input.paste",
      });
    });
    expect(onChange).toHaveBeenLastCalledWith({ $ref: "trigger.amount" });
    expect(pills()).toHaveLength(1);
    act(() => {
      view().dispatch({ selection: { anchor: view().state.doc.length } });
      typeInto(view(), " of {{ steps.load.email }}");
    });
    expect(onChange).toHaveBeenLastCalledWith({
      $tpl: "{{trigger.amount}} of {{steps.load.email}}",
    });
    expect(pills()).toHaveLength(2);
  });

  test("singlePill: pasting exactly one reference sets it", () => {
    const { onChange, view } = setup({ singlePill: true, value: { $ref: "trigger.name" } });
    act(() => {
      view().dispatch({
        changes: { from: 0, insert: " {{ trigger.amount }} " },
        userEvent: "input.paste",
      });
    });
    expect(onChange).toHaveBeenLastCalledWith({ $ref: "trigger.amount" });
    expect(pills()).toHaveLength(1);
    onChange.mockClear();
    act(() => {
      view().dispatch({ changes: { from: 0, insert: "not a ref" }, userEvent: "input.paste" });
    });
    expect(onChange).not.toHaveBeenCalled();
  });

  test("autocomplete reaches the farthest step of a large scope", async () => {
    const onChange = vi.fn();
    render(
      <RefTextInput
        ariaLabel="Subject"
        scope={bigScope()}
        samples={{}}
        value={undefined}
        onChange={onChange}
      />,
    );
    const view = editorView("Subject");
    act(() => typeInto(view, "{{s0.f39.b"));
    await waitFor(() => expect(currentCompletions(view.state).length).toBeGreaterThan(0));
    expect(currentCompletions(view.state)[0]?.label).toBe("Step 0 › f39.b");
  });

  test("a read-only field is still reachable from the keyboard", () => {
    setup({ readOnly: true, value: { $ref: "trigger.name" } });
    const content = document.querySelector(".cm-content") as HTMLElement;
    expect(content.getAttribute("contenteditable")).toBe("false");
    expect(content.getAttribute("tabindex")).toBe("0");
  });

  test("picking from the keyboard keeps focus in the picker for the next pick", async () => {
    const { onChange } = setup();
    focus();
    const search = await screen.findByRole("combobox", { name: "Search data" });
    search.focus();
    // Rows: Deal updated, name, amount…
    await userEvent.keyboard("{ArrowDown}{Enter}");
    expect(onChange).toHaveBeenLastCalledWith({ $ref: "trigger.name" });
    expect(document.activeElement).toBe(search);
    await userEvent.keyboard("{ArrowDown}{Enter}");
    expect(onChange).toHaveBeenLastCalledWith({ $tpl: "{{trigger.name}}{{trigger.amount}}" });
  });

  test("Escape closes the autocomplete without reaching an enclosing handler", async () => {
    const outer = vi.fn();
    render(
      // biome-ignore lint/a11y/noStaticElementInteractions: test harness
      <div onKeyDown={outer}>
        <RefTextInput
          ariaLabel="Subject"
          scope={scope}
          samples={samples}
          value={undefined}
          onChange={() => {}}
        />
      </div>,
    );
    const view = editorView("Subject");
    act(() => typeInto(view, "{{ema"));
    await waitFor(() => expect(currentCompletions(view.state).length).toBeGreaterThan(0));
    const content = document.querySelector(".cm-content") as HTMLElement;
    fireEvent.keyDown(content, { key: "Escape", keyCode: 27 });
    expect(currentCompletions(view.state)).toHaveLength(0);
    expect(outer).not.toHaveBeenCalled();
    // Nothing left to close: Escape goes on to the enclosing panel.
    fireEvent.keyDown(content, { key: "Escape", keyCode: 27 });
    expect(outer).toHaveBeenCalledTimes(1);
    expect(outer.mock.calls[0]?.[0].defaultPrevented).toBe(false);
  });

  test("Escape closes the picker without reaching an enclosing handler", async () => {
    const outer = vi.fn();
    const onChange = vi.fn();
    render(
      // biome-ignore lint/a11y/noStaticElementInteractions: test harness
      <div onKeyDown={outer}>
        <RefTextInput
          ariaLabel="Subject"
          scope={scope}
          samples={samples}
          value={undefined}
          onChange={onChange}
        />
      </div>,
    );
    focus();
    await screen.findByRole("tree");
    const content = document.querySelector(".cm-content") as HTMLElement;
    fireEvent.keyDown(content, { key: "Escape", keyCode: 27 });
    await waitFor(() => expect(screen.queryByRole("tree")).toBeNull());
    expect(outer).not.toHaveBeenCalled();
    fireEvent.keyDown(content, { key: "Escape", keyCode: 27 });
    expect(outer).toHaveBeenCalledTimes(1);
  });

  test("L10: Browse data has its own icon, not the {} of Edit as JSON", () => {
    render(
      <RefTextInput
        ariaLabel="Subject"
        scope={scope}
        samples={samples}
        value={undefined}
        onChange={() => {}}
      />,
    );
    const browse = screen.getByRole("button", { name: "Browse data", hidden: true });
    expect(browse.querySelector("svg")?.getAttribute("class")).toContain("lucide-variable");
  });

  describe("I1: the field's type decides what a click inserts", () => {
    const dealScope: ScopeEntry[] = [
      {
        refBase: "trigger",
        kind: "trigger",
        label: "Deal won",
        schema: {
          type: "object",
          properties: {
            deal: {
              type: "object",
              properties: { title: { type: "string" }, amount: { type: "number" } },
            },
            tags: { type: "array", items: { type: "string" } },
          },
        },
      },
      { refBase: "steps.fetch", kind: "step", stepId: "fetch", label: "Fetch", schema: {} },
    ];
    const dealSamples = {
      __trigger: { deal: { title: "Big", amount: 5 }, tags: ["a"] },
      fetch: { body: { total: 3 }, status: 200 },
    };
    const row = (name: string) =>
      screen.getAllByRole("treeitem").find((r) => r.textContent?.startsWith(name));

    test("a text field: clicking deal opens it instead of inserting it", async () => {
      const { onChange } = setup({
        scope: dealScope,
        samples: dealSamples,
        schema: { type: "string" },
      });
      focus();
      await screen.findByRole("tree");
      pickRow("deal");
      expect(onChange).not.toHaveBeenCalled();
      expect(row("deal")?.getAttribute("aria-expanded")).toBe("true");
      // An any-typed row whose sample is an object opens too.
      pickRow("body");
      expect(onChange).not.toHaveBeenCalled();
      pickRow("title");
      expect(onChange).toHaveBeenLastCalledWith({ $ref: "trigger.deal.title" });
    });

    test("a number field takes a text or number leaf but not a list", async () => {
      const { onChange } = setup({
        scope: dealScope,
        samples: dealSamples,
        schema: { type: "number" },
      });
      focus();
      await screen.findByRole("tree");
      pickRow("tags");
      expect(onChange).not.toHaveBeenCalled();
      pickRow("status");
      expect(onChange).toHaveBeenLastCalledWith({ $ref: "steps.fetch.status" });
    });

    test("a JSON (any-typed) field inserts deal whole", async () => {
      const { onChange } = setup({ scope: dealScope, samples: dealSamples, schema: {} });
      focus();
      await screen.findByRole("tree");
      pickRow("deal");
      expect(onChange).toHaveBeenLastCalledWith({ $ref: "trigger.deal" });
    });

    test("a list field inserts a list, and a text sample doesn't pass for one", async () => {
      const { onChange } = setup({
        scope: dealScope,
        samples: dealSamples,
        schema: { type: "array", items: { type: "string" } },
        singlePill: true,
      });
      focus();
      await screen.findByRole("tree");
      // Only rows that are (or lead to) a list are offered.
      expect(row("status")).toBeUndefined();
      pickRow("tags");
      expect(onChange).toHaveBeenLastCalledWith({ $ref: "trigger.tags" });
    });
  });

  describe("I4: Tab moves on from a picker field, never back into it", () => {
    function form() {
      render(
        <div className="fk-app">
          <div className="fk-panel">
            <input aria-label="Before" />
            <RefTextInput
              ariaLabel="Subject"
              scope={scope}
              samples={samples}
              value={undefined}
              onChange={() => {}}
            />
            <input aria-label="Timeout" />
          </div>
        </div>,
      );
    }
    const docked = () =>
      vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (
        this: Element,
      ) {
        if (this.classList.contains("fk-panel")) return DOMRect.fromRect({ x: 800, width: 400 });
        if (this.classList.contains("fk-app")) return DOMRect.fromRect({ x: 0, width: 1200 });
        return DOMRect.fromRect({ x: 816, y: 200, width: 368, height: 32 });
      });

    for (const mode of ["inline", "docked"] as const) {
      test(`${mode}: the search box isn't a Tab stop; Tab and Shift+Tab in it leave the field`, async () => {
        const rects = mode === "docked" ? docked() : undefined;
        try {
          form();
          focus();
          const search = await screen.findByRole("combobox", { name: "Search data" });
          expect(search.tabIndex).toBe(-1);
          expect(Boolean(search.closest(".fk-ref-inline"))).toBe(mode === "inline");
          search.focus();
          fireEvent.keyDown(search, { key: "Tab" });
          expect(document.activeElement).toBe(screen.getByLabelText("Timeout"));
          expect(screen.queryByRole("tree")).toBeNull();

          focus();
          const again = await screen.findByRole("combobox", { name: "Search data" });
          again.focus();
          fireEvent.keyDown(again, { key: "Tab", shiftKey: true });
          expect(document.activeElement).toBe(screen.getByLabelText("Before"));
          expect(screen.queryByRole("tree")).toBeNull();
        } finally {
          rects?.mockRestore();
        }
      });

      test(`${mode}: between ref fields, Tab and Shift+Tab reach the neighbouring editors`, async () => {
        const rects = mode === "docked" ? docked() : undefined;
        // Chrome reports tabIndex -1 for CodeMirror's contenteditable (no tabindex attribute).
        const tabIndex = vi
          .spyOn(HTMLElement.prototype, "tabIndex", "get")
          .mockImplementation(function (this: HTMLElement) {
            if (this.classList.contains("cm-content")) return -1;
            const attr = this.getAttribute("tabindex");
            if (attr !== null) return Number(attr);
            return /^(INPUT|BUTTON|SELECT|TEXTAREA|A)$/.test(this.tagName) ? 0 : -1;
          });
        const field = (label: string) => (
          <RefTextInput
            ariaLabel={label}
            scope={scope}
            samples={samples}
            value={undefined}
            onChange={() => {}}
          />
        );
        try {
          render(
            <div className="fk-app">
              <div className="fk-panel">
                {field("To")}
                {field("Subject")}
                {/* A Radix focus guard, as a portaled popover adds: never a destination. */}
                {/* biome-ignore lint/a11y/noNoninteractiveTabindex: Radix's guards are tabbable spans */}
                <span data-radix-focus-guard="" tabIndex={0} />
                {field("Body")}
              </div>
            </div>,
          );
          const content = (label: string) =>
            document.querySelector(`.cm-content[aria-label="${label}"]`) as HTMLElement;
          const openSubject = async () => {
            act(() => {
              fireEvent.focus(content("Subject"));
            });
            const search = await screen.findByRole("combobox", { name: "Search data" });
            search.focus();
            return search;
          };
          fireEvent.keyDown(await openSubject(), { key: "Tab" });
          expect(document.activeElement).toBe(content("Body"));
          act(() => {
            fireEvent.blur(content("Body"), { relatedTarget: null });
          });
          fireEvent.keyDown(await openSubject(), { key: "Tab", shiftKey: true });
          expect(document.activeElement).toBe(content("To"));
        } finally {
          tabIndex.mockRestore();
          rects?.mockRestore();
        }
      });
    }
  });

  describe("placement (H1): the picker never covers the next field", () => {
    function form() {
      render(
        <div className="fk-app">
          <div className="fk-panel">
            <RefTextInput
              ariaLabel="Subject"
              scope={scope}
              samples={samples}
              value={undefined}
              onChange={() => {}}
            />
            <input aria-label="Timeout" />
          </div>
        </div>,
      );
    }

    test("without room beside the panel it opens inline, before the next field", async () => {
      form();
      focus();
      const tree = await screen.findByRole("tree");
      const inline = tree.closest(".fk-ref-inline");
      expect(inline).toBeTruthy();
      expect(inline?.closest(".fk-ref-field")).toBeTruthy();
      const next = screen.getByLabelText("Timeout");
      // In the flow of the form, above the next field: it pushes it down rather than covering it.
      expect(inline?.compareDocumentPosition(next) ?? 0).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
      // Pressing inside the picker keeps focus in the field.
      const press = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
      inline?.querySelector(".fk-dp__foot")?.dispatchEvent(press);
      expect(press.defaultPrevented).toBe(true);
      // Moving to another field closes it.
      const content = document.querySelector(".cm-content") as HTMLElement;
      act(() => {
        fireEvent.blur(content, { relatedTarget: next });
      });
      expect(screen.queryByRole("tree")).toBeNull();
    });

    test("with room beside the panel it docks to the panel's left edge", async () => {
      const rects = vi
        .spyOn(Element.prototype, "getBoundingClientRect")
        .mockImplementation(function (this: Element) {
          if (this.classList.contains("fk-panel")) return DOMRect.fromRect({ x: 800, width: 400 });
          if (this.classList.contains("fk-app")) return DOMRect.fromRect({ x: 0, width: 1200 });
          return DOMRect.fromRect({ x: 816, y: 200, width: 368, height: 32 });
        });
      try {
        form();
        focus();
        const tree = await screen.findByRole("tree");
        const popover = tree.closest(".fk-ref-popover");
        expect(popover?.hasAttribute("data-docked")).toBe(true);
        expect(document.querySelector(".fk-ref-inline")).toBeNull();
        expect(popover?.closest(".fk-panel")).toBeNull();
      } finally {
        rects.mockRestore();
      }
    });
  });
});
