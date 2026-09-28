/**
 * `ConfigPanel`: the side panel of the selected step or trigger. A header (icon, click-to-rename
 * name, type, ID), then a Configure tab (the generated config form) and a Test tab (test the step,
 * or edit the trigger's sample data).
 *
 * @module
 */
import type { Issue } from "@flowkit/core";
import * as Tooltip from "@radix-ui/react-tooltip";
import { CircleOff, Copy, X } from "lucide-react";
import { type JSX, type KeyboardEvent, useEffect, useId, useMemo, useRef, useState } from "react";
import { nodeElement, nodeIdOf } from "../canvas/actions";
import { EditorContext, useEditorStore, useStep } from "../hooks";
import { useFlowkitAppearance } from "../provider";
import { type EditorStore, TRIGGER_KEY } from "../store/editor-store";
import { Hint } from "../ui/primitives";
import { IssueNotes } from "./fields/shell";
import { metaOf, propertiesOf, topKey } from "./schema";
import { SchemaForm } from "./schema-form";
import { TestStep } from "./test-step";
import { TriggerConfigure, TriggerSample, triggerIssues } from "./trigger-config";

type Tab = "configure" | "test";

/** The step or trigger's display name, editable in place (steps only). */
function PanelTitle({ selection }: { selection: string }): JSX.Element {
  const { labels } = useFlowkitAppearance();
  const info = useStep(selection);
  const rename = useEditorStore((s) => s.renameStep);
  const triggerName = useEditorStore((s) =>
    selection === TRIGGER_KEY
      ? s.manifest.triggers.find((t) => t.type === s.doc.trigger.type)?.name
      : undefined,
  );
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const buttonRef = useRef<HTMLButtonElement>(null);
  const refocus = useRef(false);
  useEffect(() => {
    if (!editing && refocus.current) {
      refocus.current = false;
      buttonRef.current?.focus();
    }
  }, [editing]);

  if (selection === TRIGGER_KEY || !info) {
    return (
      <h2 className="fk-cp__name">
        <span className="fk-cp__name-text" tabIndex={-1} data-autofocus>
          {selection === TRIGGER_KEY ? (triggerName ?? labels.triggerTag) : selection}
        </span>
      </h2>
    );
  }
  const shown = info.step.name ?? info.manifest?.name ?? info.step.type;
  const finish = (save: boolean) => {
    if (save) rename(selection, draft);
    refocus.current = true;
    setEditing(false);
  };
  if (editing) {
    return (
      <h2 className="fk-cp__name">
        <input
          className="fk-input fk-cp__name-input"
          aria-label={labels.renameStep}
          value={draft}
          placeholder={info.manifest?.name ?? info.step.type}
          // biome-ignore lint/a11y/noAutofocus: the input replaces the button the user just activated.
          autoFocus
          onFocus={(e) => e.currentTarget.select()}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => finish(true)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              finish(true);
            } else if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              finish(false);
            }
          }}
        />
      </h2>
    );
  }
  return (
    <h2 className="fk-cp__name">
      <Hint content={labels.renameStep}>
        <button
          ref={buttonRef}
          type="button"
          className="fk-cp__name-btn"
          data-autofocus
          aria-label={`${shown}, ${labels.renameStep}`}
          onClick={() => {
            setDraft(info.step.name ?? "");
            setEditing(true);
          }}
        >
          {shown}
        </button>
      </Hint>
    </h2>
  );
}

/** Icon, name, type and ID of the selection, with the close button. */
function PanelHeader({ selection, onClose }: { selection: string; onClose(): void }): JSX.Element {
  const { labels, resolveIcon } = useFlowkitAppearance();
  const info = useStep(selection);
  const trigger = useEditorStore((s) =>
    selection === TRIGGER_KEY
      ? s.manifest.triggers.find((t) => t.type === s.doc.trigger.type)
      : undefined,
  );
  const triggerType = useEditorStore((s) => s.doc.trigger.type);
  const isTrigger = selection === TRIGGER_KEY;
  const Icon = resolveIcon(isTrigger ? trigger?.icon : info?.manifest?.icon);
  const typeName = isTrigger ? labels.triggerTag : (info?.manifest?.name ?? info?.step.type ?? "");
  const [copied, setCopied] = useState(false);
  const showType = isTrigger || info?.step.name !== undefined || !info?.manifest;
  return (
    <div className="fk-panel__head fk-cp__head">
      <span className="fk-cp__icon" data-kind={isTrigger ? "trigger" : "step"} aria-hidden>
        <Icon size={18} />
      </span>
      <div className="fk-cp__titles">
        <PanelTitle selection={selection} />
        <div className="fk-cp__meta">
          {showType && <span className="fk-cp__type">{typeName}</span>}
          {!isTrigger && info && (
            <Hint content={copied ? labels.copied : info.step.id}>
              <button
                type="button"
                className="fk-cp__id"
                aria-label={labels.stepIdCaption(info.step.id)}
                onClick={() => {
                  try {
                    globalThis.navigator?.clipboard?.writeText(info.step.id).then(
                      () => {
                        setCopied(true);
                        setTimeout(() => setCopied(false), 1500);
                      },
                      () => {},
                    );
                  } catch {
                    // No clipboard; the ID is visible.
                  }
                }}
              >
                <span>{labels.stepIdCaption(info.step.id)}</span>
                <Copy size={11} aria-hidden />
              </button>
            </Hint>
          )}
          {isTrigger && !trigger && <span className="fk-cp__type">{triggerType}</span>}
        </div>
      </div>
      <button
        type="button"
        className="fk-icon-btn"
        aria-label={labels.closePanel}
        onClick={onClose}
      >
        <X size={16} aria-hidden />
      </button>
    </div>
  );
}

/** Issues the form can't place next to a field: no field, or a field the form doesn't show. */
function unclaimed(
  issues: readonly Issue[],
  schema: Parameters<typeof propertiesOf>[0] | undefined,
): Issue[] {
  if (!schema) return [...issues];
  const visible = new Set(
    propertiesOf(schema)
      .filter(([, s]) => !metaOf(s).hidden)
      .map(([k]) => k),
  );
  return issues.filter((i) => i.field === undefined || !visible.has(topKey(i.field)));
}

/** The Configure tab of a step. */
function StepConfigure({ stepId }: { stepId: string }): JSX.Element | null {
  const { labels } = useFlowkitAppearance();
  const info = useStep(stepId);
  const setConfig = useEditorStore((s) => s.setConfig);
  const toggleDisabled = useEditorStore((s) => s.toggleDisabled);
  const schema = info?.manifest?.input;
  const loose = useMemo(() => (info ? unclaimed(info.issues, schema) : []), [info, schema]);
  if (!info) return null;
  const { step, manifest } = info;
  const hasFields = schema !== undefined && propertiesOf(schema).some(([, s]) => !metaOf(s).hidden);
  return (
    <div className="fk-cp__section">
      {step.disabled && (
        <div className="fk-callout" data-tone="muted" role="note">
          <CircleOff size={15} aria-hidden />
          <p>{labels.disabledBanner}</p>
          <button
            type="button"
            className="fk-btn fk-btn--sm"
            onClick={() => toggleDisabled(stepId)}
          >
            {labels.enableStep}
          </button>
        </div>
      )}
      {manifest?.description && <p className="fk-cp__desc">{manifest.description}</p>}
      <IssueNotes issues={loose} />
      {!manifest ? (
        <p className="fk-empty-note">{labels.unknownNodeHelp}</p>
      ) : hasFields ? (
        <SchemaForm
          schema={manifest.input}
          value={step.config}
          onChange={(key, v) => setConfig(stepId, key, v)}
          stepId={stepId}
          issues={info.issues}
        />
      ) : (
        <p className="fk-empty-note">{labels.nothingToConfigure}</p>
      )}
    </div>
  );
}

/** Configure/Test tabs, with the issue count and the test state. */
function PanelTabs({
  selection,
  tab,
  onTab,
  ids,
}: {
  selection: string;
  tab: Tab;
  onTab(t: Tab): void;
  ids: Record<Tab, { tab: string; panel: string }>;
}): JSX.Element {
  const { labels } = useFlowkitAppearance();
  const info = useStep(selection);
  const allIssues = useEditorStore((s) => s.issues);
  // The store's test state is the one source of truth, shared with the canvas cards.
  const testState = useEditorStore((s) => s.testState[selection]);
  const issues = selection === TRIGGER_KEY ? triggerIssues(allIssues) : (info?.issues ?? []);
  const errors = issues.filter((i) => i.severity === "error").length;
  const count = issues.length;
  const tabs: Tab[] = ["configure", "test"];
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight" && e.key !== "Home" && e.key !== "End")
      return;
    e.preventDefault();
    const next: Tab =
      e.key === "Home"
        ? "configure"
        : e.key === "End"
          ? "test"
          : tab === "configure"
            ? "test"
            : "configure";
    onTab(next);
    document.getElementById(ids[next].tab)?.focus();
  };
  return (
    <div className="fk-tabs" role="tablist" aria-orientation="horizontal" onKeyDown={onKeyDown}>
      {tabs.map((t) => (
        <button
          key={t}
          id={ids[t].tab}
          type="button"
          role="tab"
          className="fk-tab"
          aria-selected={tab === t}
          aria-controls={ids[t].panel}
          tabIndex={tab === t ? 0 : -1}
          onClick={() => onTab(t)}
        >
          {t === "configure" ? labels.configureTab : labels.testTab}
          {t === "configure" && count > 0 && (
            <span className="fk-tab__badge" data-severity={errors > 0 ? "error" : "warning"}>
              {count}
              <span className="fk-sr-only"> {labels.issueCount(count)}</span>
            </span>
          )}
          {t === "test" && testState && (
            <span className="fk-tab__dot" data-state={testState} aria-hidden />
          )}
        </button>
      ))}
    </div>
  );
}

/**
 * The editor's side panel for the selected step or trigger. `store` is the editor store (as
 * passed to `WorkflowEditor`'s `renderPanel`); `onClose` runs on the close button and on Esc
 * (default: clear the selection). Renders nothing while nothing is selected.
 *
 * @example
 * <WorkflowEditor workflowId="welcome" renderPanel={(store) => <ConfigPanel store={store} />} />
 */
export function ConfigPanel({
  store,
  onClose,
}: {
  store: EditorStore;
  onClose?(): void;
}): JSX.Element | null {
  return (
    <EditorContext.Provider value={store}>
      <Tooltip.Provider delayDuration={300} skipDelayDuration={100}>
        <PanelContent store={store} {...(onClose ? { onClose } : {})} />
      </Tooltip.Provider>
    </EditorContext.Provider>
  );
}

function PanelContent({
  store,
  onClose,
}: {
  store: EditorStore;
  onClose?(): void;
}): JSX.Element | null {
  const selection = useEditorStore((s) => s.selection);
  const [tab, setTab] = useState<Tab>("configure");
  const rootRef = useRef<HTMLDivElement>(null);
  const base = useId();
  const ids = {
    configure: { tab: `${base}-tab-c`, panel: `${base}-panel-c` },
    test: { tab: `${base}-tab-t`, panel: `${base}-panel-t` },
  };
  if (selection === null) return null;

  const close = () => {
    if (onClose) {
      onClose();
      return;
    }
    const key = store.getState().selection;
    const app = rootRef.current?.closest<HTMLElement>(".fk-app") ?? null;
    store.getState().select(null);
    if (key)
      requestAnimationFrame(() => nodeElement(app, nodeIdOf(key))?.focus({ preventScroll: true }));
  };

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: Esc anywhere in the panel closes it.
    <div
      ref={rootRef}
      className="fk-panel__inner fk-cp"
      onKeyDown={(e) => {
        if (e.key !== "Escape" || e.defaultPrevented) return;
        if (!(e.target instanceof Node) || !rootRef.current?.contains(e.target)) return;
        e.preventDefault();
        close();
      }}
    >
      <PanelHeader key={`h:${selection}`} selection={selection} onClose={close} />
      <PanelTabs selection={selection} tab={tab} onTab={setTab} ids={ids} />
      <div
        key={`b:${selection}:${tab}`}
        className="fk-panel__body fk-cp__body"
        role="tabpanel"
        id={ids[tab].panel}
        aria-labelledby={ids[tab].tab}
      >
        {selection === TRIGGER_KEY ? (
          tab === "configure" ? (
            <TriggerConfigure />
          ) : (
            <TriggerSample />
          )
        ) : tab === "configure" ? (
          <StepConfigure stepId={selection} />
        ) : (
          <TestStep stepId={selection} />
        )}
      </div>
    </div>
  );
}
