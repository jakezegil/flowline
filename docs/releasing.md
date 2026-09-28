# Releasing

The six `@flowlinejs/*` packages are one [Changesets](https://github.com/changesets/changesets)
`fixed` group: they always share a version. Releases are fully automatic. Every push to `main`
runs `.github/workflows/release.yml`, and if there is something to release it is versioned and
published to npm with no manual step and no Version PR.

npm authenticates through **trusted publishing**: GitHub Actions presents a short-lived OIDC
identity, and npm accepts it for packages that name this repo and workflow as a trusted
publisher. There is no long-lived npm token in the repo.

## One-time bootstrap

npm can only attach a trusted publisher to a package that already exists, so the very first
version of each package has to be published another way. Do this **before merging the CI/CD
change to `main`**. If you merge first, the first release run fails at `publish` with a 404, and
you re-run it after finishing the steps below.

### 1. Publish 0.1.0 from your machine

You need to be logged in to npm as an owner of the `flowlinejs` org (`npm whoami`, then
`npm org ls flowlinejs`). From a clean checkout of the `main` commit you want to ship:

```sh
pnpm install --frozen-lockfile
pnpm release:dry-run   # builds, packs, runs `npm publish --dry-run` for every unpublished package
pnpm release           # the same for real: pnpm pack, then npm publish <tarball> --access public --tag latest
```

npm asks you to authenticate each publish in the browser, or you can pass a code with
`pnpm release --otp=123456`. It is safe to run again: versions that are already on npm are
skipped. Use npm 10.9 or newer. Your local npm doesn't need OIDC.

### 2. Add the trusted publisher to each package

For **each** of these packages:

- `@flowlinejs/core`
- `@flowlinejs/engine`
- `@flowlinejs/nodes-builtin`
- `@flowlinejs/react`
- `@flowlinejs/storage-memory`
- `@flowlinejs/storage-postgres`

open `https://www.npmjs.com/package/<package>/access` (the package page → **Settings** tab).
Under **Trusted Publisher**, choose **GitHub Actions** and enter:

| Field                  | Value                                              |
| ---------------------- | -------------------------------------------------- |
| Organization or user   | `jakezegil`                                        |
| Repository             | `flowline`                                         |
| Workflow filename      | `release.yml` (the file name only, not the path)   |
| Environment name       | *(leave empty: the workflow uses no environment)*  |

If the form offers a choice of allowed actions, allow `npm publish`. Save.

You can also do this from the CLI. `npm trust` needs npm 11.15 or newer and 2FA on your account:

```sh
for p in core engine nodes-builtin react storage-memory storage-postgres; do
  npx -y npm@11.19.1 trust github "@flowlinejs/$p" --repo jakezegil/flowline --file release.yml --yes
done
```

A trusted-publisher connection can't be edited later, only deleted and re-created. If you rename
`release.yml`, or move publishing into a GitHub environment, update all six packages.

### 3. Optional: lock down token publishing

Once a CI release has succeeded through OIDC, you can set each package's **Settings →
Publishing access** to *Require two-factor authentication and disallow tokens*. Trusted
publishing keeps working. Only classic and granular tokens are refused.

### Alternative bootstrap: a temporary `NPM_TOKEN`

If you can't publish from a machine, the publish job also accepts an `NPM_TOKEN` repository
secret. npm still tries OIDC first, and falls back to the token only when the exchange fails, for
example because no trusted publisher exists yet. To bootstrap this way:

1. Create a granular token with read-write access to `@flowlinejs`.
2. Add it as the `NPM_TOKEN` secret.
3. Merge. The first run publishes 0.1.0 with the token.
4. Do step 2 above.
5. **Delete the secret and revoke the token.**

This is for bootstrapping only. Don't keep the secret around.

## Everyday flow

### Add a changeset

Any PR that changes what a published package ships should include one:

```sh
pnpm changeset          # pick the bump (patch/minor/major) and write a summary
git add .changeset && git commit -m "chore: add changeset"
```

The summary becomes the CHANGELOG entry and the GitHub Release text, so write it for users.
Because the group is `fixed`, one changeset that names any package bumps all six to the same
version.

If a change needs no release (a refactor, a test, internal tooling), add
`pnpm changeset --empty` to say so. On PRs that touch `packages/**`, the **Changeset present**
CI job warns when no changeset is included. It is advisory and never blocks a merge.

While the packages are `0.x`, a `minor` bump is the one for breaking changes, and `patch` is for
everything else.

### What happens on merge

`release.yml` runs on every push to `main`, one run at a time. A newer push waits for the
running release; it never cancels it.

1. **gates** runs the same reusable `gates.yml` as PRs:
   - install with a frozen lockfile, then build, test, the release-tooling tests, typecheck and lint (Node 22);
   - the Playwright e2e (chromium);
   - a consumer smoke test that installs the packed tarballs on Node 20.18.1 and 22.

   Nothing is versioned or published unless all of these pass.
2. **prepare** decides what to do (`node scripts/release.mjs plan`):
   - **Changesets pending.** It runs `changeset version`, which bumps all six versions, writes
     `CHANGELOG.md` files and deletes the changesets. It then commits the result to `main` as
     `github-actions[bot]` with the message `chore(release): version packages vX.Y.Z [skip ci]`.
     The commit is pushed with `GITHUB_TOKEN`, and pushes made with `GITHUB_TOKEN` never trigger
     workflows, so there is no loop. The `[skip ci]` covers a future switch to an app token.
   - **Nothing pending, but a version isn't on npm.** This is the first release, or a retry.
     Nothing is committed.
   - **Everything is published.** It packs nothing, and the rest is a no-op.

   It then builds and runs `pnpm pack` for every version that isn't on npm yet. pnpm rewrites
   `workspace:` ranges and applies `publishConfig`.
3. **publish** runs `npm publish <tarball> --access public --tag latest` for each tarball, in
   dependency order. This job has `id-token: write` and runs nothing but npm 11 and the release
   script, with no dependency install. Versions already on npm are skipped.
4. **github-release** pushes the tags (`@flowlinejs/<pkg>@X.Y.Z` for each package, plus
   `vX.Y.Z`) and creates one GitHub Release, `vX.Y.Z`, whose notes are the CHANGELOG sections of
   all six packages. Tags and releases that already exist are left alone.

**Dist-tags.** Stable versions, including every `0.x`, go to `latest`, so `npm install
@flowlinejs/core` gets the newest release. Prerelease versions (`1.0.0-rc.0`, from
`changeset pre enter`) go to `next`. The old workflow published everything under a permanent
`--tag next`. That is gone.

**Provenance.** npm attaches provenance attestations automatically under trusted publishing,
but only from **public** repositories. While `jakezegil/flowline` is private, packages publish
without provenance. Once the repo is public they get it with no change, and no `--provenance`
flag is needed.

## Recovering a failed release

Every step is idempotent, so the answer is almost always **Re-run all jobs** on the failed
`Release` run. Here is what each failure means:

| Failed job / step | State | Fix |
| --- | --- | --- |
| **gates** | Nothing versioned or published. | Fix `main` with a normal PR. The next push releases. |
| **prepare: Push version commit** | `main` moved during the run. Nothing published. | Nothing to do. The run queued for the newer push releases everything. |
| **prepare**, after the push | The version commit is on `main`. Nothing published. | Re-run. The re-run sees `main` is ahead only by its own release commit, fast-forwards to it (`sync: fast-forward`) and publishes. |
| **publish** (E404 / E403 / ENEEDAUTH) | Some or none of the versions on npm. | Usually a missing or mistyped trusted publisher: check the package's Settings page against the table above, then re-run. Versions that did get published are skipped. |
| **github-release** | Everything on npm. Tags or the GitHub Release are missing. | Re-run. It also runs on every later push to `main`, so missing tags and releases heal on their own. |

Things to know:

- **npm versions are immutable.** A version can't be published twice, and unpublishing is
  restricted. If a bad version ships, fix forward with a new changeset (a patch). Use
  `npm deprecate "@flowlinejs/<pkg>@X.Y.Z" "reason"` if needed.
- **A run is marked superseded** (`sync: superseded`) when newer commits reached `main` after it
  started. It does nothing on purpose, because the newer run releases the combined changes.
- **To publish by hand in an emergency,** check out the release commit and run `pnpm release`
  as in the bootstrap. The next CI run sees the versions on npm and only adds the tags and GitHub
  Release.
- **To simulate locally,** run `pnpm release:dry-run` (nothing is published) or
  `node scripts/release.mjs plan` (read-only registry query). `pnpm test:scripts` runs the unit
  tests and an end-to-end simulation against a fake registry and git remote.

## Reference

- `scripts/release.mjs`: `plan`, `sync`, `version`, `push`, `pack`, `publish`, `github-release`
  and `changeset-check`. Logic lives in `scripts/lib/release.mjs`.
- `scripts/smoke-consumer.mjs`: installs packed tarballs into a scratch npm project and imports
  every entry point.
- `.github/workflows/gates.yml`: the reusable gates.
- `.github/workflows/ci.yml`: PRs, gates plus the changeset check.
- `.github/workflows/release.yml`: `main`.
- `.github/actions/setup`: pnpm (version from `packageManager`), Node, `pnpm install --frozen-lockfile`.
- npm is pinned to `11.19.1` in the publish job. Trusted publishing needs npm 11.5.1 or newer and
  Node 22.14 or newer. Bump npm deliberately.
