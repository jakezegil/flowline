import type { Issue } from "@flowlinejs/core";
import { LoaderCircle, Play, Redo2, Undo2 } from "lucide-react";
import { type JSX, type ReactNode, useEffect, useRef, useState } from "react";
import { isMac } from "../canvas/keyboard";
import { useEditorStore, useEditorStoreApi, useIssues, useShallow } from "../hooks";
import { useFlowline, useFlowlineAppearance } from "../provider";
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

/**
 * The workflow's name, edited in place. Enter or blur commits, Escape reverts; Enter and Escape
 * keep focus in the box (with its text selected), so the keyboard doesn't drop to the page.
 */
function NameField() {
  const { labels } = useFlowlineAppearance();
  const name = useEditorStore((s) => s.doc.name);
  const rename = useEditorStore((s) => s.renameWorkflow);
  const readOnly = useEditorStore((s) => s.readOnly);
  const store = useEditorStoreApi();
  const readOnlyNow = () => store.getState().readOnly;
  const [draft, setDraft] = useState<string | null>(null);
  const value = draft ?? name;
  /** Commits the draft. A read-only store keeps its name (renaming would throw). */
  const commit = () => {
    if (draft !== null && !readOnlyNow()) rename(draft);
    setDraft(null);
  };
  return (
    <input
      className="fl-name"
      aria-label={labels.workflowName}
      value={value}
      placeholder={labels.untitledWorkflow}
      size={Math.max(8, Math.min(40, value.length + 1))}
      spellCheck={false}
      readOnly={readOnly}
      onChange={(e) => {
        if (!readOnlyNow()) setDraft(e.target.value);
      }}
      onFocus={(e) => e.currentTarget.select()}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          commit();
          e.currentTarget.select();
        }
        if (e.key === "Escape") {
          e.preventDefault();
          setDraft(null);
          const input = e.currentTarget;
          requestAnimationFrame(() => input.select());
        }
      }}
    />
  );
}

/** "Unsaved changes", "Draft · v3" or "Published v2". */
function StatusChip() {
  const { labels } = useFlowlineAppearance();
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
      <span className="fl-status" data-tone={tone} role="status" tabIndex={hint ? 0 : undefined}>
        <span className="fl-status__dot" aria-hidden />
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
  const { labels } = useFlowlineAppearance();
  const { client } = useFlowline();
  const store = useEditorStoreApi();
  const toast = useToast();
  /** A failure's reason in the user's terms (no "Failed to fetch"). */
  const reason = (err: unknown) =>
    isNetworkError(err) ? labels.serverUnreachable : errorText(err);
  const { errors } = useIssues();
  const { canUndo, canRedo, readOnly, dirty, saved, published, triggerKind, fields } =
    useEditorStore(
      useShallow((s) => ({
        readOnly: s.readOnly,
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
      if (!showRejection(err, labels.saveRejected))
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

  /**
   * Shows a 422 (the server's validator rejected the doc) where the editor's own issues are: the
   * pill, the steps and their fields (M7), with a toast that counts the well-formed issues and
   * jumps to the first. Returns whether `err` was one.
   */
  const showRejection = (err: unknown, message: (issues: number) => string): boolean => {
    if (httpStatus(err) !== 422) return false;
    const body = (err as { body?: { issues?: unknown } }).body;
    const server = (Array.isArray(body?.issues) ? (body.issues as unknown[]) : []).filter(isIssue);
    store.getState().setServerIssues(server);
    toast({
      message: message(server.length),
      tone: "danger",
      action: { label: labels.showIssues, run: () => showFirstIssue(server) },
    });
    return true;
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
      if (!showRejection(err, labels.publishRejected))
        toast({ message: labels.publishFailed(reason(err)), tone: "danger" });
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
    <header className="fl-header">
      <div className="fl-header__title">
        {headerLeft !== undefined && <div className="fl-header__left">{headerLeft}</div>}
        <NameField />
        <StatusChip />
      </div>
      <div className="fl-header__actions" role="toolbar" aria-label={labels.editorToolbar}>
        <div className="fl-segment">
          <Hint content={`${labels.undo} (${shortcut("Z")})`}>
            <button
              type="button"
              className="fl-icon-btn"
              aria-label={labels.undo}
              aria-disabled={!canUndo || readOnly || undefined}
              onClick={() => canUndo && !store.getState().readOnly && store.getState().undo()}
            >
              <Undo2 size={16} aria-hidden />
            </button>
          </Hint>
          <Hint content={`${labels.redo} (${shortcut("Z", true)})`}>
            <button
              type="button"
              className="fl-icon-btn"
              aria-label={labels.redo}
              aria-disabled={!canRedo || readOnly || undefined}
              onClick={() => canRedo && !store.getState().readOnly && store.getState().redo()}
            >
              <Redo2 size={16} aria-hidden />
            </button>
          </Hint>
        </div>
        <IssuesPill />
        <span className="fl-header__spacer" />
        <Hint content={shortcut("S")}>
          <button
            type="button"
            className="fl-btn"
            aria-disabled={busy !== null || undefined}
            onClick={() => !busyRef.current && void save()}
          >
            {busy === "save" && <LoaderCircle size={14} className="fl-spin" aria-hidden />}
            {busy === "save" ? labels.saving : labels.save}
          </button>
        </Hint>
        {triggerKind === "manual" && (
          <Hint content={published === null ? labels.runNeedsPublish : undefined}>
            <button
              type="button"
              className="fl-btn fl-btn--run"
              aria-disabled={published === null || busy !== null || undefined}
              onClick={onRun}
            >
              {busy === "run" ? (
                <LoaderCircle size={14} className="fl-spin" aria-hidden />
              ) : (
                <Play size={13} aria-hidden />
              )}
              <span className="fl-btn__text">{labels.run}</span>
            </button>
          </Hint>
        )}
        <Hint content={publishHint}>
          <button
            type="button"
            className="fl-btn fl-btn--primary"
            aria-disabled={publishDisabled || undefined}
            onClick={() => !publishDisabled && void publish()}
          >
            {busy === "publish" && <LoaderCircle size={14} className="fl-spin" aria-hidden />}
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
