import type { FlowkitClient } from "@flowkit/core/client";
import { vi } from "vitest";

/** jsdom has no layout: gives xyflow a sized container and the APIs Radix/cmdk expect. */
export function setupDom(): void {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  Object.defineProperties(HTMLElement.prototype, {
    offsetWidth: { configurable: true, get: () => 1200 },
    offsetHeight: { configurable: true, get: () => 800 },
  });
  Element.prototype.scrollIntoView = () => {};
  window.matchMedia ??= ((query: string) => ({
    matches: false,
    media: query,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    onchange: null,
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

/** A client whose every method is a `vi.fn()` that rejects until given an implementation. */
export function mockClient(overrides: Partial<FlowkitClient> = {}): {
  [K in Exclude<keyof FlowkitClient, "baseUrl">]: ReturnType<typeof vi.fn> & FlowkitClient[K];
} {
  const methods: Exclude<keyof FlowkitClient, "baseUrl">[] = [
    "getManifest",
    "listWorkflows",
    "getWorkflow",
    "saveWorkflow",
    "publish",
    "validate",
    "listSubflows",
    "listSecrets",
    "testStep",
    "runWorkflow",
    "listRuns",
    "getRun",
    "retryRun",
    "cancelRun",
    "resumeRun",
    "subscribeRun",
  ];
  const client: Record<string, unknown> = {};
  for (const m of methods) {
    client[m] = vi.fn(overrides[m] ?? (() => Promise.reject(new Error(`${m} not mocked`))));
  }
  if (!overrides.subscribeRun) client.subscribeRun = vi.fn(() => () => {});
  return client as never;
}

/** A `FlowkitHttpError`-shaped rejection. */
export function httpError(status: number, body: unknown = {}): Error {
  return Object.assign(new Error(`HTTP ${status}`), { name: "FlowkitHttpError", status, body });
}
