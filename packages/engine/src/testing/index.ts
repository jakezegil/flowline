/**
 * Test utilities for Flowkit hosts, plugin authors and adapter authors, exposed as
 * `@flowkit/engine/testing`. The conformance suite requires `vitest`; `runWorkflowInMemory`
 * requires `@flowkit/storage-memory` (both optional peer dependencies).
 *
 * @module
 */
export { type ConformanceFixture, runStorageConformance } from "./conformance";
export { runWorkflowInMemory, testNode } from "./helpers";
