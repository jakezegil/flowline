/**
 * The agent bridge: lets an AI agent drive a live editor the way a person does. Reads run against
 * the store's current doc, and edits go through the store's `apply`, so each batch is one undo
 * step, flashes on the canvas and is rejected while the editor is read-only.
 *
 * @module
 */

import {
  AGENT_LIMITS,
  type ApplyResult,
  type Command,
  commandSchema,
  runTool as coreRunTool,
  type ReadArgs,
  type ReadFn,
  type ReadResults,
  type ReadToolName,
  reads,
  type ToolState,
} from "@flowlinejs/core";
import { useContext, useMemo } from "react";
import { EditorContext } from "./hooks";
import type { EditorStore } from "./store/editor-store";

/** Every core read, bound to a store: each takes only the read's `args`. */
export type BoundReads = { [K in ReadToolName]: (args: ReadArgs[K]) => ReadResults[K] };

/** What a bridge's {@link WorkflowAgentBridge.runTool} returns: core `runTool`'s result. */
type ToolResult = ReturnType<typeof coreRunTool>;

/** An agent's handle on one editor store. */
export interface WorkflowAgentBridge {
  /** Reads against the store's current doc, taken at call time. */
  read: BoundReads;
  /**
   * `store.getState().apply(commands)` for an agent: one undo step, flashes the changed steps,
   * and returns code `"readOnly"` when the store is read-only. Only the public command schema is
   * accepted (as by the catalog): the store-only `verbatim` and `nullIsValue` are rejected, with
   * core `runTool`'s error.
   */
  apply(commands: Command[]): ApplyResult;
  /**
   * Runs one catalog tool call (see core's `commandCatalog`). Reads run through core `runTool`
   * on the current state. `"apply"` checks the call like core `runTool` does (the strict
   * `{ commands }` envelope and the model-facing command schema), then runs it through
   * `store.apply`; `result` is the ApplyResult without `doc`, and `doc` is the new doc.
   */
  runTool(name: string, args: unknown): ToolResult;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * The commands of an `apply` call that passes the catalog's checks (a `{ commands }` envelope
 * whose every command fits the model-facing schema), or `undefined` when core `runTool` has to
 * report what's wrong.
 */
function checkedCommands(state: ToolState, args: unknown): Command[] | undefined {
  if (!isObject(args) || Object.keys(args).some((k) => k !== "commands")) return undefined;
  const { commands } = args;
  if (!Array.isArray(commands) || commands.length > AGENT_LIMITS.commands) return undefined;
  const schema = commandSchema(state.manifest, { internal: false });
  try {
    return commands.every((c) => schema.safeParse(c).success) ? (commands as Command[]) : undefined;
  } catch {
    // Nested too deeply to check: core reports it.
    return undefined;
  }
}

/**
 * A bridge for agent loops that run outside React (no hook, no re-render needed). A bridge keeps
 * editing the store it was made for, so drop it when that store is replaced (see
 * `<WorkflowEditor onStoreReady>`).
 *
 * @example
 * <WorkflowEditor workflowId="welcome" onStoreReady={(store) => {
 *   const bridge = createAgentBridge(store);
 *   agent.attach((name, args) => bridge.runTool(name, args));
 *   return () => agent.detach();
 * }} />
 */
export function createAgentBridge(store: EditorStore): WorkflowAgentBridge {
  const state = (): ToolState => {
    const { doc, manifest, ctx } = store.getState();
    return { doc, manifest, ctx };
  };
  const read = {} as Record<ReadToolName, (args: never) => unknown>;
  for (const name of Object.keys(reads) as ReadToolName[]) {
    read[name] = (args: never) => {
      const { doc, manifest, ctx } = store.getState();
      return (reads[name] as ReadFn<ReadToolName>)(doc, manifest, args, { ctx });
    };
  }
  /**
   * The agent's write path: public schema only (no `verbatim`/`nullIsValue`), untrusted. A batch
   * that fails the catalog's checks gets core `runTool`'s error, as `runTool("apply")` does.
   */
  const apply = (commands: Command[]): ApplyResult => {
    const now = state();
    if (!checkedCommands(now, { commands })) {
      const reported = coreRunTool(now, "apply", { commands });
      if (!reported.ok) {
        return {
          ok: false,
          error: {
            index: -1,
            path: reported.error.path ?? "commands",
            code: "command.invalid",
            message: reported.error.message,
          },
        };
      }
      if (!reported.doc) return reported.result as ApplyResult;
    }
    return store.getState().apply(commands);
  };
  return {
    read: read as unknown as BoundReads,
    apply,
    runTool(name, args) {
      if (name !== "apply") return coreRunTool(state(), name, args);
      const now = state();
      const commands = checkedCommands(now, args);
      if (!commands) {
        const reported = coreRunTool(now, name, args);
        // Every failing call is reported without a doc; one that passes goes to the store.
        if (!reported.ok || !reported.doc) return reported;
      }
      const r = store.getState().apply(commands ?? (args as { commands: Command[] }).commands);
      if (!r.ok) return { ok: true, result: r };
      const { doc, ...report } = r;
      return { ok: true, result: report, doc };
    },
  };
}

/**
 * The agent bridge of `store`, by default the enclosing editor's (as `useEditorStoreApi()`).
 * Memoized per store: the same bridge until the store changes.
 *
 * @example
 * function AgentPanel() {
 *   const bridge = useWorkflowAgentBridge();
 *   return <Chat onToolCall={(name, args) => bridge.runTool(name, args)} />;
 * }
 */
export function useWorkflowAgentBridge(store?: EditorStore): WorkflowAgentBridge {
  const context = useContext(EditorContext);
  const target = store ?? context;
  if (!target) {
    throw new Error(
      "useWorkflowAgentBridge needs a store, or <WorkflowEditor>, <WorkflowCanvas> or <EditorContext.Provider value={store}> above it",
    );
  }
  return useMemo(() => createAgentBridge(target), [target]);
}
