# @flowkit/engine

The durable Flowkit workflow engine: `createEngine` interprets a published `WorkflowDoc` over a
pluggable `StorageAdapter`, exposes an HTTP handler for the editor and run viewer, runs a worker
that claims and executes steps, and records every step to a journal and audit trail. Retries,
suspension (`delay`, `waitForCallback`, sub-flows), webhooks and cron schedules are all built in.

## Install

```sh
pnpm add @flowkit/engine @flowkit/core zod@^4
pnpm add @flowkit/storage-memory   # or @flowkit/storage-postgres
```

`zod` 4 is a required peer dependency. Bring your own `StorageAdapter` — `@flowkit/storage-memory`
(for tests and prototypes) or `@flowkit/storage-postgres` — as a peer; `vitest` is an optional peer
used only by `@flowkit/engine/conformance`. `@flowkit/engine/testing` never imports `vitest`.

## Usage

```ts
import { createEngine } from "@flowkit/engine";
import { createMemoryStorage } from "@flowkit/storage-memory";
import { createRegistry } from "@flowkit/core";

const registry = createRegistry([]); // your plugins; core.* builtins are added automatically

export const engine = createEngine({
  registry,
  storage: createMemoryStorage(),
  authorize: async () => ({ tenantId: "acme", userId: "u1" }),
});

// Mount engine.handler (a `(Request) => Promise<Response>`) with any fetch-style server,
// and start a worker to execute claimed runs:
export const worker = engine.startWorker({ concurrency: 4 });
```

See the [root README](../../README.md) for the full quick start (nodes, plugin, Postgres storage,
HTTP mount, worker, publish, editor) and `docs/` for the design spec. `@flowkit/engine/testing`
exports `runWorkflowInMemory` and `testNode`. `@flowkit/engine/conformance` exports
`runStorageConformance`, a storage conformance suite for testing your own `StorageAdapter` — its
own entry point because it requires `vitest`.
