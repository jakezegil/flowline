# @flowlinejs/nodes-builtin

The `core.*` nodes and triggers every Flowline engine provides: `condition`, `switch`, `forEach`,
`stop`, `delay`, `waitForCallback`, `callSubflow`, `httpRequest` (with an SSRF guard) and a
sandboxed JavaScript `transform`, plus the event, webhook, manual, schedule and sub-flow triggers.
`createEngine` registers `builtinPlugin` automatically unless you pass `builtins: false`.

## Install

```sh
pnpm add @flowlinejs/nodes-builtin @flowlinejs/core zod@^4
```

`zod` 4 is a required peer dependency.

## Usage

You normally don't import this package directly — `@flowlinejs/engine`'s `createEngine` adds
`builtinPlugin` for you. To build a manifest for the editor without an engine, or to register the
builtins alongside your own plugins explicitly:

```ts
import { createRegistry } from "@flowlinejs/core";
import { builtinPlugin } from "@flowlinejs/nodes-builtin";

export const registry = createRegistry([builtinPlugin /*, ...yourPlugins */]);
```

`createBuiltinPlugin({ compare, operators })` returns the same `core` plugin with host choices:
`compare: "strict"` makes conditions and switches compare strictly by default (same-type values
only, case-sensitive text), and `operators` adds your own rule operators to `core.condition`.
Register it in your registry and `createEngine` won't add the default `builtinPlugin`.

Individual nodes, triggers and rule helpers (`conditionNode`, `httpRequestNode`, `eventTrigger`,
`evaluateRules`, `strictly`, `custom`, and so on) are also exported for use in tests or custom
registries. See the [root README](../../README.md) for the full quick start and `docs/` for the
design spec.
