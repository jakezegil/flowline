/**
 * Test utilities for Flowkit hosts, plugin authors and adapter authors, exposed as
 * `@flowkit/engine/testing`. This entry point never statically imports either of its optional
 * peers: `runWorkflowInMemory` loads `@flowkit/storage-memory` lazily (`await import(...)`) on
 * first call, so `testNode` alone works without it installed; the `StorageAdapter` conformance
 * suite, which needs `vitest`, is its own entry point, `@flowkit/engine/conformance`.
 *
 * @module
 */
export {
  type RunWorkflowInMemoryOptions,
  runWorkflowInMemory,
  type TestNodeResult,
  testNode,
} from "./helpers";
