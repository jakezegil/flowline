/**
 * Builds the {@link NodeContext} a handler receives.
 *
 * @module
 */
import type {
  CallbackHandle,
  FlowkitServices,
  Logger,
  NodeContext,
  ResolveScope,
  ResumeInfo,
  TransformRuntime,
} from "@flowkit/core";
import { FatalError } from "./errors";

/** @internal Everything needed to build one handler invocation's context. */
export interface ContextArgs {
  runId: string;
  tenantId: string;
  workflowId: string;
  stepId: string;
  stepPath: string;
  attempt: number;
  idempotencyKey: string;
  services: FlowkitServices;
  logger?: Logger;
  signal: AbortSignal;
  clock: () => number;
  resume?: ResumeInfo;
  scope: ResolveScope;
  secrets?: { get(tenantId: string, name: string): Promise<string | undefined> };
  transform?: TransformRuntime;
  /** Issues a callback for this invocation (`ctx.callback`); unsupported when omitted. */
  callback?: (opts: { timeoutMs: number }) => Promise<CallbackHandle>;
}

const noopLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}

/** @internal SHA-256 hex digest of `text`, via Web Crypto. */
export async function sha256Hex(text: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** @internal A fresh 32-byte random callback token, base64url-encoded without padding. */
export function newCallbackToken(): string {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** @internal The context handed to a node handler. */
export function createNodeContext(a: ContextArgs): NodeContext {
  const scope = deepFreeze(
    structuredClone({
      trigger: a.scope.trigger,
      steps: { ...a.scope.steps },
      ...(a.scope.loop ? { loop: a.scope.loop } : {}),
    }),
  );
  const ctx: NodeContext = {
    runId: a.runId,
    tenantId: a.tenantId,
    workflowId: a.workflowId,
    stepId: a.stepId,
    stepPath: a.stepPath,
    attempt: a.attempt,
    idempotencyKey: a.idempotencyKey,
    services: a.services,
    logger: a.logger ?? noopLogger,
    signal: a.signal,
    now: a.clock,
    secrets: {
      async get(name: string): Promise<string> {
        const value = await a.secrets?.get(a.tenantId, name);
        if (value === undefined) throw new FatalError(`Secret "${name}" is not configured`);
        return value;
      },
    },
    async callback(opts) {
      if (!a.callback) throw new FatalError("ctx.callback() is not available here");
      return a.callback(opts);
    },
    transform: a.transform ?? {
      async run() {
        throw new FatalError("No transform runtime is configured");
      },
    },
    scope,
    http: {
      async fetch() {
        throw new FatalError("ctx.http is not supported yet");
      },
    },
  };
  if (a.resume !== undefined) ctx.resume = a.resume;
  return ctx;
}
