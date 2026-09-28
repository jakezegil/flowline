# @flowline/storage-memory

An in-memory `StorageAdapter` for the [`@flowline/engine`](../engine): everything lives in a plain
object in the current process. Values are deep-cloned with `structuredClone` on the way in and out,
so callers can never mutate stored state. Use it for tests, examples and single-process
prototypes — data does not persist across restarts and is not shared across processes; use
[`@flowline/storage-postgres`](../storage-postgres) when you need either.

## Install

```sh
pnpm add @flowline/storage-memory @flowline/engine @flowline/core zod@^4
```

`zod` 4 is a required peer dependency.

## Usage

```ts
import { createEngine } from "@flowline/engine";
import { createMemoryStorage } from "@flowline/storage-memory";
import { createRegistry } from "@flowline/core";

export const engine = createEngine({
  registry: createRegistry([]),
  storage: createMemoryStorage(),
  authorize: async () => ({ tenantId: "acme", userId: "u1" }),
});
```

See the [root README](../../README.md) for the full quick start and `docs/` for the design spec.
