// End-to-end simulation of scripts/release.mjs, without the network: a throwaway git repo with a
// bare "origin", a fake npm registry (HTTP), and fake `npm` / `gh` binaries that record what they
// were asked to do. Real `git`, `pnpm pack` and `changeset version` run.

import { execFile } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const exec = promisify(execFile);
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const script = join(repoRoot, "scripts/release.mjs");

const base = mkdtempSync(join(tmpdir(), "release-sim-"));
const work = join(base, "work");
const origin = join(base, "origin.git");
const state = join(base, "registry.json");
const calls = join(base, "calls.jsonl");
const bin = join(base, "bin");

const writeJson = (file, value) => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
};
const readCalls = () =>
  existsSync(calls)
    ? readFileSync(calls, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : [];

// Fake npm: `--version`, and `publish <tgz>` which "uploads" to the registry state file.
const FAKE_NPM = `#!/usr/bin/env node
const { appendFileSync, readFileSync, writeFileSync } = require("node:fs");
const { execFileSync } = require("node:child_process");
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("11.19.1"); process.exit(0); }
const userconfig = process.env.NPM_CONFIG_USERCONFIG;
appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ tool: "npm", args,
  npmrc: userconfig ? readFileSync(userconfig, "utf8") : null }) + "\\n");
if (args[0] !== "publish") process.exit(0);
const pkg = JSON.parse(execFileSync("tar", ["-xzOf", args[1], "package/package.json"], { encoding: "utf8" }));
if (process.env.FAKE_NPM_FAIL === pkg.name) { console.error("npm error code E404\\nnpm error 404 Not Found - PUT"); process.exit(1); }
if (process.env.FAKE_NPM_CONFLICT === pkg.name) {
  console.error("npm error 403 Forbidden - You cannot publish over the previously published versions: " + pkg.version);
  process.exit(1);
}
if (args.includes("--dry-run")) process.exit(0);
const reg = JSON.parse(readFileSync(${JSON.stringify(state)}, "utf8"));
reg[pkg.name] = reg[pkg.name] || {};
reg[pkg.name][pkg.version] = { tag: args[args.indexOf("--tag") + 1], manifest: pkg };
writeFileSync(${JSON.stringify(state)}, JSON.stringify(reg));
`;

// Fake gh: `release view TAG` succeeds only for releases it created; `release create` records.
const FAKE_GH = `#!/usr/bin/env node
const { appendFileSync, existsSync, readFileSync } = require("node:fs");
const args = process.argv.slice(2);
const file = ${JSON.stringify(calls)};
const created = existsSync(file) ? readFileSync(file, "utf8").split("\\n").filter(Boolean).map(JSON.parse)
  .filter((c) => c.tool === "gh" && c.args[1] === "create").map((c) => c.args[2]) : [];
if (args[0] === "release" && args[1] === "view") process.exit(created.includes(args[2]) ? 0 : 1);
const i = args.indexOf("--notes-file");
appendFileSync(file, JSON.stringify({ tool: "gh", args, notes: i >= 0 ? readFileSync(args[i + 1], "utf8") : null }) + "\\n");
`;

let server;
let env;

async function release(args, extraEnv = {}) {
  try {
    const { stdout, stderr } = await exec("node", [script, ...args], {
      cwd: work,
      env: { ...env, ...extraEnv },
    });
    return { code: 0, stdout, stderr };
  } catch (e) {
    return { code: e.code ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

async function git(...args) {
  const { stdout } = await exec("git", args, { cwd: work });
  return stdout.trim();
}

async function outputsOf(args, extraEnv) {
  const file = join(base, `out-${Math.random().toString(36).slice(2)}`);
  writeFileSync(file, "");
  const res = await release(args, { GITHUB_OUTPUT: file, ...extraEnv });
  const out = Object.fromEntries(
    readFileSync(file, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
  );
  return { ...res, out };
}

const registry = () => JSON.parse(readFileSync(state, "utf8"));
const remoteTags = async () =>
  (await git("ls-remote", "--tags", "origin"))
    .split("\n")
    .filter(Boolean)
    .map((l) => l.split("refs/tags/")[1])
    .sort();

beforeAll(async () => {
  writeFileSync(state, "{}");
  mkdirSync(bin);
  writeFileSync(join(bin, "npm"), FAKE_NPM);
  writeFileSync(join(bin, "gh"), FAKE_GH);
  chmodSync(join(bin, "npm"), 0o755);
  chmodSync(join(bin, "gh"), 0o755);

  server = createServer((req, res) => {
    const name = decodeURIComponent(req.url.slice(1));
    const pkg = registry()[name];
    if (!pkg) {
      res.writeHead(404).end("{}");
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ name, versions: pkg }));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));

  // A two-package fixed group, like the real repo but tiny.
  writeJson(join(work, "package.json"), {
    name: "sim",
    private: true,
    packageManager: "pnpm@10.5.2",
  });
  writeFileSync(join(work, "pnpm-workspace.yaml"), 'packages:\n  - "packages/*"\n');
  writeFileSync(join(work, ".gitignore"), "node_modules\n");
  for (const [dir, name, deps] of [
    ["a", "@sim/a", {}],
    ["b", "@sim/b", { "@sim/a": "workspace:^" }],
  ]) {
    writeJson(join(work, "packages", dir, "package.json"), {
      name,
      version: "0.1.0",
      type: "module",
      files: ["dist"],
      dependencies: deps,
      publishConfig: { access: "public" },
    });
    mkdirSync(join(work, "packages", dir, "dist"), { recursive: true });
    writeFileSync(join(work, "packages", dir, "dist/index.js"), "export const x = 1;\n");
  }
  writeJson(join(work, ".changeset/config.json"), {
    changelog: "@changesets/cli/changelog",
    commit: false,
    fixed: [["@sim/a", "@sim/b"]],
    linked: [],
    access: "public",
    baseBranch: "main",
    updateInternalDependencies: "patch",
    ignore: [],
  });
  writeFileSync(join(work, ".changeset/README.md"), "# Changesets\n");
  // Links the workspace packages so `pnpm pack` can resolve `workspace:` ranges (no network).
  await exec("pnpm", ["install", "--offline"], { cwd: work });
  // `changeset version` resolves the changelog generator from the repo.
  mkdirSync(join(work, "node_modules/@changesets"), { recursive: true });
  symlinkSync(
    realpathSync(join(repoRoot, "node_modules/@changesets/cli")),
    join(work, "node_modules/@changesets/cli"),
  );

  await exec("git", ["init", "--bare", "-b", "main", origin]);
  await git("init", "-b", "main");
  await git("config", "user.name", "Sim Dev");
  await git("config", "user.email", "dev@example.com");
  await git("config", "commit.gpgsign", "false");
  await git("config", "tag.gpgsign", "false");
  await git("remote", "add", "origin", origin);
  await git("add", "-A");
  await git("commit", "-m", "feat: initial");
  await git("push", "origin", "main");

  env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    RELEASE_ROOT: work,
    RELEASE_REGISTRY: `http://127.0.0.1:${server.address().port}`,
    NPM_BIN: join(bin, "npm"),
    GH_BIN: join(bin, "gh"),
    CHANGESET_BIN: realpathSync(join(repoRoot, "node_modules/.bin/changeset")),
    RELEASE_SKIP_LOCKFILE: "1",
    GITHUB_ACTIONS: "true",
    CI: "true",
    NPM_TOKEN: "",
    GITHUB_OUTPUT: "",
    GITHUB_STEP_SUMMARY: "",
  };
}, 60_000);

afterAll(() => server?.close());

describe("release simulation", { timeout: 60_000 }, () => {
  const pack = join(base, "pack");

  it("first release: nothing pending, nothing on npm -> publish 0.1.0", async () => {
    const plan = await outputsOf(["plan"]);
    expect(plan.out).toMatchObject({
      mode: "publish",
      pending: "0",
      unpublished: "@sim/a@0.1.0 @sim/b@0.1.0",
    });

    expect((await outputsOf(["pack", "--out", pack, "--only-unpublished"])).out.count).toBe("2");
    const packed = JSON.parse(readFileSync(join(pack, "manifest.json"), "utf8"));
    expect(packed.map((p) => [p.name, p.tag])).toEqual([
      ["@sim/a", "latest"],
      ["@sim/b", "latest"],
    ]);

    const pub = await release(["publish", "--dir", pack]);
    expect(pub.code).toBe(0);
    const reg = registry();
    expect(reg["@sim/a"]["0.1.0"].tag).toBe("latest");
    // pnpm pack rewrote the workspace range.
    expect(reg["@sim/b"]["0.1.0"].manifest.dependencies["@sim/a"]).toBe("^0.1.0");
    const publishes = readCalls().filter((c) => c.tool === "npm");
    expect(publishes.map((c) => c.args.slice(2))).toEqual([
      ["--access", "public", "--tag", "latest", "--registry", env.RELEASE_REGISTRY],
      ["--access", "public", "--tag", "latest", "--registry", env.RELEASE_REGISTRY],
    ]);
    expect(publishes[0].npmrc).toBeNull(); // no token: pure OIDC

    const head = await git("rev-parse", "HEAD");
    expect((await release(["github-release", "--sha", head])).code).toBe(0);
    expect(await remoteTags()).toEqual(["@sim/a@0.1.0", "@sim/b@0.1.0", "v0.1.0"]);
    const created = readCalls().filter((c) => c.tool === "gh");
    expect(created).toHaveLength(1);
    expect(created[0].args.slice(0, 3)).toEqual(["release", "create", "v0.1.0"]);
    expect(created[0].notes).toContain("## @sim/a@0.1.0\n\nInitial release.");
  });

  it("re-running is a no-op", async () => {
    const before = readCalls().length;
    const pub = await release(["publish", "--dir", pack]);
    expect(pub.code).toBe(0);
    expect(pub.stderr).toMatch(/@sim\/a@0\.1\.0 is already on the registry; skipping/);
    expect((await release(["github-release"])).code).toBe(0);
    expect(readCalls().length).toBe(before);
    expect((await outputsOf(["plan"])).out.mode).toBe("none");
  });

  let eventSha;

  it("merge with a changeset -> version, bot commit, publish; a partial failure fails the run", async () => {
    writeFileSync(
      join(work, ".changeset/brave-lions-sing.md"),
      "---\n'@sim/a': minor\n---\n\nAdd a thing.\n",
    );
    await git("add", "-A");
    await git("commit", "-m", "feat: add a thing");
    await git("push", "origin", "main");
    eventSha = await git("rev-parse", "HEAD");

    expect((await outputsOf(["sync"])).out.status).toBe("current");
    expect((await outputsOf(["plan"])).out.mode).toBe("version");

    const v = await outputsOf(["version"]);
    expect(v.code).toBe(0);
    expect(v.out.committed).toBe("true");
    const subject = await git("log", "-1", "--format=%s");
    expect(subject).toBe("chore(release): version packages v0.2.0 [skip ci]");
    expect(await git("log", "-1", "--format=%an <%ae>")).toBe(
      "github-actions[bot] <41898282+github-actions[bot]@users.noreply.github.com>",
    );
    // Fixed group: both bumped, changeset consumed, changelog written.
    expect(JSON.parse(readFileSync(join(work, "packages/b/package.json"), "utf8")).version).toBe(
      "0.2.0",
    );
    expect(existsSync(join(work, ".changeset/brave-lions-sing.md"))).toBe(false);
    expect(readFileSync(join(work, "packages/a/CHANGELOG.md"), "utf8")).toContain("Add a thing.");

    expect((await release(["push"])).code).toBe(0);
    expect(await git("rev-parse", "origin/main")).toBe(await git("rev-parse", "HEAD"));

    const pack2 = join(base, "pack2");
    await release(["pack", "--out", pack2, "--only-unpublished"]);
    const pub = await release(["publish", "--dir", pack2], { FAKE_NPM_FAIL: "@sim/b" });
    expect(pub.code).toBe(1);
    expect(pub.stderr).toMatch(/::error::npm publish failed for @sim\/b@0\.2\.0/);
    expect(Object.keys(registry()["@sim/a"])).toContain("0.2.0");
    expect(Object.keys(registry()["@sim/b"])).not.toContain("0.2.0");
  });

  it("re-run from the original commit fast-forwards over the bot commit and finishes", async () => {
    await git("checkout", "--detach", eventSha); // what actions/checkout gives a re-run
    const sync = await outputsOf(["sync"]);
    expect(sync.out.status).toBe("fast-forward");
    expect(sync.out.sha).toBe(await git("rev-parse", "origin/main"));

    expect((await outputsOf(["plan"])).out).toMatchObject({
      mode: "publish",
      unpublished: "@sim/b@0.2.0",
    });
    const pack3 = join(base, "pack3");
    expect((await outputsOf(["pack", "--out", pack3, "--only-unpublished"])).out.count).toBe("1");
    expect((await release(["publish", "--dir", pack3])).code).toBe(0);
    expect(registry()["@sim/b"]["0.2.0"].manifest.dependencies["@sim/a"]).toBe("^0.2.0");

    expect((await release(["github-release", "--sha", sync.out.sha])).code).toBe(0);
    expect(await remoteTags()).toEqual([
      "@sim/a@0.1.0",
      "@sim/a@0.2.0",
      "@sim/b@0.1.0",
      "@sim/b@0.2.0",
      "v0.1.0",
      "v0.2.0",
    ]);
    const v2 = readCalls().find((c) => c.tool === "gh" && c.args[2] === "v0.2.0");
    expect(v2.notes).toContain("## @sim/a@0.2.0\n\n### Minor Changes");
    expect(v2.notes).toContain("Add a thing.");
    expect((await outputsOf(["plan"])).out.mode).toBe("none");
  });

  it("a run whose commit is no longer the tip (other commits landed) is superseded", async () => {
    await git("checkout", "main");
    await git("reset", "--hard", "origin/main");
    const stale = await git("rev-parse", "HEAD");
    writeFileSync(join(work, "packages/a/dist/index.js"), "export const x = 2;\n");
    await git("commit", "-am", "fix: newer work");
    await git("push", "origin", "main");
    await git("checkout", "--detach", stale);
    expect((await outputsOf(["sync"])).out.status).toBe("superseded");
    await git("checkout", "main");
  });

  it("treats a publish conflict as already published", async () => {
    await git("reset", "--hard", "origin/main");
    for (const p of ["a", "b"]) {
      const f = join(work, "packages", p, "package.json");
      writeJson(f, { ...JSON.parse(readFileSync(f, "utf8")), version: "0.2.1" });
    }
    const pack4 = join(base, "pack4");
    await release(["pack", "--out", pack4, "--only-unpublished"]);
    const pub = await release(["publish", "--dir", pack4], { FAKE_NPM_CONFLICT: "@sim/a" });
    expect(pub.code).toBe(0);
    expect(pub.stderr).toMatch(/@sim\/a@0\.2\.1 was published concurrently/);
  });

  it("uses NPM_TOKEN only as a fallback .npmrc, never inline", async () => {
    const pack5 = join(base, "pack5");
    for (const p of ["a", "b"]) {
      const f = join(work, "packages", p, "package.json");
      writeJson(f, { ...JSON.parse(readFileSync(f, "utf8")), version: "0.2.2" });
    }
    await release(["pack", "--out", pack5, "--only-unpublished"]);
    expect(
      (await release(["publish", "--dir", pack5, "--dry-run"], { NPM_TOKEN: "s3cret" })).code,
    ).toBe(0);
    const last = readCalls()
      .filter((c) => c.tool === "npm")
      .at(-1);
    expect(last.args).toContain("--dry-run");
    expect(last.npmrc).toBe(
      // npm expands the literal ${NPM_TOKEN} itself, so the secret never lands on disk.
      `//127.0.0.1:${new URL(env.RELEASE_REGISTRY).port}/:_authToken=\${NPM_TOKEN}\n`,
    );
    expect(JSON.stringify(last)).not.toContain("s3cret");
    // dry-run published nothing
    expect(registry()["@sim/a"]["0.2.2"]).toBeUndefined();
  });

  it("refuses OIDC publishing with an npm that can't do it", async () => {
    const oldNpm = join(bin, "npm-old");
    writeFileSync(oldNpm, '#!/bin/sh\n[ "$1" = "--version" ] && echo 10.9.2 && exit 0\nexit 0\n');
    chmodSync(oldNpm, 0o755);
    const res = await release(["publish", "--dir", join(base, "pack5")], { NPM_BIN: oldNpm });
    expect(res.code).toBe(1);
    expect(res.stderr).toMatch(/trusted publishing needs npm >= 11\.5\.1, found 10\.9\.2/);
  });

  it("changeset-check warns (exit 0) when package code changes without a changeset", async () => {
    const baseSha = await git("rev-parse", "HEAD");
    await git("checkout", "-b", "feature");
    writeFileSync(join(work, "packages/a/dist/index.js"), "export const x = 3;\n");
    await git("commit", "-am", "fix: no changeset");
    const res = await outputsOf(["changeset-check", "--base", baseSha]);
    expect(res.code).toBe(0);
    expect(res.out.missing).toBe("true");
    expect(res.stdout).toMatch(/::warning title=Missing changeset::/);

    writeFileSync(join(work, ".changeset/odd-cats-run.md"), "---\n'@sim/a': patch\n---\n\nfix\n");
    await git("add", "-A");
    await git("commit", "-m", "chore: changeset");
    expect((await outputsOf(["changeset-check", "--base", baseSha])).out.missing).toBe("false");
  });
});
