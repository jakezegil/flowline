import type { Issue } from "@flowkit/core";
import { LoaderCircle, Play, Redo2, Undo2 } from "lucide-react";
import { type JSX, type ReactNode, useEffect, useRef, useState } from "react";
import { isMac } from "../canvas/keyboard";
import { useEditorStore, useEditorStoreApi, useIssues, useShallow } from "../hooks";
import { useFlowkit, useFlowkitAppearance } from "../provider";
import { errorText, Hint, httpStatus, isNetworkError } from "../ui/primitives";
import { useToast } from "../ui/toaster";
import { IssuesPill, issueTargets } from "./issues-pill";
import { manualFields, RunDialog } from "./run-dialog";

/** Callbacks of the editor header's commands. */
export interface HeaderCallbacks {
  onPublish?(version: number): void;
  onSaved?(version: number): void;
  onRunStarted?(runId: string): void;
}

/** The workflow's name, edited in place. Enter or blur commits, Escape reverts. */
function NameField() {
  const { labels } = useFlowkitAppearance();
  const name = useEditorStore((s) => s.doc.name);
  const rename = useEditorStore((s) => s.renameWorkflow);
  const [draft, setDraft] = useState<string | null>(null);
  const value = draft ?? name;
  return (
    <input
      className="fk-name"
      aria-label={labels.workflowName}
      value={value}
      placeholder={labels.untitledWorkflow}
      size={Math.max(8, Math.min(40, value.length + 1))}
      spellCheck={false}
      onChange={(e) => setDraft(e.target.value)}
      onFocus={(e) => e.currentTarget.select()}
      onBlur={() => {
        if (draft !== null) rename(draft);
        setDraft(null);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
        if (e.key === "Escape") {
          setDraft(null);
          // Revert before blurring so the blur doesn't commit the draft.
          requestAnimationFrame(() => (e.target as HTMLInputElement).blur());
        }
      }}
    />
  );
}

/** "Unsaved changes", "Draft · v3" or "Published v2". */
function StatusChip() {
  const { labels } = useFlowkitAppearance();
  const { dirty, saved, published } = useEditorStore(
    useShallow((s) => ({ dirty: s.dirty, saved: s.savedVersion, published: s.publishedVersion })),
  );
  let tone: "unsaved" | "draft" | "live";
  let text: string;
  if (dirty) {
    tone = "unsaved";
    text = labels.statusUnsaved;
  } else if (saved !== null && saved === published) {
    tone = "live";
    text = labels.statusPublished(saved);
  } else {
    tone = "draft";
    text = labels.statusDraft(saved);
  }
  const hint = tone !== "live" && published !== null ? labels.statusLive(published) : undefined;
  return (
    <Hint content={hint}>
      <span className="fk-status" data-tone={tone} role="status" tabIndex={hint ? 0 : undefined}>
        <span className="fk-status__dot" aria-hidden />
        {text}
      </span>
    </Hint>
  );
}

/** Whether a server-reported issue has what the editor needs to show it. */
function isIssue(v: unknown): v is Issue {
  const i = v as Partial<Issue> | null;
  return (
    typeof i === "object" &&
    i !== null &&
    typeof i.message === "string" &&
    (i.severity === "error" || i.severity === "warning")
  );
}

const shortcut = (key: string, shift = false) =>
  isMac() ? `${shift ? "⇧" : ""}⌘${key}` : `Ctrl+${shift ? "Shift+" : ""}${key}`;

/**
 * The editor's header: back slot, name, status, undo/redo, issues, Save (⌘S), Run (manual
 * trigger) and Publish (blocked while there are errors).
 */
export function EditorHeader({
  headerLeft,
  callbacks,
}: {
  headerLeft?: ReactNode;
  callbacks: HeaderCallbacks;
}): JSX.Element {
  const { labels } = useFlowkitAppearance();
  const { client } = useFlowkit();
  const store = useEditorStoreApi();
  const toast = useToast();
  /** A failure's reason in the user's terms (no "Failed to fetch"). */
  const reason = (err: unknown) =>
    isNetworkError(err) ? labels.serverUnreachable : errorText(err);
  const { errors } = useIssues();
  const { canUndo, canRedo, dirty, saved, published, triggerKind, fields } = useEditorStore(
    useShallow((s) => ({
      canUndo: s.canUndo,
      canRedo: s.canRedo,
      dirty: s.dirty,
      saved: s.savedVersion,
      published: s.publishedVersion,
      triggerKind: s.manifest.triggers.find((t) => t.type === s.doc.trigger.type)?.kind,
      fields: s.doc.trigger.config,
    })),
  );
  const [busy, setBusy] = useState<"save" | "publish" | "run" | null>(null);
  const [runOpen, setRunOpen] = useState(false);
  const busyRef = useRef(busy);
  busyRef.current = busy;
  const cb = useRef(callbacks);
  cb.current = callbacks;

  /**
   * Saves the current doc. Returns the new version, or `null` if the save failed. `inPublish`
   * saves as the first half of Publish: silently, leaving the "publish" busy state in place.
   */
  const save = async (inPublish = false): Promise<number | null> => {
    const { doc, savedVersion } = store.getState();
    if (!inPublish) setBusy("save");
    try {
      // A draft never saved (a new workflow) is created, never written over an existing one.
      const v =
        savedVersion === null
          ? await client.saveWorkflow(doc, { create: true })
          : await client.saveWorkflow(doc);
      store.getState().markSaved(v.version, doc);
      cb.current.onSaved?.(v.version);
      if (!inPublish) toast({ message: labels.saved(v.version), tone: "success" });
      return v.version;
    } catch (err) {
      toast({ message: labels.saveFailed(reason(err)), tone: "danger" });
      return null;
    } finally {
      if (!inPublish) setBusy(null);
    }
  };

  /** Selects the first step of `issues` that is in the doc, else of the client-side issues. */
  const showFirstIssue = (issues: Issue[]) => {
    const { doc, select, issues: local } = store.getState();
    const first = issueTargets(doc, issues)[0] ?? issueTargets(doc, local)[0];
    if (first) select(first.key);
  };

  const publish = async () => {
    if (busyRef.current || errors > 0) return;
    const state = store.getState();
    // One busy state across save + publish, so the buttons don't re-enable in between.
    setBusy("publish");
    try {
      let version = state.savedVersion;
      if (state.dirty || version === null) version = await save(true);
      if (version === null) return;
      await client.publish(state.doc.id, version);
      store.getState().markPublished(version);
      cb.current.onPublish?.(version);
      toast({ message: labels.published(version), tone: "success" });
    } catch (err) {
      if (httpStatus(err) === 422) {
        const body = (err as { body?: { issues?: unknown } }).body;
        const server = Array.isArray(body?.issues) ? (body.issues as Issue[]) : [];
        // Shown where the editor's own issues are: the pill, the steps and their fields (M7).
        store.getState().setServerIssues(server.filter(isIssue));
        toast({
          message: labels.publishRejected(server.length),
          tone: "danger",
          action: { label: labels.showIssues, run: () => showFirstIssue(server) },
        });
      } else {
        toast({ message: labels.publishFailed(reason(err)), tone: "danger" });
      }
    } finally {
      setBusy(null);
    }
  };

  const startRun = async (input?: Record<string, unknown>) => {
    setBusy("run");
    try {
      const { runId } = await client.runWorkflow(store.getState().doc.id, input);
      setRunOpen(false);
      cb.current.onRunStarted?.(runId);
      toast({ message: labels.runStarted, tone: "success" });
    } catch (err) {
      toast({ message: labels.runFailed(reason(err)), tone: "danger" });
    } finally {
      setBusy(null);
    }
  };

  const inputs = manualFields(fields);
  const onRun = () => {
    if (busyRef.current || published === null) return;
    if (inputs.length === 0) void startRun();
    else setRunOpen(true);
  };

  // ⌘S / Ctrl+S saves from anywhere in the page while the editor is mounted.
  const saveRef = useRef(save);
  saveRef.current = save;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = isMac() ? e.metaKey : e.ctrlKey;
      if (!mod || e.shiftKey || e.altKey || e.key.toLowerCase() !== "s") return;
      e.preventDefault();
      if (!busyRef.current) void saveRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const upToDate = !dirty && saved !== null && saved === published;
  const publishHint =
    errors > 0 ? labels.publishBlocked(errors) : upToDate ? labels.alreadyPublished : undefined;
  const publishDisabled = errors > 0 || upToDate || busy !== null;

  return (
    <header className="fk-header">
      <div className="fk-header__title">
        {headerLeft !== undefined && <div className="fk-header__left">{headerLeft}</div>}
        <NameField />
        <StatusChip />
      </div>
      <div className="fk-header__actions" role="toolbar" aria-label={labels.editorToolbar}>
        <div className="fk-segment">
          <Hint content={`${labels.undo} (${shortcut("Z")})`}>
            <button
              type="button"
              className="fk-icon-btn"
              aria-label={labels.undo}
              aria-disabled={!canUndo || undefined}
              onClick={() => canUndo && store.getState().undo()}
            >
              <Undo2 size={16} aria-hidden />
            </button>
          </Hint>
          <Hint content={`${labels.redo} (${shortcut("Z", true)})`}>
            <button
              type="button"
              className="fk-icon-btn"
              aria-label={labels.redo}
              aria-disabled={!canRedo || undefined}
              onClick={() => canRedo && store.getState().redo()}
            >
              <Redo2 size={16} aria-hidden />
            </button>
          </Hint>
        </div>
        <IssuesPill />
        <span className="fk-header__spacer" />
        <Hint content={shortcut("S")}>
          <button
            type="button"
            className="fk-btn"
            aria-disabled={busy !== null || undefined}
            onClick={() => !busyRef.current && void save()}
          >
            {busy === "save" && <LoaderCircle size={14} className="fk-spin" aria-hidden />}
            {busy === "save" ? labels.saving : labels.save}
          </button>
        </Hint>
        {triggerKind === "manual" && (
          <Hint content={published === null ? labels.runNeedsPublish : undefined}>
            <button
              type="button"
              className="fk-btn fk-btn--run"
              aria-disabled={published === null || busy !== null || undefined}
              onClick={onRun}
            >
              {busy === "run" ? (
                <LoaderCircle size={14} className="fk-spin" aria-hidden />
              ) : (
                <Play size={13} aria-hidden />
              )}
              <span className="fk-btn__text">{labels.run}</span>
            </button>
          </Hint>
        )}
        <Hint content={publishHint}>
          <button
            type="button"
            className="fk-btn fk-btn--primary"
            aria-disabled={publishDisabled || undefined}
            onClick={() => !publishDisabled && void publish()}
          >
            {busy === "publish" && <LoaderCircle size={14} className="fk-spin" aria-hidden />}
            {busy === "publish" ? labels.publishing : labels.publish}
          </button>
        </Hint>
      </div>
      {published !== null && (
        <RunDialog
          open={runOpen}
          onOpenChange={setRunOpen}
          fields={inputs}
          version={published}
          dirty={dirty || saved !== published}
          busy={busy === "run"}
          onRun={(input) => void startRun(input)}
        />
      )}
    </header>
  );
}
