import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  BOT_EMAIL,
  buildReleaseNotes,
  changesetCheck,
  classifyTip,
  compareVersions,
  distTagFor,
  extractChangelogSection,
  fetchPublishedVersions,
  isAlreadyPublishedError,
  isEmptyChangeset,
  listPendingChangesets,
  listReleasableChangesets,
  planRelease,
  RELEASE_COMMIT_SUBJECT,
  readPublishablePackages,
  releaseGroups,
  tagsFor,
  topoSort,
  waitForVersion,
} from "./release.mjs";

const pkg = (name, deps = {}, extra = {}) => ({ name, manifest: { dependencies: deps, ...extra } });

describe("topoSort", () => {
  it("puts dependencies first and ignores peer cycles", () => {
    const order = topoSort([
      pkg("@f/storage-memory", { "@f/engine": "workspace:^", "@f/core": "workspace:^" }),
      pkg(
        "@f/engine",
        { "@f/core": "workspace:^" },
        { peerDependencies: { "@f/storage-memory": "*" } },
      ),
      pkg("@f/core"),
      pkg("@f/react", { "@f/core": "workspace:^", react: "19" }),
    ]).map((p) => p.name);
    expect(order).toEqual(["@f/core", "@f/engine", "@f/react", "@f/storage-memory"]);
  });

  it("throws on a real dependency cycle", () => {
    expect(() => topoSort([pkg("a", { b: "1" }), pkg("b", { a: "1" })])).toThrow(/cycle/);
  });
});

describe("workspace readers", () => {
  const root = mkdtempSync(join(tmpdir(), "release-lib-"));
  const write = (rel, content) => {
    mkdirSync(join(root, rel, ".."), { recursive: true });
    writeFileSync(join(root, rel), typeof content === "string" ? content : JSON.stringify(content));
  };
  write("packages/core/package.json", { name: "@f/core", version: "0.1.0" });
  write("packages/engine/package.json", {
    name: "@f/engine",
    version: "0.1.0",
    dependencies: { "@f/core": "workspace:^" },
  });
  write("packages/internal/package.json", { name: "internal", version: "0.0.0", private: true });
  write("packages/notapkg/README.md", "nothing here");
  write(".changeset/README.md", "readme");
  write(".changeset/config.json", {});
  write(".changeset/brave-lions-sing.md", "---\n'@f/core': minor\n---\n\nx");

  it("reads non-private packages in dependency order", () => {
    expect(readPublishablePackages(root).map((p) => [p.name, p.version])).toEqual([
      ["@f/core", "0.1.0"],
      ["@f/engine", "0.1.0"],
    ]);
  });

  it("lists pending changesets but not the README", () => {
    expect(listPendingChangesets(root)).toEqual(["brave-lions-sing.md"]);
  });
});

describe("fetchPublishedVersions", () => {
  const fakeFetch = (status, body) => async (url, init) => {
    fakeFetch.last = { url, init };
    return { status, ok: status >= 200 && status < 300, json: async () => body };
  };

  it("returns the version set and encodes the scope", async () => {
    const f = fakeFetch(200, { versions: { "0.1.0": {}, "0.2.0": {} } });
    const versions = await fetchPublishedVersions("@flowlinejs/core", {
      fetch: f,
      registry: "https://r.example/",
    });
    expect([...versions]).toEqual(["0.1.0", "0.2.0"]);
    expect(fakeFetch.last.url).toBe("https://r.example/@flowlinejs%2Fcore");
  });

  it("treats 404 as a package that doesn't exist yet", async () => {
    expect((await fetchPublishedVersions("@f/x", { fetch: fakeFetch(404, {}) })).size).toBe(0);
  });

  it("throws on 4xx errors instead of guessing", async () => {
    await expect(fetchPublishedVersions("@f/x", { fetch: fakeFetch(401, {}) })).rejects.toThrow(
      /401/,
    );
  });

  // A scripted fetch: each call takes the next response (or throws it if it's an Error).
  const scripted = (...responses) => {
    const calls = [];
    const f = async (url, init) => {
      calls.push({ url, init });
      const r = responses.shift();
      if (r instanceof Error) throw r;
      return { status: r.status, ok: r.status < 300, json: async () => r.body ?? {} };
    };
    return { f, calls };
  };
  const noSleep = async () => {};

  it("retries 5xx and network errors with backoff, then gives up", async () => {
    const delays = [];
    const sleep = async (ms) => void delays.push(ms);
    const { f } = scripted({ status: 503 }, new TypeError("fetch failed"), {
      status: 200,
      body: { versions: { "1.0.0": {} } },
    });
    const v = await fetchPublishedVersions("@f/x", { fetch: f, sleep, delayMs: 100 });
    expect([...v]).toEqual(["1.0.0"]);
    expect(delays).toEqual([100, 200]);

    const { f: always503 } = scripted(...Array(5).fill({ status: 503 }));
    await expect(
      fetchPublishedVersions("@f/x", { fetch: always503, sleep: noSleep, retries: 2 }),
    ).rejects.toThrow(/503/);
  });

  it("bypasses the CDN when fresh", async () => {
    const { f, calls } = scripted({ status: 404 });
    await fetchPublishedVersions("@f/x", { fetch: f, registry: "https://r.example", fresh: true });
    expect(calls[0].url).toMatch(/^https:\/\/r\.example\/@f%2Fx\?cache-bust=\d+-0$/);
    expect(calls[0].init.headers["cache-control"]).toBe("no-cache");
  });
});

describe("waitForVersion", () => {
  const seq = (...bodies) => {
    const calls = [];
    const f = async (url) => {
      calls.push(url);
      const b = bodies.shift();
      return b === 404
        ? { status: 404, ok: false, json: async () => ({}) }
        : { status: 200, ok: true, json: async () => ({ versions: b }) };
    };
    return { f, calls };
  };

  it("polls with fresh reads until a just-published version shows up (CDN lag)", async () => {
    const delays = [];
    const { f, calls } = seq(404, { "0.1.0": {} }, { "0.1.0": {}, "0.2.0": {} });
    const ok = await waitForVersion("@f/x", "0.2.0", {
      fetch: f,
      delayMs: 10,
      sleep: async (ms) => void delays.push(ms),
    });
    expect(ok).toBe(true);
    expect(calls).toHaveLength(3);
    expect(calls.every((u) => u.includes("?cache-bust="))).toBe(true);
    expect(delays).toEqual([10, 20]);
  });

  it("returns false after the last attempt", async () => {
    const { f, calls } = seq(404, 404, 404);
    expect(
      await waitForVersion("@f/x", "0.2.0", { fetch: f, attempts: 3, sleep: async () => {} }),
    ).toBe(false);
    expect(calls).toHaveLength(3);
  });
});

describe("empty changesets", () => {
  it("recognises `changeset --empty` output", () => {
    expect(isEmptyChangeset("---\n---\n")).toBe(true);
    expect(isEmptyChangeset("---\n---\n\nNo release: refactor only.\n")).toBe(true);
    expect(isEmptyChangeset("---\r\n\r\n---\r\n")).toBe(true);
    expect(isEmptyChangeset("---\n'@f/core': patch\n---\n\nFix.\n")).toBe(false);
    expect(isEmptyChangeset("no frontmatter")).toBe(false);
  });

  it("aren't releasable on their own", () => {
    const root = mkdtempSync(join(tmpdir(), "release-empty-"));
    mkdirSync(join(root, ".changeset"));
    writeFileSync(join(root, ".changeset/quiet-owls-nap.md"), "---\n---\n\nrefactor\n");
    expect(listPendingChangesets(root)).toEqual(["quiet-owls-nap.md"]);
    expect(listReleasableChangesets(root)).toEqual([]);
    writeFileSync(join(root, ".changeset/loud-dogs-bark.md"), "---\n'@f/core': patch\n---\n\nx\n");
    expect(listReleasableChangesets(root)).toEqual(["loud-dogs-bark.md"]);
  });
});

describe("planRelease", () => {
  const packages = (...published) =>
    published.map((p, i) => ({ name: `p${i}`, version: "1.0.0", published: p }));

  it("versions when changesets are pending, even if everything is published", () => {
    expect(planRelease({ pendingChangesets: ["a.md"], packages: packages(true) })).toBe("version");
  });
  it("publishes when a version is missing from the registry (first release / re-run)", () => {
    expect(planRelease({ pendingChangesets: [], packages: packages(true, false) })).toBe("publish");
  });
  it("does nothing when everything is published", () => {
    expect(planRelease({ pendingChangesets: [], packages: packages(true, true) })).toBe("none");
  });
});

describe("distTagFor", () => {
  it("publishes 0.x and stable versions to latest, prereleases to next", () => {
    expect(distTagFor("0.1.0")).toBe("latest");
    expect(distTagFor("1.2.3")).toBe("latest");
    expect(distTagFor("1.0.0-rc.1")).toBe("next");
  });
});

describe("classifyTip", () => {
  const bot = {
    email: BOT_EMAIL,
    subject: `${RELEASE_COMMIT_SUBJECT} v0.2.0 [skip ci]`,
    files: [
      ".changeset/brave-lions-sing.md",
      "packages/core/CHANGELOG.md",
      "packages/core/package.json",
      "pnpm-lock.yaml",
    ],
  };
  it("doesn't trust a bot-identity commit that touches code", () => {
    const forged = { ...bot, files: [...bot.files, "packages/core/src/index.ts"] };
    expect(classifyTip({ isAncestor: true, ahead: [forged] })).toBe("superseded");
    expect(classifyTip({ isAncestor: true, ahead: [{ ...bot, files: [] }] })).toBe("superseded");
    expect(
      classifyTip({ isAncestor: true, ahead: [{ ...bot, files: [".github/workflows/x.yml"] }] }),
    ).toBe("superseded");
  });
  it("is current when nothing is ahead", () => {
    expect(classifyTip({ isAncestor: true, ahead: [] })).toBe("current");
  });
  it("fast-forwards over our own release commit (re-run after a failed publish)", () => {
    expect(classifyTip({ isAncestor: true, ahead: [bot] })).toBe("fast-forward");
  });
  it("is superseded by any other commit", () => {
    expect(
      classifyTip({ isAncestor: true, ahead: [bot, { email: "me@x", subject: "feat: y" }] }),
    ).toBe("superseded");
  });
  it("doesn't trust a lookalike subject from a human", () => {
    expect(classifyTip({ isAncestor: true, ahead: [{ ...bot, email: "me@x" }] })).toBe(
      "superseded",
    );
  });
  it("is superseded when main was rewritten", () => {
    expect(classifyTip({ isAncestor: false, ahead: [] })).toBe("superseded");
  });
});

const CHANGELOG = `# @flowlinejs/core

## 0.3.0

### Minor Changes

- abc123: Add triggers.

## 0.2.0

### Patch Changes

- def456: Fix a thing.
`;

describe("changelog and release notes", () => {
  it("extracts one version's section", () => {
    expect(extractChangelogSection(CHANGELOG, "0.3.0")).toBe(
      "### Minor Changes\n\n- abc123: Add triggers.",
    );
    expect(extractChangelogSection(CHANGELOG, "0.2.0")).toBe(
      "### Patch Changes\n\n- def456: Fix a thing.",
    );
    expect(extractChangelogSection(CHANGELOG, "9.9.9")).toBeNull();
  });

  it("makes one combined release for a fixed group", () => {
    const groups = releaseGroups([
      { name: "@f/core", version: "0.3.0" },
      { name: "@f/engine", version: "0.3.0" },
    ]);
    expect(groups.map((g) => [g.tag, g.prerelease, g.packages.length])).toEqual([
      ["v0.3.0", false, 2],
    ]);
    const notes = buildReleaseNotes(groups[0], (name) => (name === "@f/core" ? CHANGELOG : null));
    expect(notes).toContain("## @f/core@0.3.0\n\n### Minor Changes\n\n- abc123: Add triggers.");
    expect(notes).toContain("## @f/engine@0.3.0\n\nInitial release.");
    expect(notes).toContain("https://www.npmjs.com/package/@f/core/v/0.3.0");
  });

  it("falls back to per-package releases when versions differ", () => {
    const groups = releaseGroups([
      { name: "@f/core", version: "0.3.0" },
      { name: "@f/engine", version: "0.4.0-rc.0" },
    ]);
    expect(groups.map((g) => [g.tag, g.prerelease])).toEqual([
      ["@f/core@0.3.0", false],
      ["@f/engine@0.4.0-rc.0", true],
    ]);
  });

  it("tags every package plus the group", () => {
    expect(
      tagsFor([
        { name: "@f/core", version: "0.3.0" },
        { name: "@f/engine", version: "0.3.0" },
      ]),
    ).toEqual(["@f/core@0.3.0", "@f/engine@0.3.0", "v0.3.0"]);
  });
});

describe("isAlreadyPublishedError", () => {
  it("recognises npm's conflict messages", () => {
    expect(
      isAlreadyPublishedError(
        "npm error code E403\nnpm error 403 403 Forbidden - PUT https://registry.npmjs.org/@f%2fcore - You cannot publish over the previously published versions: 0.1.0.",
      ),
    ).toBe(true);
    expect(isAlreadyPublishedError("npm ERR! code EPUBLISHCONFLICT")).toBe(true);
  });
  it("doesn't mistake auth failures for conflicts", () => {
    expect(isAlreadyPublishedError("npm error code E404\nnpm error 404 Not Found - PUT")).toBe(
      false,
    );
    expect(isAlreadyPublishedError("npm error code ENEEDAUTH")).toBe(false);
  });
});

describe("changesetCheck", () => {
  it("flags package source changes without a changeset", () => {
    expect(changesetCheck(["packages/core/src/a.ts", "README.md"])).toMatchObject({
      touchesPackages: true,
      hasChangeset: false,
      missing: true,
      files: ["packages/core/src/a.ts"],
    });
  });
  it("accepts a changeset", () => {
    expect(changesetCheck(["packages/core/src/a.ts", ".changeset/odd-cats-run.md"]).missing).toBe(
      false,
    );
  });
  it("ignores tests, fixtures, markdown and the playground", () => {
    expect(
      changesetCheck([
        "packages/core/src/a.test.ts",
        "packages/react/src/b.test.tsx",
        "packages/engine/src/__fixtures__/x.json",
        "packages/core/README.md",
        "packages/react/playground/main.tsx",
      ]).touchesPackages,
    ).toBe(false);
  });
  it("doesn't count the changeset README or config as a changeset", () => {
    expect(changesetCheck(["packages/core/package.json", ".changeset/README.md"]).missing).toBe(
      true,
    );
    expect(changesetCheck(["packages/core/package.json", ".changeset/config.json"]).missing).toBe(
      true,
    );
  });
  it("doesn't care about changes outside packages/", () => {
    expect(changesetCheck(["examples/mini-crm/web/src/app.tsx"]).missing).toBe(false);
  });
});

describe("compareVersions", () => {
  it("orders npm versions", () => {
    expect(compareVersions("10.9.2", "11.5.1")).toBe(-1);
    expect(compareVersions("11.5.1", "11.5.1")).toBe(0);
    expect(compareVersions("11.19.1", "11.5.1")).toBe(1);
  });
});
