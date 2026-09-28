/**
 * The `code` widget: a CodeMirror JavaScript editor whose completions know the data in scope
 * (`steps.<id>.<field>`, `trigger.<field>`, `loop.item`).
 *
 * @module
 */

import {
  autocompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult,
  completionKeymap,
} from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { javascript, localCompletionSource } from "@codemirror/lang-javascript";
import { bracketMatching, indentOnInput } from "@codemirror/language";
import { Annotation, Compartment, EditorState, Facet, Transaction } from "@codemirror/state";
import {
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
  tooltips,
} from "@codemirror/view";
import { type JSONSchema, type ScopeEntry, schemaAtPath } from "@flowkit/core";
import { type JSX, useContext, useEffect, useId, useRef } from "react";
import { PortalContainerContext } from "../canvas/canvas-context";
import { useFlowkitAppearance } from "../provider";
import { codeEditorTheme } from "./picker/editor-theme";
import { shortType } from "./picker/schema-tree";

/** Marks a transaction that loads `value` from props (not emitted back). */
const fromProps = Annotation.define<boolean>();

/** The scope the code completions draw from. */
const codeScope = Facet.define<ScopeEntry[], ScopeEntry[]>({
  combine: (values) => values[values.length - 1] ?? [],
});

/** Property names of an object schema (declared ones; unions merged). */
function propertiesOf(schema: JSONSchema | undefined): [string, JSONSchema][] {
  if (!schema) return [];
  const out = new Map<string, JSONSchema>();
  const visit = (s: unknown, depth: number) => {
    if (typeof s !== "object" || s === null || depth > 6) return;
    const obj = s as JSONSchema;
    const props = obj.properties;
    if (props && typeof props === "object") {
      for (const [k, v] of Object.entries(props as Record<string, unknown>)) {
        if (!out.has(k)) out.set(k, (typeof v === "object" && v !== null ? v : {}) as JSONSchema);
      }
    }
    for (const key of ["anyOf", "oneOf", "allOf"] as const) {
      const members = obj[key];
      if (Array.isArray(members)) for (const m of members) visit(m, depth + 1);
    }
  };
  visit(schema, 0);
  return [...out];
}

/** Completions for the member path before the cursor: `steps.`, `steps.load.`, `trigger.a.`… */
export function scopeCompletions(context: CompletionContext): CompletionResult | null {
  const scope = context.state.facet(codeScope);
  const word = context.matchBefore(/[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*|\[\d+\])*\.?[\w$]*$/);
  if (!word) return null;
  const text = word.text;
  const dot = text.lastIndexOf(".");
  const from = dot === -1 ? word.from : word.from + dot + 1;
  if (dot === -1) {
    if (!context.explicit && text.length < 1) return null;
    const roots: Completion[] = [
      { label: "trigger", type: "variable", detail: "trigger payload" },
      { label: "steps", type: "variable", detail: "step outputs" },
      ...(scope.some((e) => e.kind === "loop")
        ? [{ label: "loop", type: "variable", detail: "{ item, index }" }]
        : []),
    ];
    return { from, options: roots, validFor: /^[\w$]*$/ };
  }
  const path = text.slice(0, dot);
  const segments: (string | number)[] = [];
  for (const m of path.matchAll(/([A-Za-z_$][\w$]*)|\[(\d+)\]/g)) {
    segments.push(m[1] !== undefined ? m[1] : Number(m[2]));
  }
  const [root, ...rest] = segments;
  let schema: JSONSchema | undefined;
  if (root === "steps") {
    if (rest.length === 0) {
      const options = scope
        .filter((e) => e.kind === "step" && e.stepId)
        .map((e) => ({ label: e.stepId as string, type: "property", detail: e.label }));
      return { from, options, validFor: /^[\w$]*$/ };
    }
    const [stepId, ...tail] = rest;
    const entry = [...scope].reverse().find((e) => e.kind === "step" && e.stepId === stepId);
    schema = entry ? schemaAtPath(entry.schema, tail) : undefined;
  } else if (root === "trigger" || root === "loop") {
    const entry = [...scope].reverse().find((e) => e.kind === root);
    schema = entry ? schemaAtPath(entry.schema, rest) : undefined;
  } else {
    return null;
  }
  const options = propertiesOf(schema).map(([name, s]) => ({
    label: name,
    type: "property",
    detail: shortType(s),
  }));
  if (options.length === 0) return null;
  return { from, options, validFor: /^[\w$]*$/ };
}

/**
 * A JavaScript editor for the `code` widget. Completions offer `trigger`, `steps` and (in a
 * loop) `loop`, then the fields of each from `scope`.
 */
export function CodeEditor(props: {
  value: string;
  onChange(v: string): void;
  scope: ScopeEntry[];
  ariaLabel: string;
  readOnly?: boolean;
}): JSX.Element {
  const { value, scope, ariaLabel, readOnly = false } = props;
  const { labels } = useFlowkitAppearance();
  const portal = useContext(PortalContainerContext);
  const hintId = `${useId()}hint`;
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(props.onChange);
  onChangeRef.current = props.onChange;
  const lastValue = useRef(value);
  const compartments = useRef({
    scope: new Compartment(),
    editable: new Compartment(),
    attrs: new Compartment(),
  });

  const attrs = () =>
    EditorView.contentAttributes.of({ "aria-label": ariaLabel, "aria-describedby": hintId });

  // biome-ignore lint/correctness/useExhaustiveDependencies: created once; props flow in below
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const c = compartments.current;
    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: value,
        extensions: [
          codeEditorTheme,
          lineNumbers(),
          highlightActiveLine(),
          highlightActiveLineGutter(),
          history(),
          indentOnInput(),
          bracketMatching(),
          javascript(),
          autocompletion({ override: [scopeCompletions, localCompletionSource], icons: false }),
          ...(portal ? [tooltips({ parent: portal })] : []),
          keymap.of([...completionKeymap, ...defaultKeymap, ...historyKeymap, indentWithTab]),
          c.scope.of(codeScope.of(scope)),
          c.editable.of([EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)]),
          c.attrs.of(attrs()),
          EditorView.updateListener.of((update) => {
            if (!update.docChanged) return;
            if (update.transactions.every((tr) => tr.annotation(fromProps))) return;
            const next = update.state.doc.toString();
            lastValue.current = next;
            onChangeRef.current(next);
          }),
        ],
      }),
    });
    viewRef.current = view;
    lastValue.current = value;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, [portal]);

  useEffect(() => {
    viewRef.current?.dispatch({
      effects: compartments.current.scope.reconfigure(codeScope.of(scope)),
    });
  }, [scope]);
  useEffect(() => {
    viewRef.current?.dispatch({
      effects: compartments.current.editable.reconfigure([
        EditorState.readOnly.of(readOnly),
        EditorView.editable.of(!readOnly),
      ]),
    });
  }, [readOnly]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: attrs() reads exactly these
  useEffect(() => {
    viewRef.current?.dispatch({ effects: compartments.current.attrs.reconfigure(attrs()) });
  }, [ariaLabel, hintId]);
  useEffect(() => {
    const view = viewRef.current;
    if (!view || value === lastValue.current) return;
    lastValue.current = value;
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: value },
      // Not the user’s edit: undo mustn’t bring back the code it replaced.
      annotations: [fromProps.of(true), Transaction.addToHistory.of(false)],
    });
  }, [value]);

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: keeps Escape inside the editor
    <div
      className="fk-code"
      data-readonly={readOnly || undefined}
      onKeyDown={(e) => {
        // Escape in the editor closes its completions, or releases its hold on Tab ("press
        // Escape, then Tab, to leave the editor"): it never also closes an enclosing panel.
        // Once Tab has left the editor, Escape closes the panel as usual.
        if (e.key === "Escape") e.stopPropagation();
      }}
    >
      <div ref={hostRef} className="fk-code__editor" />
      <span id={hintId} className="fk-sr-only">
        {labels.codeEditorHint}
      </span>
    </div>
  );
}
