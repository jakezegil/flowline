#!/usr/bin/env node
// Release driver for the @flowlinejs/* packages. See docs/releasing.md.
//
//   node scripts/release.mjs plan                 what a release run should do (version|publish|none)
//   node scripts/release.mjs sync                 reconcile this run's commit with the tip of main
//   node scripts/release.mjs version              changeset version + bot commit (no push)
//   node scripts/release.mjs push                 push the bot commit to main
//   node scripts/release.mjs pack --out DIR [--only-unpublished]
//   node scripts/release.mjs publish [--dir DIR] [--dry-run] [--otp CODE] [-- <npm publish args>]
//   node scripts/release.mjs github-release --sha SHA
//   node scripts/release.mjs changeset-check --base REF
//
// Publishing goes through `npm publish <tarball>`: pnpm packs (rewriting `workspace:` ranges and
// applying publishConfig), and npm >= 11.5.1 performs the trusted-publishing OIDC exchange.
// Every step is idempotent: versions already on the registry are skipped, existing tags and
// releases are left alone.
//
// Overridable for tests/simulation: RELEASE_ROOT, RELEASE_REGISTRY, NPM_BIN, PNPM_BIN,
// CHANGESET_BIN, GH_BIN, GIT_REMOTE (default origin), RELEASE_BRANCH (default main).

import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BOT_EMAIL,
  BOT_NAME,
  buildReleaseNotes,
  changesetCheck,
  classifyTip,
  compareVersions,
  DEFAULT_REGISTRY,
  distTagFor,
  fetchPublishedVersions,
  isAlreadyPublishedError,
  listPendingChangesets,
  MIN_OIDC_NPM,
  planRelease,
  RELEASE_COMMIT_SUBJECT,
  readPublishablePackages,
  releaseGroups,
  tagsFor,
} from "./lib/release.mjs";

const root = resolve(
  process.env.RELEASE_ROOT ?? join(dirname(fileURLToPath(import.meta.url)), ".."),
);
const registry = process.env.RELEASE_REGISTRY ?? DEFAULT_REGISTRY;
const remote = process.env.GIT_REMOTE ?? "origin";
const branch = process.env.RELEASE_BRANCH ?? "main";
const NPM = process.env.NPM_BIN ?? "npm";
const PNPM = process.env.PNPM_BIN ?? "pnpm";
const GH = process.env.GH_BIN ?? "gh";

function log(msg) {
  process.stderr.write(`[release] ${msg}\n`);
}

function fail(msg) {
  process.stderr.write(`::error::${msg}\n`);
  process.exit(1);
}

/** Writes `key=value` to $GITHUB_OUTPUT when running in Actions. */
function output(key, value) {
  const file = process.env.GITHUB_OUTPUT;
  if (file) appendFileSync(file, `${key}=${value}\n`);
}

function summary(markdown) {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (file) appendFileSync(file, `${markdown}\n`);
}

/**
 * Runs a command. `capture` returns stdout/stderr (and echoes them); otherwise output streams.
 * @returns {{ status: number, stdout: string, stderr: string }}
 */
function run(cmd, args, { cwd = root, capture = false, allowFail = false, env } = {}) {
  const res = spawnSync(cmd, args, {
    cwd,
    env: { ...process.env, ...env },
    encoding: "utf8",
    stdio: capture ? ["inherit", "pipe", "pipe"] : "inherit",
  });
  if (res.error) throw res.error;
  const out = { status: res.status ?? 1, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
  if (out.status !== 0 && !allowFail) {
    if (capture) process.stderr.write(out.stdout + out.stderr);
    fail(`${cmd} ${args.join(" ")} exited with ${out.status}`);
  }
  return out;
}

const git = (args, opts) => run("git", args, { capture: true, ...opts });

function parseArgs(argv) {
  const flags = {};
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") {
      rest.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith("--") && a.includes("=")) {
      flags[a.slice(2, a.indexOf("="))] = a.slice(a.indexOf("=") + 1);
    } else if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else flags[key] = true;
    } else rest.push(a);
  }
  return { flags, rest };
}

async function withPublishState(pkgs) {
  return Promise.all(
    pkgs.map(async (p) => {
      const versions = await fetchPublishedVersions(p.name, { registry });
      return { ...p, published: versions.has(p.version) };
    }),
  );
}

function tarballName(name, version) {
  return `${name.replace(/^@/, "").replace("/", "-")}-${version}.tgz`;
}

// ---------------------------------------------------------------------------------------------

async function cmdPlan() {
  const pending = listPendingChangesets(root);
  const pkgs = await withPublishState(readPublishablePackages(root));
  const mode = planRelease({ pendingChangesets: pending, packages: pkgs });
  const unpublished = pkgs.filter((p) => !p.published).map((p) => `${p.name}@${p.version}`);
  output("mode", mode);
  output("pending", String(pending.length));
  output("unpublished", unpublished.join(" "));
  summary(
    `### Release plan: \`${mode}\`\n\n- pending changesets: ${pending.length}\n- unpublished: ${
      unpublished.length ? unpublished.map((u) => `\`${u}\``).join(", ") : "none"
    }`,
  );
  process.stdout.write(`${JSON.stringify({ mode, pending, unpublished }, null, 2)}\n`);
}

function cmdSync() {
  git(["fetch", "--no-tags", remote, branch]);
  const tip = `${remote}/${branch}`;
  const isAncestor =
    git(["merge-base", "--is-ancestor", "HEAD", tip], { allowFail: true }).status === 0;
  const ahead = isAncestor
    ? git(["log", "--format=%ae%x09%s", `HEAD..${tip}`])
        .stdout.split("\n")
        .filter(Boolean)
        .map((line) => {
          const [email, ...subject] = line.split("\t");
          return { email, subject: subject.join("\t") };
        })
    : [];
  const status = classifyTip({ isAncestor, ahead });
  if (status === "fast-forward") {
    log(`${branch} is ahead only by release commits; continuing from ${tip}`);
    git(["checkout", "--detach", tip]);
  } else if (status === "superseded") {
    log(`${branch} has moved on; a newer release run will handle it`);
  }
  output("status", status);
  output("sha", git(["rev-parse", "HEAD"]).stdout.trim());
  process.stdout.write(`${status}\n`);
}

function cmdVersion() {
  const pending = listPendingChangesets(root);
  if (pending.length === 0) {
    log("no pending changesets");
    output("committed", "false");
    return;
  }
  const changeset = process.env.CHANGESET_BIN;
  if (changeset) run(changeset, ["version"]);
  else run(PNPM, ["exec", "changeset", "version"]);
  // Workspace ranges don't change on a bump, but keep the lockfile honest if they ever do.
  if (!process.env.RELEASE_SKIP_LOCKFILE) run(PNPM, ["install", "--lockfile-only"]);
  const pkgs = readPublishablePackages(root);
  const versions = [...new Set(pkgs.map((p) => p.version))];
  const subject = `${RELEASE_COMMIT_SUBJECT} ${versions.map((v) => `v${v}`).join(", ")} [skip ci]`;
  const body = pkgs.map((p) => `- ${p.name}@${p.version}`).join("\n");
  const paths = [".changeset", "packages", "examples", "pnpm-lock.yaml"].filter((p) =>
    existsSync(join(root, p)),
  );
  git(["add", "-A", "--", ...paths]);
  if (git(["diff", "--cached", "--quiet"], { allowFail: true }).status === 0) {
    fail("changeset version produced no changes");
  }
  git(
    [
      "-c",
      `user.name=${BOT_NAME}`,
      "-c",
      `user.email=${BOT_EMAIL}`,
      "commit",
      "-m",
      subject,
      "-m",
      body,
    ],
    { env: { GIT_AUTHOR_NAME: BOT_NAME, GIT_AUTHOR_EMAIL: BOT_EMAIL } },
  );
  output("committed", "true");
  output("sha", git(["rev-parse", "HEAD"]).stdout.trim());
  log(subject);
}

function cmdPush() {
  // Plain push: if main moved since the run started this fails, and the newer run releases.
  git(["push", remote, `HEAD:refs/heads/${branch}`], { capture: false });
}

async function packTo(out, onlyUnpublished) {
  mkdirSync(out, { recursive: true });
  let pkgs = readPublishablePackages(root);
  if (onlyUnpublished) pkgs = (await withPublishState(pkgs)).filter((p) => !p.published);
  const manifest = [];
  for (const p of pkgs) {
    for (const f of p.manifest.files ?? []) {
      if (!existsSync(join(p.dir, f))) fail(`${p.name}: "${f}" is missing. Run pnpm build first.`);
    }
    run(PNPM, ["pack", "--pack-destination", out], { cwd: p.dir, capture: true });
    const file = tarballName(p.name, p.version);
    if (!existsSync(join(out, file))) fail(`pnpm pack did not produce ${file}`);
    manifest.push({ name: p.name, version: p.version, file, tag: distTagFor(p.version) });
  }
  writeFileSync(join(out, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  log(`packed ${manifest.length} package(s) into ${out}`);
  return manifest;
}

async function cmdPack(flags) {
  if (typeof flags.out !== "string") fail("pack needs --out DIR");
  const manifest = await packTo(resolve(flags.out), Boolean(flags["only-unpublished"]));
  output("count", String(manifest.length));
}

function npmTokenEnv() {
  // Bootstrap-only fallback. npm prefers the OIDC token when the exchange succeeds, and falls
  // back to this one when it doesn't (e.g. before a trusted publisher is configured).
  if (!process.env.NPM_TOKEN) return {};
  const dir = mkdtempSync(join(tmpdir(), "flowline-npmrc-"));
  const file = join(dir, ".npmrc");
  const host = registry.replace(/^https?:/, "").replace(/\/?$/, "/");
  writeFileSync(file, `${host}:_authToken=\${NPM_TOKEN}\n`, { mode: 0o600 });
  log("NPM_TOKEN is set: using it as a fallback to trusted publishing");
  return { NPM_CONFIG_USERCONFIG: file };
}

async function cmdPublish(flags, extra) {
  const dryRun = Boolean(flags["dry-run"]);
  const dir =
    typeof flags.dir === "string"
      ? resolve(flags.dir)
      : mkdtempSync(join(tmpdir(), "flowline-pack-"));
  const manifest =
    typeof flags.dir === "string"
      ? JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"))
      : await packTo(dir, true);

  const npmVersion = run(NPM, ["--version"], { capture: true }).stdout.trim();
  log(`npm ${npmVersion}`);
  if (
    process.env.GITHUB_ACTIONS === "true" &&
    !process.env.NPM_TOKEN &&
    !dryRun &&
    compareVersions(npmVersion, MIN_OIDC_NPM) < 0
  ) {
    fail(`trusted publishing needs npm >= ${MIN_OIDC_NPM}, found ${npmVersion}`);
  }
  const env = npmTokenEnv();

  const results = [];
  for (const entry of manifest) {
    const id = `${entry.name}@${entry.version}`;
    if ((await fetchPublishedVersions(entry.name, { registry })).has(entry.version)) {
      log(`${id} is already on the registry; skipping`);
      results.push({ id, result: "skipped" });
      continue;
    }
    const args = ["publish", join(dir, entry.file), "--access", "public", "--tag", entry.tag];
    args.push("--registry", registry);
    if (dryRun) args.push("--dry-run");
    if (typeof flags.otp === "string") args.push(`--otp=${flags.otp}`);
    args.push(...extra);
    log(`${NPM} ${args.join(" ")}`);
    // Interactive (local bootstrap): stream so npm can prompt for an OTP. CI: capture to inspect.
    const interactive = Boolean(process.stdin.isTTY) && process.env.CI !== "true";
    const res = run(NPM, args, { cwd: dir, capture: !interactive, allowFail: true, env });
    if (!interactive) process.stderr.write(res.stdout + res.stderr);
    if (res.status === 0) {
      results.push({ id, result: dryRun ? "dry-run" : "published" });
      continue;
    }
    const nowPublished = (await fetchPublishedVersions(entry.name, { registry })).has(
      entry.version,
    );
    if (nowPublished || isAlreadyPublishedError(res.stdout + res.stderr)) {
      log(`${id} was published concurrently; treating as done`);
      results.push({ id, result: "skipped" });
    } else {
      process.stderr.write(`::error::npm publish failed for ${id}\n`);
      results.push({ id, result: "failed" });
    }
  }
  summary(`### npm publish\n\n${results.map((r) => `- \`${r.id}\`: ${r.result}`).join("\n")}`);
  process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
  if (results.some((r) => r.result === "failed")) process.exit(1);
}

async function cmdGithubRelease(flags) {
  const sha = typeof flags.sha === "string" ? flags.sha : git(["rev-parse", "HEAD"]).stdout.trim();
  const pkgs = await withPublishState(readPublishablePackages(root));
  const missing = pkgs.filter((p) => !p.published);
  if (missing.length) {
    fail(`not on the registry yet: ${missing.map((p) => `${p.name}@${p.version}`).join(", ")}`);
  }

  for (const tag of tagsFor(pkgs)) {
    const remoteRef = git(["ls-remote", "--tags", remote, `refs/tags/${tag}`]).stdout.trim();
    if (remoteRef) {
      if (!remoteRef.startsWith(sha))
        log(`tag ${tag} already exists at another commit; leaving it`);
      continue;
    }
    git(["tag", "-f", tag, sha]);
    git(["push", remote, `refs/tags/${tag}`]);
    log(`pushed tag ${tag}`);
  }

  for (const group of releaseGroups(pkgs)) {
    if (run(GH, ["release", "view", group.tag], { capture: true, allowFail: true }).status === 0) {
      log(`GitHub release ${group.tag} exists; skipping`);
      continue;
    }
    const notes = buildReleaseNotes(group, (name) => {
      const p = pkgs.find((x) => x.name === name);
      const file = p && join(p.dir, "CHANGELOG.md");
      return file && existsSync(file) ? readFileSync(file, "utf8") : null;
    });
    const notesFile = join(mkdtempSync(join(tmpdir(), "flowline-notes-")), "notes.md");
    writeFileSync(notesFile, notes);
    const args = ["release", "create", group.tag, "--verify-tag", "--title", group.title];
    args.push("--notes-file", notesFile);
    if (group.prerelease) args.push("--prerelease");
    run(GH, args, { capture: true });
    log(`created GitHub release ${group.tag}`);
  }
}

function cmdChangesetCheck(flags) {
  if (typeof flags.base !== "string") fail("changeset-check needs --base REF");
  const files = git(["diff", "--name-only", `${flags.base}...HEAD`])
    .stdout.split("\n")
    .filter(Boolean);
  const res = changesetCheck(files);
  if (res.missing) {
    const msg =
      "This PR changes published packages but adds no changeset. Run `pnpm changeset` " +
      "(or `pnpm changeset --empty` if no release is needed). See docs/releasing.md.";
    process.stdout.write(`::warning title=Missing changeset::${msg}\n`);
    summary(`### Missing changeset\n\n${msg}\n\n${res.files.map((f) => `- \`${f}\``).join("\n")}`);
  } else if (res.touchesPackages) {
    log("changeset present");
  } else {
    log("no published package changes");
  }
  output("missing", String(res.missing));
}

const [command, ...argv] = process.argv.slice(2);
const { flags, rest } = parseArgs(argv);
const commands = {
  plan: () => cmdPlan(),
  sync: () => cmdSync(),
  version: () => cmdVersion(),
  push: () => cmdPush(),
  pack: () => cmdPack(flags),
  publish: () => cmdPublish(flags, rest),
  "github-release": () => cmdGithubRelease(flags),
  "changeset-check": () => cmdChangesetCheck(flags),
};
const fn = commands[command];
if (!fn) fail(`unknown command "${command}". One of: ${Object.keys(commands).join(", ")}`);
await fn();
