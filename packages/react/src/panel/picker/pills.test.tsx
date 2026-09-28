import { deleteCharBackward } from "@codemirror/commands";
import { act, cleanup, render } from "@testing-library/react";
import { beforeAll, describe, expect, test, vi } from "vitest";
import { editorView, setupCodeMirrorDom, typeInto } from "../../../test/codemirror-dom";
import { samples, scope } from "../../../test/picker-fixtures";
import { RefTextInput } from "../ref-text-input";

// Count React roots: every root created must be unmounted again.
const roots = vi.hoisted(() => ({ live: 0 }));
vi.mock("react-dom/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-dom/client")>();
  return {
    ...actual,
    createRoot: (...args: Parameters<typeof actual.createRoot>) => {
      const root = actual.createRoot(...args);
      roots.live++;
      const unmount = root.unmount.bind(root);
      root.unmount = () => {
        roots.live--;
        unmount();
      };
      return root;
    },
  };
});

beforeAll(setupCodeMirrorDom);

describe("pill widgets", () => {
  test("hold no React roots, however often they are redrawn", async () => {
    const before = roots.live;
    render(
      <RefTextInput
        ariaLabel="Subject"
        scope={scope}
        samples={samples}
        value={{ $tpl: "{{trigger.name}} {{steps.load.email}} {{trigger.amount}}" }}
        onChange={() => {}}
      />,
    );
    const view = editorView("Subject");
    act(() => {
      view.dispatch({ selection: { anchor: 0 } });
      typeInto(view, "twenty characters...");
      for (let i = 0; i < 20; i++) {
        view.dispatch({ selection: { anchor: 20 - i } });
        deleteCharBackward(view);
      }
    });
    // Pills hold no roots (CodeMirror may reuse a widget’s DOM without destroying the widget,
    // so a root per pill could never be reliably unmounted); icon markup is rendered and freed.
    expect(roots.live - before).toBe(0);
    // The pills carry their icons (filled in a microtask the first time an icon is used).
    await new Promise((r) => setTimeout(r, 0));
    expect(document.querySelectorAll(".fl-ref-pill__icon svg")).toHaveLength(3);
    expect(roots.live - before).toBe(0);
    cleanup();
  });
});
