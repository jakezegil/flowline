/**
 * The reference input: a CodeMirror field where text and reference pills mix. Focusing it
 * opens the data picker; typing `{{` autocompletes over the same values. In a config panel with
 * room beside it the picker docks to the panel's left edge, level with the field; elsewhere (a
 * narrow panel, a bottom sheet, a form on its own) it opens inline under the field and pushes
 * the next fields down. Either way it never covers another field.
 *
 * @module
 */

import { completionStatus } from "@codemirror/autocomplete";
import { history, historyKeymap, standardKeymap } from "@codemirror/commands";
import {
  Annotation,
  Compartment,
  EditorState,
  type Extension,
  Prec,
  Transaction,
} from "@codemirror/state";
import {
  closeHoverTooltips,
  EditorView,
  keymap,
  placeholder as placeholderExt,
  tooltips,
} from "@codemirror/view";
import { parseRefPath, type ScopeEntry, type ValueExpr } from "@flowkit/core";
import * as Popover from "@radix-ui/react-popover";
import { Braces } from "lucide-react";
import {
  type JSX,
  type KeyboardEvent,
  type MouseEvent,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { PortalContainerContext } from "../canvas/canvas-context";
import { useFlowkitAppearance } from "../provider";
import { DataPickerView, type PickerExit, type PickVia } from "./data-picker";
import { refInputTheme } from "./picker/editor-theme";
import { jsonToParts, partsToJson } from "./picker/json-parts";
import {
  addPill,
  docParts,
  insertPill,
  type PillResolver,
  partsToDoc,
  pillResolver,
  pillsFor,
  setPillHover,
  setPills,
} from "./picker/pills";
import {
  type RefCompletionSource,
  refAutocomplete,
  refCompletionSource,
} from "./picker/ref-completion";
import { findRefs, partsToValue, pillInfo, valueKey, valueToParts } from "./picker/ref-model";
import { flattenTree, formatSample } from "./picker/schema-tree";

/** Room the docked picker needs to the left of the panel: its width and a gap. */
const DOCK_ROOM = 356;

/** The rectangle the picker docks to: the panel's left edge, level with the field. */
type DockRect = () => DOMRect;

/**
 * Where to dock the picker of the field `field`: beside the config panel holding it, when the
 * panel has {@link DOCK_ROOM} to its left inside the app (not a bottom sheet or a narrow app).
 */
function dockBeside(field: HTMLElement): DockRect | undefined {
  const panel = field.closest(".fk-panel");
  if (!panel) return undefined;
  const app = panel.closest(".fk-app") ?? document.documentElement;
  const p = panel.getBoundingClientRect();
  if (p.width === 0 || p.left - app.getBoundingClientRect().left < DOCK_ROOM) return undefined;
  return () => {
    const edge = panel.getBoundingClientRect().left;
    const f = field.getBoundingClientRect();
    return DOMRect.fromRect({ x: edge, y: f.top, width: 0, height: f.height });
  };
}

/** Marks a transaction that loads a value from props (not a user edit, so not emitted). */
const external = Annotation.define<boolean>();

/** Sample value at a ref path (trigger → the `__trigger` sample, steps → the step's sample). */
function sampleAtRef(
  ref: string,
  samples: Record<string, unknown>,
): { value: unknown } | undefined {
  let path: ReturnType<typeof parseRefPath>;
  try {
    path = parseRefPath(ref);
  } catch {
    return undefined;
  }
  const key =
    path.root === "trigger" ? "__trigger" : path.root === "steps" ? path.stepId : undefined;
  if (key === undefined || !Object.hasOwn(samples, key)) return undefined;
  let cur: unknown = samples[key];
  for (const seg of path.segments) {
    if (cur === null || typeof cur !== "object" || !Object.hasOwn(cur, seg)) return undefined;
    cur = (cur as Record<string | number, unknown>)[seg];
  }
  return { value: cur };
}

/** A transaction filter keeping a single-line field on one line (pasted newlines → spaces). */
const singleLine = EditorState.transactionFilter.of((tr) => {
  if (!tr.docChanged || tr.newDoc.lines === 1) return tr;
  const changes: { from: number; to: number; insert: string }[] = [];
  tr.changes.iterChanges((fromA, toA, _fb, _tb, inserted) => {
    changes.push({ from: fromA, to: toA, insert: inserted.toString().replace(/\r?\n/g, " ") });
  });
  const userEvent = tr.annotation(Transaction.userEvent);
  return [
    {
      changes,
      ...(tr.selection ? { selection: tr.selection } : {}),
      effects: tr.effects,
      ...(userEvent !== undefined ? { userEvent } : {}),
      annotations: [
        ...(tr.annotation(external) ? [external.of(true)] : []),
        ...(tr.annotation(Transaction.addToHistory) === false
          ? [Transaction.addToHistory.of(false)]
          : []),
      ],
    },
  ];
});

/**
 * In a single-pill field only pills go in: typed text is dropped, and a paste is kept only if
 * it is exactly one reference (which then replaces the pill).
 */
const pillOnly = EditorState.transactionFilter.of((tr) => {
  if (
    !tr.docChanged ||
    tr.annotation(external) ||
    tr.isUserEvent("input.complete") ||
    tr.isUserEvent("delete")
  )
    return tr;
  if (tr.isUserEvent("undo") || tr.isUserEvent("redo")) return tr;
  if (tr.isUserEvent("input.paste") || tr.isUserEvent("input.drop")) {
    let pasted = "";
    tr.changes.iterChanges((_fa, _ta, _fb, _tb, inserted) => {
      pasted += inserted.toString();
    });
    const text = pasted.trim();
    const [only, ...more] = findRefs(text);
    if (only && more.length === 0 && only[0] === 0 && only[1] === text.length) {
      const insert = `{{${only[2]}}}`;
      return {
        changes: { from: 0, to: tr.startState.doc.length, insert },
        effects: addPill.of({ from: 0, to: insert.length, ref: only[2] }),
        selection: { anchor: insert.length },
        userEvent: "input.complete",
      };
    }
  }
  return [];
});

/** The editor's text and pills for a value, in the field's mode. */
function docOf(
  value: ValueExpr | undefined,
  literalOnly: boolean,
  json: boolean,
): { doc: string; pills: { from: number; to: number; ref: string }[] } {
  if (literalOnly) {
    const doc = json
      ? value === undefined
        ? ""
        : JSON.stringify(value, null, 2)
      : valueToParts(value, true)
          .map((p) => ("text" in p ? p.text : ""))
          .join("");
    return { doc, pills: [] };
  }
  return partsToDoc(json ? jsonToParts(value) : valueToParts(value));
}

/** JSON text in the mono font of code. */
const jsonTheme = EditorView.theme({
  ".cm-content": { fontFamily: "var(--fk-font-mono)", fontSize: "12px" },
});

/**
 * A text field that mixes literal text with references to upstream data, shown as pills.
 * Emits a literal string for plain text, `{ $ref }` for exactly one pill and nothing else, and
 * `{ $tpl }` for any mix (`undefined` when empty).
 *
 * - `singlePill`: holds at most one pill and no text, emitting `{ $ref }` (reference mode of
 *   number, boolean and enum fields, and `refOnly` fields).
 * - `literalOnly`: plain text only, no pills and no picker.
 * - `invalidRefs`: references to show as stale (warning-styled); references that don't resolve
 *   in `scope` are shown stale too.
 * - `json`: the content is JSON (any value), with pills standing for `{ $ref }` values and
 *   strings holding pills for `{ $tpl }` values. Text that isn't valid JSON isn't emitted;
 *   `onJsonError` hears whether the content currently parses.
 */
export function RefTextInput(props: {
  value: ValueExpr | undefined;
  onChange(v: ValueExpr | undefined): void;
  scope: ScopeEntry[];
  samples: Record<string, unknown>;
  multiline?: boolean;
  placeholder?: string;
  invalidRefs?: Set<string>;
  ariaLabel: string;
  singlePill?: boolean;
  literalOnly?: boolean;
  readOnly?: boolean;
  json?: boolean;
  onJsonError?(invalid: boolean): void;
}): JSX.Element {
  const {
    value,
    scope,
    samples,
    multiline = false,
    placeholder,
    invalidRefs,
    ariaLabel,
    singlePill = false,
    literalOnly = false,
    readOnly = false,
    json = false,
  } = props;
  const onJsonErrorRef = useRef(props.onJsonError);
  onJsonErrorRef.current = props.onJsonError;
  const { labels, resolveIcon } = useFlowkitAppearance();
  const portal = useContext(PortalContainerContext);
  const id = useId();
  const pickerId = `${id}picker`;
  const hintId = `${id}hint`;

  const fieldRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(props.onChange);
  onChangeRef.current = props.onChange;
  const lastKey = useRef(valueKey(value));

  const [open, setOpen] = useState(false);
  const openRef = useRef(false);
  openRef.current = open;
  const [completing, setCompleting] = useState(false);
  const [focused, setFocused] = useState(false);
  /** Set while focus returns to the editor from the picker, so it doesn't reopen it. */
  const quietFocus = useRef(false);

  const withPicker = !literalOnly && !readOnly;
  const pickerOpen = withPicker && open && !completing;

  // Docked beside the panel, or inline under the field: decided each time the picker opens.
  const [dock, setDock] = useState<DockRect | null>(null);
  const dockRef = useRef<DockRect | null>(null);
  dockRef.current = dock;
  useLayoutEffect(() => {
    const field = fieldRef.current;
    setDock(() => (pickerOpen && field ? (dockBeside(field) ?? null) : null));
  }, [pickerOpen]);
  const anchor = useRef({
    getBoundingClientRect: () =>
      dockRef.current?.() ?? fieldRef.current?.getBoundingClientRect() ?? DOMRect.fromRect(),
    // Scrolling the panel moves the field: the popover follows its scroll parents.
    get contextElement() {
      return fieldRef.current ?? undefined;
    },
  });

  const resolver = useMemo<PillResolver>(
    () => ({
      info: (ref) => pillInfo(ref, scope, invalidRefs, labels),
      icon: resolveIcon,
      ariaLabel: (info) =>
        info.stale ? labels.refStale(info.label) : labels.refPill(info.label, info.type),
      staleHint: labels.staleRefHint,
      sampleLabel: labels.sampleValue,
      sample: (ref) => {
        const s = sampleAtRef(ref, samples);
        return s ? formatSample(s.value, labels, 60) : undefined;
      },
    }),
    [scope, samples, invalidRefs, labels, resolveIcon],
  );
  const completionSource = useMemo<RefCompletionSource>(() => {
    let nodes: ReturnType<typeof flattenTree> | undefined;
    return {
      nodes: () => {
        nodes ??= flattenTree(scope, samples);
        return nodes;
      },
      icon: resolveIcon,
      sample: (node) => (node.sample ? formatSample(node.sample.value, labels, 32) : undefined),
    };
  }, [scope, samples, labels, resolveIcon]);

  const compartments = useRef({
    resolver: new Compartment(),
    completion: new Compartment(),
    attrs: new Compartment(),
    editable: new Compartment(),
    placeholder: new Compartment(),
  });

  const emit = (state: EditorState) => {
    let next: ValueExpr | undefined;
    if (json) {
      const read = literalOnly
        ? partsToJson([{ text: state.doc.toString() }])
        : partsToJson(docParts(state));
      onJsonErrorRef.current?.(!read.ok);
      // Invalid JSON stays in the editor (and out of the value) until it parses again.
      if (!read.ok) return;
      next = read.value;
    } else if (literalOnly) {
      const text = state.doc.toString();
      next = text === "" ? undefined : text;
    } else {
      next = partsToValue(docParts(state));
      if (
        singlePill &&
        next !== undefined &&
        !(typeof next === "object" && next !== null && "$ref" in next)
      ) {
        next = undefined;
      }
    }
    lastKey.current = valueKey(next);
    onChangeRef.current(next);
  };
  const emitRef = useRef(emit);
  emitRef.current = emit;

  const attrs = () =>
    EditorView.contentAttributes.of({
      "aria-label": ariaLabel,
      "aria-multiline": multiline ? "true" : "false",
      // Read-only content isn't editable, so it isn't focusable either unless told to be.
      ...(readOnly ? { tabindex: "0" } : {}),
      ...(withPicker ? { "aria-describedby": hintId, "aria-controls": pickerId } : {}),
    });
  const placeholderText = placeholder ?? (singlePill ? labels.pickValue : "");

  // Create the editor once; props flow in through compartments below.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the editor is created once per mode
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const c = compartments.current;
    const { doc, pills } = docOf(value, literalOnly, json);
    const extensions: Extension[] = [
      refInputTheme,
      ...(json ? [jsonTheme] : []),
      history(),
      EditorView.lineWrapping,
      c.attrs.of(attrs()),
      c.editable.of([EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)]),
      c.placeholder.of(placeholderText ? placeholderExt(placeholderText) : []),
      Prec.high(
        keymap.of([
          ...(multiline ? [] : [{ key: "Enter", run: () => true }]),
          {
            key: multiline ? "Alt-ArrowDown" : "ArrowDown",
            run: () => {
              if (!withPicker) return false;
              setOpen(true);
              // The popover mounts on open; focus its search box once it's there.
              requestAnimationFrame(() => searchRef.current?.focus());
              return true;
            },
          },
          {
            key: "Escape",
            run: () => {
              if (!openRef.current) return false;
              setOpen(false);
              return true;
            },
          },
        ]),
      ),
      keymap.of([...standardKeymap, ...historyKeymap]),
      EditorView.updateListener.of((update) => {
        const isCompleting = completionStatus(update.state) !== null;
        if (isCompleting !== (completionStatus(update.startState) !== null))
          setCompleting(isCompleting);
        if (!update.docChanged) return;
        if (update.transactions.every((tr) => tr.annotation(external))) return;
        emitRef.current(update.state);
      }),
    ];
    if (!multiline) extensions.push(singleLine);
    if (!literalOnly) {
      extensions.push(pillsFor(pills), c.resolver.of(pillResolver.of(resolver)));
      if (singlePill) extensions.push(pillOnly);
      else {
        extensions.push(
          refAutocomplete(),
          c.completion.of(refCompletionSource.of(completionSource)),
          ...(portal ? [tooltips({ parent: portal })] : []),
        );
      }
    }
    const view = new EditorView({ parent: host, state: EditorState.create({ doc, extensions }) });
    viewRef.current = view;
    lastKey.current = valueKey(value);
    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, [multiline, singlePill, literalOnly, json, portal]);

  // Props → editor.
  useEffect(() => {
    viewRef.current?.dispatch({
      effects: compartments.current.resolver.reconfigure(pillResolver.of(resolver)),
    });
  }, [resolver]);
  useEffect(() => {
    viewRef.current?.dispatch({
      effects: compartments.current.completion.reconfigure(
        refCompletionSource.of(completionSource),
      ),
    });
  }, [completionSource]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: attrs() reads exactly these
  useEffect(() => {
    viewRef.current?.dispatch({ effects: compartments.current.attrs.reconfigure(attrs()) });
  }, [ariaLabel, withPicker, hintId, pickerId, multiline, readOnly]);
  useEffect(() => {
    viewRef.current?.dispatch({
      effects: [
        compartments.current.editable.reconfigure([
          EditorState.readOnly.of(readOnly),
          EditorView.editable.of(!readOnly),
        ]),
        compartments.current.placeholder.reconfigure(
          placeholderText ? placeholderExt(placeholderText) : [],
        ),
      ],
    });
  }, [readOnly, placeholderText]);
  useEffect(() => {
    const view = viewRef.current;
    if (!view || valueKey(value) === lastKey.current) return;
    lastKey.current = valueKey(value);
    const { doc, pills } = docOf(value, literalOnly, json);
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: doc },
      ...(literalOnly ? {} : { effects: setPills.of(pills) }),
      // Not an edit of the user's: undo mustn't bring back the value it replaced.
      annotations: [external.of(true), Transaction.addToHistory.of(false)],
    });
    // A value from outside (e.g. undo) replaces any unparsed JSON draft.
    if (json) onJsonErrorRef.current?.(false);
  }, [value, literalOnly, json]);

  // A pill's hover card would sit over the picker: none while it's open.
  useEffect(() => {
    const view = viewRef.current;
    if (!view || literalOnly) return;
    view.dispatch({
      effects: pickerOpen ? [setPillHover.of(false), closeHoverTooltips] : setPillHover.of(true),
    });
  }, [pickerOpen, literalOnly]);

  const focusEditor = () => {
    quietFocus.current = true;
    viewRef.current?.focus();
    quietFocus.current = false;
  };

  const onPick = (ref: string, _type: string, via: PickVia = "pointer") => {
    const view = viewRef.current;
    if (!view) return;
    if (singlePill) {
      insertPill(view, ref, { from: 0, to: view.state.doc.length });
      setOpen(false);
      focusEditor();
    } else {
      insertPill(view, ref);
      // A keyboard pick keeps its place in the tree for the next one.
      if (via === "pointer") focusEditor();
    }
  };

  const onExit = (reason: PickerExit) => {
    if (reason !== "up") setOpen(false);
    focusEditor();
  };

  const inside = (node: EventTarget | null) =>
    node instanceof Node &&
    (fieldRef.current?.contains(node) || contentRef.current?.contains(node));

  /** Pressing in the picker (not its search box) keeps focus where it is. */
  const keepFocus = (e: MouseEvent<HTMLElement>) => {
    if (e.target !== searchRef.current) e.preventDefault();
  };

  const picker = (
    <DataPickerView
      id={pickerId}
      scope={scope}
      samples={samples}
      onPick={onPick}
      onExit={onExit}
      searchRef={searchRef}
    />
  );

  const onKeyDown = (e: KeyboardEvent) => {
    // An Escape the field or picker used (closing the picker or autocomplete) stops here, so it
    // doesn't also close an enclosing panel.
    if (e.key === "Escape" && e.defaultPrevented) e.stopPropagation();
  };

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: focus tracking for the field and its popover
    <div
      className="fk-ref-field"
      onFocus={() => {
        setFocused(true);
        if (!quietFocus.current && withPicker) setOpen(true);
      }}
      onBlur={(e) => {
        if (inside(e.relatedTarget)) return;
        setFocused(false);
        setOpen(false);
      }}
      onKeyDown={onKeyDown}
    >
      <Popover.Root open={pickerOpen && dock !== null} onOpenChange={(o) => !o && setOpen(false)}>
        <Popover.Anchor virtualRef={anchor} />
        <div
          ref={fieldRef}
          className="fk-ref"
          data-multiline={multiline || undefined}
          data-focused={focused || undefined}
          data-readonly={readOnly || undefined}
          data-single={singlePill || undefined}
        >
          <div ref={hostRef} className="fk-ref__editor" />
          {withPicker && (
            <button
              type="button"
              className="fk-ref__browse"
              tabIndex={-1}
              aria-label={labels.browseData}
              aria-expanded={pickerOpen}
              aria-controls={pickerId}
              title={labels.browseData}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                const view = viewRef.current;
                if (!view) return;
                if (!view.hasFocus) view.focus();
                else setOpen((o) => !o);
              }}
            >
              <Braces size={13} aria-hidden />
            </button>
          )}
        </div>
        {pickerOpen && dock === null && (
          // biome-ignore lint/a11y/noStaticElementInteractions: keeps focus in the field while picking
          <div ref={contentRef} className="fk-ref-inline" onMouseDown={keepFocus}>
            {picker}
          </div>
        )}
        {withPicker && (
          <span id={hintId} className="fk-sr-only">
            {singlePill ? labels.refPickHint : labels.refInputHint(multiline)}
          </span>
        )}
        {withPicker && (
          <Popover.Portal container={portal}>
            <Popover.Content
              ref={contentRef}
              className="fk-ref-popover"
              data-docked=""
              side="left"
              align="start"
              sideOffset={8}
              collisionPadding={8}
              onMouseDown={keepFocus}
              onOpenAutoFocus={(e) => e.preventDefault()}
              onCloseAutoFocus={(e) => e.preventDefault()}
              // Escape is handled here, before the editor or picker see it: in the field it
              // closes the picker; in the picker, the picker's own handler clears the search or
              // returns to the field. Either way the key is marked used, so an enclosing panel
              // doesn't close too (see onKeyDown above).
              onEscapeKeyDown={(e) => {
                e.preventDefault();
                if (!(e.target instanceof Node && contentRef.current?.contains(e.target)))
                  setOpen(false);
              }}
              onInteractOutside={(e) => {
                if (inside(e.target)) e.preventDefault();
              }}
            >
              {picker}
            </Popover.Content>
          </Popover.Portal>
        )}
      </Popover.Root>
    </div>
  );
}
