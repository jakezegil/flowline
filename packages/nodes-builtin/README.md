# @flowkit/nodes-builtin

The `core.*` nodes and triggers every Flowkit engine provides: `condition`, `switch`, `forEach`,
`stop`, `delay`, `waitForCallback`, `callSubflow`, `httpRequest` (with an SSRF guard) and a
sandboxed JavaScript `transform`, plus the event, webhook, manual, schedule and sub-flow triggers.
`createEngine` registers `builtinPlugin` automatically unless you pass `builtins: false`.

## Install

```sh
pnpm add @flowkit/nodes-builtin @flowkit/core zod@^4
```

`zod` 4 is a required peer dependency.

## Usage

You normally don't import this package directly — `@flowkit/engine`'s `createEngine` adds
`builtinPlugin` for you. To build a manifest for the editor without an engine, or to register the
builtins alongside your own plugins explicitly:

```ts
import { createRegistry } from "@flowkit/core";
import { builtinPlugin } from "@flowkit/nodes-builtin";

export const registry = createRegistry([builtinPlugin /*, ...yourPlugins */]);
```

Individual nodes, triggers and rule helpers (`conditionNode`, `httpRequestNode`, `eventTrigger`,
`evaluateRules`, and so on) are also exported for use in tests or custom registries. See the
[root README](../../README.md) for the full quick start and `docs/` for the design spec.
