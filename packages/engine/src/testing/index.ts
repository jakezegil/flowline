/**
 * Test utilities for Flowkit hosts, plugin authors and adapter authors, exposed as
 * `@flowkit/engine/testing`. `runWorkflowInMemory` requires `@flowkit/storage-memory` (an
 * optional peer dependency). This entry point never imports `vitest` — the `StorageAdapter`
 * conformance suite, which does, is its own entry point: `@flowkit/engine/conformance`.
 *
 * @module
 */
export {
  type RunWorkflowInMemoryOptions,
  runWorkflowInMemory,
  type TestNodeResult,
  testNode,
} from "./helpers";
