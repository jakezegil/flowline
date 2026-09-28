// Pure(ish) helpers behind scripts/release.mjs. Everything with side effects (fs, network, git,
// child processes) is passed in, so the logic is unit-tested in scripts/release.test.mjs without
// touching the registry or the repo.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Subject prefix of the bot commit that `release.mjs version` pushes to main. */
export const RELEASE_COMMIT_SUBJECT = "chore(release): version packages";
/** Author email GitHub uses for commits made as github-actions[bot]. */
export const BOT_EMAIL = "41898282+github-actions[bot]@users.noreply.github.com";
export const BOT_NAME = "github-actions[bot]";
export const DEFAULT_REGISTRY = "https://registry.npmjs.org";
/** First npm CLI release that performs the trusted-publishing OIDC exchange. */
export const MIN_OIDC_NPM = "11.5.1";

/**
 * Publishable workspace packages under `packages/`: every package.json that is not private.
 * @param {string} root repo root
 * @returns {{ name: string, version: string, dir: string, manifest: Record<string, any> }[]}
 */
export function readPublishablePackages(root) {
  const base = join(root, "packages");
  const out = [];
  for (const entry of readdirSync(base, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = join(base, entry.name, "package.json");
    if (!existsSync(file)) continue;
    const manifest = JSON.parse(readFileSync(file, "utf8"));
    if (manifest.private) continue;
    out.push({
      name: manifest.name,
      version: manifest.version,
      dir: join(base, entry.name),
      manifest,
    });
  }
  return topoSort(out);
}

/**
 * Orders packages so each comes after the workspace packages it depends on (`dependencies` and
 * `optionalDependencies` only; peers can be cyclic, e.g. engine <-> storage-memory). Ties are
 * broken by name so the order is stable. A cycle in real dependencies throws.
 * @template {{ name: string, manifest: Record<string, any> }} P
 * @param {P[]} pkgs
 * @returns {P[]}
 */
export function topoSort(pkgs) {
  const byName = new Map(pkgs.map((p) => [p.name, p]));
  const deps = new Map(
    pkgs.map((p) => [
      p.name,
      Object.keys({ ...p.manifest.dependencies, ...p.manifest.optionalDependencies })
        .filter((d) => byName.has(d) && d !== p.name)
        .sort(),
    ]),
  );
  const done = new Set();
  const visiting = new Set();
  /** @type {P[]} */
  const out = [];
  const visit = (name) => {
    if (done.has(name)) return;
    if (visiting.has(name)) throw new Error(`dependency cycle through ${name}`);
    visiting.add(name);
    for (const d of deps.get(name) ?? []) visit(d);
    visiting.delete(name);
    done.add(name);
    out.push(/** @type {P} */ (byName.get(name)));
  };
  for (const name of [...byName.keys()].sort()) visit(name);
  return out;
}

/**
 * Pending changeset files (`.changeset/*.md` other than README.md).
 * @param {string} root
 * @returns {string[]}
 */
export function listPendingChangesets(root) {
  const dir = join(root, ".changeset");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md") && f.toLowerCase() !== "readme.md")
    .sort();
}

/**
 * True for a changeset that names no packages (`pnpm changeset --empty`). Those record "no
 * release needed" and must not trigger a version commit on their own.
 * @param {string} content
 */
export function isEmptyChangeset(content) {
  const m = /^---\r?\n([\s\S]*?)^---\s*$/m.exec(content);
  return m !== null && m[1].trim() === "";
}

/**
 * Pending changesets that actually release something (non-empty frontmatter).
 * @param {string} root
 * @returns {string[]}
 */
export function listReleasableChangesets(root) {
  return listPendingChangesets(root).filter(
    (f) => !isEmptyChangeset(readFileSync(join(root, ".changeset", f), "utf8")),
  );
}

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Versions of `name` on the registry. A 404 means the package does not exist yet (empty set).
 * Network errors and 5xx are retried with backoff; anything else throws. Guessing "unpublished"
 * could cause a spurious publish attempt, and guessing "published" could skip a release.
 *
 * Normal reads use the abbreviated packument, which the registry CDN caches (max-age=300). That
 * includes a brand-new package's earlier 404, and a query string does not bust it (measured).
 * `fresh` reads request the full packument (`accept: application/json`) with a unique query
 * string instead. Measured against registry.npmjs.org, that read misses the CDN cache and sees a
 * publish immediately.
 * @param {string} name
 * @param {{ fetch?: typeof fetch, registry?: string, fresh?: boolean, retries?: number,
 *   delayMs?: number, sleep?: (ms: number) => Promise<void> }} [opts]
 * @returns {Promise<Set<string>>}
 */
export async function fetchPublishedVersions(name, opts = {}) {
  const doFetch = opts.fetch ?? fetch;
  const sleep = opts.sleep ?? defaultSleep;
  const retries = opts.retries ?? 3;
  const delayMs = opts.delayMs ?? 1000;
  const registry = (opts.registry ?? DEFAULT_REGISTRY).replace(/\/$/, "");
  const base = `${registry}/${name.replace("/", "%2F")}`;
  const headers = opts.fresh
    ? { accept: "application/json", "cache-control": "no-cache" }
    : { accept: "application/vnd.npm.install-v1+json" };
  for (let attempt = 0; ; attempt++) {
    const url = opts.fresh ? `${base}?cache-bust=${Date.now()}-${attempt}` : base;
    let res;
    try {
      res = await doFetch(url, { headers });
    } catch (e) {
      if (attempt >= retries) throw e;
      await sleep(delayMs * 2 ** attempt);
      continue;
    }
    if (res.status === 404) return new Set();
    if (res.status >= 500 && attempt < retries) {
      await sleep(delayMs * 2 ** attempt);
      continue;
    }
    if (!res.ok) throw new Error(`GET ${base} -> ${res.status}`);
    const body = await res.json();
    return new Set(Object.keys(body.versions ?? {}));
  }
}

/**
 * Waits until `name@version` is visible on the registry, polling with fresh reads and backoff.
 * Used right after a publish, when stale metadata is expected for a little while.
 *
 * The wait is bounded. The delay doubles from `delayMs` and is capped at `12 * delayMs`. With the
 * defaults (9 attempts, 5s) that is 5+10+20+40+60+60+60+60 = 315s of sleep, just past the CDN's
 * 300s max-age in case even the fresh read is served stale. Callers poll packages concurrently,
 * so the total stays inside github-release's 10-minute job timeout.
 * @param {string} name
 * @param {string} version
 * @param {Parameters<typeof fetchPublishedVersions>[1] & { attempts?: number }} [opts]
 * @returns {Promise<boolean>}
 */
export async function waitForVersion(name, version, opts = {}) {
  const sleep = opts.sleep ?? defaultSleep;
  const attempts = opts.attempts ?? 9;
  const delayMs = opts.delayMs ?? 5000;
  const maxDelayMs = 12 * delayMs;
  for (let i = 0; i < attempts; i++) {
    if ((await fetchPublishedVersions(name, { ...opts, fresh: true })).has(version)) return true;
    if (i < attempts - 1) await sleep(Math.min(delayMs * 2 ** i, maxDelayMs));
  }
  return false;
}

/** Sleep schedule of `waitForVersion` (for docs/tests): total ms slept before giving up. */
export function waitBudgetMs({ attempts = 9, delayMs = 5000 } = {}) {
  let total = 0;
  for (let i = 0; i < attempts - 1; i++) total += Math.min(delayMs * 2 ** i, 12 * delayMs);
  return total;
}

/**
 * What a release run on main should do.
 * - `version`: changesets are pending; bump, commit, then publish the new versions.
 * - `publish`: nothing pending, but some package version is not on the registry (first release,
 *   or a re-run after a failed publish).
 * - `none`: everything is published.
 * @param {{ pendingChangesets: string[], packages: { name: string, version: string, published: boolean }[] }} input
 * @returns {"version" | "publish" | "none"}
 */
export function planRelease({ pendingChangesets, packages }) {
  if (pendingChangesets.length > 0) return "version";
  if (packages.some((p) => !p.published)) return "publish";
  return "none";
}

/**
 * npm dist-tag for a version. Stable versions (including 0.x) go to `latest`; prereleases
 * (`1.0.0-rc.1`) go to `next` so they never become the default install.
 * @param {string} version
 */
export function distTagFor(version) {
  return version.includes("-") ? "next" : "latest";
}

/** Paths a version commit may touch: manifests, changelogs, changesets, the lockfile. */
const RELEASE_COMMIT_PATH =
  /^(\.changeset\/[^/]+|\.changeset\/pre\/[^/]+\.md|pnpm-lock\.yaml|(packages|examples)\/[^/]+\/(package\.json|CHANGELOG\.md))$/;

/**
 * Our own version commit: bot identity, our subject, and only version-bump files. The file check
 * means a commit that merely imitates the bot can't carry ungated code past `sync`.
 * @param {{ email: string, subject: string, files: string[] }} commit
 */
export function isReleaseCommit(commit) {
  return (
    commit.email === BOT_EMAIL &&
    commit.subject.startsWith(RELEASE_COMMIT_SUBJECT) &&
    Array.isArray(commit.files) &&
    commit.files.length > 0 &&
    commit.files.every((f) => RELEASE_COMMIT_PATH.test(f))
  );
}

/**
 * Decides how a release run relates to the current tip of main.
 * - `current`: the run's commit is the tip.
 * - `fast-forward`: main is ahead only by our own release commits (a previous attempt of this run
 *   pushed the version bump and then failed); continue from the tip so the re-run publishes.
 * - `superseded`: main has other new commits (or was rewritten). A newer queued run covers them,
 *   so this run does nothing.
 * @param {{ isAncestor: boolean, ahead: { email: string, subject: string, files: string[] }[] }} input
 * @returns {"current" | "fast-forward" | "superseded"}
 */
export function classifyTip({ isAncestor, ahead }) {
  if (!isAncestor) return "superseded";
  if (ahead.length === 0) return "current";
  return ahead.every(isReleaseCommit) ? "fast-forward" : "superseded";
}

/**
 * The body of `## <version>` in a changesets CHANGELOG.md, without the heading, or null.
 * @param {string} markdown
 * @param {string} version
 */
export function extractChangelogSection(markdown, version) {
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex((l) => l.trim() === `## ${version}`);
  if (start === -1) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^## /.test(l));
  const body = (end === -1 ? rest : rest.slice(0, end)).join("\n").trim();
  return body.length > 0 ? body : null;
}

/**
 * GitHub Release groups: one combined `v<version>` release when every package shares a version
 * (the changesets `fixed` group), otherwise one release per package at its changesets-style tag.
 * @template {{ name: string, version: string }} P
 * @param {P[]} packages
 * @returns {{ tag: string, title: string, version: string, prerelease: boolean, packages: P[] }[]}
 */
export function releaseGroups(packages) {
  if (packages.length === 0) return [];
  const versions = new Set(packages.map((p) => p.version));
  if (versions.size === 1) {
    const version = packages[0].version;
    return [
      {
        tag: `v${version}`,
        title: `v${version}`,
        version,
        prerelease: version.includes("-"),
        packages,
      },
    ];
  }
  return packages.map((p) => ({
    tag: `${p.name}@${p.version}`,
    title: `${p.name}@${p.version}`,
    version: p.version,
    prerelease: p.version.includes("-"),
    packages: [p],
  }));
}

/**
 * Markdown notes for one release group.
 * @param {{ packages: { name: string, version: string }[] }} group
 * @param {(name: string) => string | null} readChangelog CHANGELOG.md contents, or null if absent
 */
export function buildReleaseNotes(group, readChangelog) {
  const parts = [];
  for (const p of group.packages) {
    const md = readChangelog(p.name);
    const section = md ? extractChangelogSection(md, p.version) : null;
    parts.push(
      `## ${p.name}@${p.version}\n\n${section ?? "Initial release."}\n\nhttps://www.npmjs.com/package/${p.name}/v/${p.version}`,
    );
  }
  return `${parts.join("\n\n")}\n`;
}

/** Git tags to create for published packages: changesets-style per package, plus group tags. */
export function tagsFor(packages) {
  const tags = packages.map((p) => `${p.name}@${p.version}`);
  for (const g of releaseGroups(packages)) if (!tags.includes(g.tag)) tags.push(g.tag);
  return tags;
}

/**
 * True when `npm publish` output says the version already exists (a concurrent or earlier run
 * got there first, or registry metadata was stale when we checked).
 * @param {string} output
 */
export function isAlreadyPublishedError(output) {
  return (
    /EPUBLISHCONFLICT/.test(output) ||
    /cannot publish over (the )?previously published version/i.test(output) ||
    /You cannot publish over the previously published versions/i.test(output)
  );
}

/**
 * Changeset check for a PR: does it touch published package code without adding a changeset?
 * Tests, fixtures and markdown under packages/ don't need one.
 * @param {string[]} changedFiles repo-relative paths changed by the PR
 * @returns {{ touchesPackages: boolean, hasChangeset: boolean, missing: boolean, files: string[] }}
 */
export function changesetCheck(changedFiles) {
  const files = changedFiles.filter(
    (f) =>
      f.startsWith("packages/") &&
      !/\.test\.[cm]?[jt]sx?$/.test(f) &&
      !/\/(__tests__|__fixtures__|fixtures|playground)\//.test(f) &&
      !f.endsWith(".md"),
  );
  const hasChangeset = changedFiles.some(
    (f) => /^\.changeset\/[^/]+\.md$/.test(f) && f.toLowerCase() !== ".changeset/readme.md",
  );
  const touchesPackages = files.length > 0;
  return { touchesPackages, hasChangeset, missing: touchesPackages && !hasChangeset, files };
}

/**
 * Compares dotted numeric versions (prerelease suffixes ignored). Returns -1, 0 or 1.
 * @param {string} a
 * @param {string} b
 */
export function compareVersions(a, b) {
  const pa = a.split("-")[0].split(".").map(Number);
  const pb = b.split("-")[0].split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}
