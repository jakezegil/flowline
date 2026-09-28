# Changesets

Each Markdown file in this folder (except this README) is a pending release note. Add one to
any PR that changes what a published `@flowlinejs/*` package ships:

```sh
pnpm changeset          # choose patch/minor/major and write a user-facing summary
pnpm changeset --empty  # the change needs no release (refactor, tests, tooling)
```

All six packages are one `fixed` group (`config.json`), so any changeset bumps them all to the
same version. While they're `0.x`, a `minor` bump is for breaking changes and `patch` is for
everything else. The private examples are ignored.

You never run `changeset version` or publish by hand. On merge to `main`,
`.github/workflows/release.yml` consumes the pending files here, commits the version bump and
changelogs, publishes to npm (dist-tag `latest`) and creates a GitHub Release. See
[docs/releasing.md](../docs/releasing.md).
