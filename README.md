# Flowkit

Flowkit (`@flowkit/*`) is a TypeScript library for defining workflow nodes and
plugins, editing tree-shaped workflows on a React Flow canvas, and executing
them durably with an audit trail.

This is a pnpm monorepo. See `docs/superpowers/specs/2026-09-27-flowkit-design.md`
for the design spec.

## Packages

- `@flowkit/core` — pure, isomorphic definitions, doc model, refs, validator, manifest, client
- `@flowkit/nodes-builtin` — built-in node/trigger definitions
- `@flowkit/engine` — durable interpreter over a `StorageAdapter`
- `@flowkit/storage-memory` / `@flowkit/storage-postgres` — storage adapters
- `@flowkit/react` — React Flow-based workflow editor UI

## Development

```sh
pnpm install
pnpm test
pnpm -r typecheck
pnpm lint
pnpm build
```
