# @flowkit/storage-memory

An in-memory `StorageAdapter` for the [`@flowkit/engine`](../engine): everything lives in a plain
object in the current process. Values are deep-cloned with `structuredClone` on the way in and out,
so callers can never mutate stored state. Use it for tests, examples and single-process
prototypes — data does not persist across restarts and is not shared across processes; use
[`@flowkit/storage-postgres`](../storage-postgres) when you need either.

## Install

```sh
pnpm add @flowkit/storage-memory @flowkit/engine @flowkit/core zod@^4
```

`zod` 4 is a required peer dependency.

## Usage

```ts
import { createEngine } from "@flowkit/engine";
import { createMemoryStorage } from "@flowkit/storage-memory";
import { createRegistry } from "@flowkit/core";

export const engine = createEngine({
  registry: createRegistry([]),
  storage: createMemoryStorage(),
  authorize: async () => ({ tenantId: "acme", userId: "u1" }),
});
```

See the [root README](../../README.md) for the full quick start and `docs/` for the design spec.
