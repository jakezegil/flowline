# Releasing

The six `@flowlinejs/*` packages are one [Changesets](https://github.com/changesets/changesets)
`fixed` group: they always share a version. Releases are fully automatic. Every push to `main`
runs `.github/workflows/release.yml`, and if there is something to release it is versioned and
published to npm with no manual step and no Version PR.

npm authenticates through **trusted publishing**: GitHub Actions presents a short-lived OIDC
identity, and npm accepts it for packages that name this repo and workflow as a trusted
publisher. There is no long-lived npm token in the repo.

## Bootstrapping a package (first publish + trusted publisher)

npm can only attach a trusted publisher to a package that **already exists** on the registry,
so the first version of every package has to be published once by hand. After that, CI publishes
it through OIDC.

The six current packages were bootstrapped at 0.1.0 (published by hand from `main` 1bf1d5c).
Use this procedure whenever a **new** package is added under `packages/`. It also covers
re-creating the whole setup from scratch.

### 1. Add the package to the release group

Add the new package's name to the `fixed` group in `.changeset/config.json`, so it versions
together with the others. Give it `"publishConfig": { "access": "public" }` and a `files` list,
like the existing packages.

### 2. Merge, and expect one red Release run

Merge the PR as usual. The Release run on `main` will:

- version (if changesets are pending);
- publish every package that already has a trusted publisher;
- **fail at `publish` for the new package** (`npm publish failed for @flowlinejs/<new>@X.Y.Z`,
  usually E404), because it doesn't exist on npm yet.

Tags and the GitHub Release are not created, because the `publish` job failed. That is expected.
Leave the run as it is.

### 3. Publish the new package from your machine

You need to be logged in to npm as an owner of the `flowlinejs` org (`npm whoami`, then
`npm org ls flowlinejs`). Use npm 10.9 or newer. Your local npm doesn't need OIDC. Check out the
**current `main`**, which includes the version commit from step 2:

```sh
git switch main && git pull --ff-only
pnpm install --frozen-lockfile
pnpm release:dry-run   # builds, packs, `npm publish --dry-run` for every version not on npm yet
pnpm release           # the same for real
```

`pnpm release` publishes only versions that are missing from npm, which is just the new package.
It publishes with `--access public --tag latest` (prereleases go to `next`). Everything already
on npm is skipped, so running it again is safe.

npm asks you to authenticate each publish in the browser. Alternatively, pass a one-time code
with `pnpm release --otp=123456`. A code expires after about 30 seconds and the build runs
first, so if npm reports `EOTP`, run the command again with a fresh code. Packages that already
went out are skipped.

### 4. Add the trusted publisher

Do this for the new package, or for **each** package when setting up from scratch:

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

You can also do this from the CLI. `npm trust` needs npm 11.15 or newer, 2FA on your account,
and at least one permission flag (`--allow-publish`):

```sh
# one package:
npx -y npm@11.19.1 trust github "@flowlinejs/<name>" --repo jakezegil/flowline --file release.yml --allow-publish --yes

# all six:
for p in core engine nodes-builtin react storage-memory storage-postgres; do
  npx -y npm@11.19.1 trust github "@flowlinejs/$p" --repo jakezegil/flowline --file release.yml --allow-publish --yes
done
```

A trusted-publisher connection can't be edited later, only deleted and re-created. If you rename
`release.yml`, or move publishing into a GitHub environment, update every package.

### 5. Re-run the red Release run

Open the failed run from step 2 and choose **Re-run all jobs**. `sync` fast-forwards over the
version commit, `publish` skips everything already on npm, and `github-release` creates the tags
and the GitHub Release. The run goes green.

If newer commits reached `main` since then, the re-run reports **Release superseded** and does
nothing. That's fine: the next push releases, and so does starting the workflow by hand with
**Actions → Release → Run workflow**.

### 6. Optional: lock down token publishing

Once a CI release has succeeded through OIDC, you can set each package's **Settings →
Publishing access** to *Require two-factor authentication and disallow tokens*. Trusted
publishing keeps working. Only classic and granular tokens are refused.

### Alternative bootstrap: a temporary `NPM_TOKEN`

If you can't publish from a machine, the publish job also accepts an `NPM_TOKEN` repository
secret. npm still tries OIDC first, and falls back to the token only when the exchange fails, for
example because the package doesn't exist yet. This replaces steps 2, 3 and 5:

1. Create a granular token with read-write access to `@flowlinejs`.
2. Add it as the `NPM_TOKEN` secret.
3. Merge. The Release run publishes the new package with the token and goes green.
4. Do step 4 above.
5. **Delete the secret and revoke the token.**

This is for bootstrapping only. Don't keep the secret around.

### Tags after a publish by hand

`github-release` tags the commit its run released. If the next green run on `main` is the first
to see a version that was published by hand, it tags **that run's commit**. The registry doesn't
record which commit a tarball came from.

The 0.1.0 bootstrap is an example: it was published from 1bf1d5c. You can pin the tags to that
commit yourself, and CI then leaves existing tags alone. Do this **before merging the CI/CD
change to `main`**, because the first `release.yml` run on `main` would otherwise tag its own
commit. Push the seven tags by name, so that no other local tags go up with them:

```sh
for p in core engine nodes-builtin react storage-memory storage-postgres; do
  git tag "@flowlinejs/$p@0.1.0" 1bf1d5c
done
git tag v0.1.0 1bf1d5c
git push origin \
  refs/tags/v0.1.0 \
  "refs/tags/@flowlinejs/core@0.1.0" \
  "refs/tags/@flowlinejs/engine@0.1.0" \
  "refs/tags/@flowlinejs/nodes-builtin@0.1.0" \
  "refs/tags/@flowlinejs/react@0.1.0" \
  "refs/tags/@flowlinejs/storage-memory@0.1.0" \
  "refs/tags/@flowlinejs/storage-postgres@0.1.0"
```

The GitHub Release for `v0.1.0` is then still created by the next run.

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
`pnpm changeset --empty` to say so. An empty changeset never triggers a release or a version
commit by itself. It stays in `.changeset/` until the next real changeset, and is then consumed
along with it. On PRs that touch `packages/**`, the **Changeset present** CI job warns when no
changeset is included. It is advisory and never blocks a merge.

While the packages are `0.x`, a `minor` bump is the one for breaking changes, and `patch` is for
everything else.

### What happens on merge

`release.yml` runs on every push to `main` of `jakezegil/flowline`, one run at a time. Forks
never release. A newer push waits for the running release; it never cancels it.

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
   all six packages. Tags and releases that already exist are left alone. It trusts the versions
   the publish job just confirmed, and re-checks any other version on the registry. npm's CDN
   can serve the abbreviated metadata stale for up to 5 minutes after a publish, so the
   re-check reads the full package document with a cache-busting query instead. It polls all
   the packages at once, with capped backoff, for at most about 5¼ minutes (315s) before it
   fails.

The version commit, the tags and the GitHub Release are pushed with `GITHUB_TOKEN`. The checkout
doesn't persist credentials: only the steps that fetch or push receive the token, so dependency
install and build never see a write token on disk.

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
| **publish** (E404 / E403 / ENEEDAUTH) | Some or none of the versions on npm. | Usually a missing or mistyped trusted publisher (or a package that doesn't exist yet; see [Bootstrapping](#bootstrapping-a-package-first-publish--trusted-publisher)). Check the package's Settings page against the table above, then re-run. Versions that did get published are skipped. npm logs the reason an OIDC exchange failed only at verbose level: choose **Re-run jobs → Enable debug logging**, and the publish step adds `--loglevel verbose`. |
| **github-release** | Everything on npm. Tags or the GitHub Release are missing. | Re-run. It also runs on every later push to `main`, so missing tags and releases heal on their own. |

Things to know:

- **npm versions are immutable.** A version can't be published twice, and unpublishing is
  restricted. If a bad version ships, fix forward with a new changeset (a patch). Use
  `npm deprecate "@flowlinejs/<pkg>@X.Y.Z" "reason"` if needed.
- **A run is marked superseded** (the **Release superseded** warning, `sync: superseded`) when
  newer commits reached `main` after it started. It does nothing on purpose, because the run for
  the newer commit releases the combined changes. There is one exception. If you re-run an old
  run while a newer one is queued, GitHub drops the queued run in favour of the re-run, and the
  re-run is then superseded too. When you see the warning and no newer Release run is queued or
  running, start one with **Actions → Release → Run workflow** (branch `main`).
- **Only genuine version commits are fast-forwarded.** A commit ahead of the run counts as
  "our own version commit" only if it has the bot identity and subject **and** it touches
  nothing but `package.json`, `CHANGELOG.md`, `.changeset/` and `pnpm-lock.yaml`. Anything else
  makes the run superseded, so ungated code is never released.
- **To publish by hand in an emergency,** check out the release commit and run `pnpm release`
  as in the bootstrap. The next CI run sees the versions on npm and only adds the tags and GitHub
  Release, at that run's commit (see [Tags after a publish by hand](#tags-after-a-publish-by-hand)).
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
