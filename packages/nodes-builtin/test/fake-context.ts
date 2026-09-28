import type { NodeContext } from "@flowlinejs/core";

/** Fixed "now" of {@link fakeContext}: 2026-01-01T00:00:00Z. */
export const NOW = Date.UTC(2026, 0, 1);

/** A minimal {@link NodeContext} for calling handlers directly. */
export function fakeContext(overrides: Partial<NodeContext> = {}): NodeContext {
  return {
    runId: "run-1",
    tenantId: "t1",
    workflowId: "wf",
    stepId: "step",
    stepPath: "step",
    attempt: 1,
    idempotencyKey: "key",
    services: {},
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    signal: new AbortController().signal,
    now: () => NOW,
    secrets: {
      async get(name) {
        throw new Error(`no secret ${name}`);
      },
    },
    async callback({ timeoutMs }) {
      return {
        token: "tok",
        resumeUrl: "https://x/flowline/resume/tok",
        expiresAt: NOW + timeoutMs,
      };
    },
    transform: {
      async run() {
        throw new Error("no transform");
      },
    },
    scope: { trigger: {}, steps: {} },
    http: {
      async fetch() {
        throw new Error("no http");
      },
    },
    ...overrides,
  };
}
