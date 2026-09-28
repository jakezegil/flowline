/**
 * Keeps the published package metadata honest: `exports` send anything outside this repo (a
 * `link:`/`file:` dependency, plain Node) to `dist`, and only the `"flowkit-source"` condition
 * picks the TypeScript sources; zod is a peer; React's DOM renderer is a declared peer.
 */
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = join(HERE, "..");
const REPO = join(PKG, "../..");
const PACKAGES = [
  "core",
  "engine",
  "nodes-builtin",
  "react",
  "storage-memory",
  "storage-postgres",
] as const;

interface PackageJson {
  name: string;
  exports: Record<string, Record<string, string>>;
  publishConfig?: { exports?: Record<string, unknown> };
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

function pkg(name: string): PackageJson {
  return JSON.parse(readFileSync(join(REPO, "packages", name, "package.json"), "utf8"));
}

/** Resolves `specifier` from this package with plain Node, plus any extra CLI flags. */
async function nodeResolve(specifier: string, flags: string[] = []): Promise<string> {
  const script = `console.log(import.meta.resolve(${JSON.stringify(specifier)}))`;
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [...flags, "--input-type=module", "-e", script],
    { cwd: PKG },
  );
  return stdout.trim();
}

describe("package exports", () => {
  it.each(PACKAGES)("@flowkit/%s: the source condition comes first, then dist", (name) => {
    const { exports, publishConfig } = pkg(name);
    for (const [key, entry] of Object.entries(exports)) {
      expect(typeof entry, `${name} ${key}`).toBe("object");
      const conditions = Object.keys(entry);
      expect(conditions[0], `${name} ${key}`).toBe("flowkit-source");
      expect(entry["flowkit-source"]).toMatch(/^\.\/src\//);
      expect(entry.default, `${name} ${key}`).toMatch(/^\.\/dist\//);
      if (entry.types !== undefined) expect(entry.types).toMatch(/^\.\/dist\/.*\.d\.ts$/);
      // What npm consumers get is still the dist-only map.
      expect(publishConfig?.exports?.[key], `${name} ${key}`).toBeDefined();
    }
  });

  it.runIf(existsSync(join(REPO, "packages/core/dist/index.js")))(
    "plain Node resolves a built package to dist; the source condition opts into src",
    async () => {
      expect(await nodeResolve("@flowkit/core")).toMatch(/\/packages\/core\/dist\/index\.js$/);
      expect(await nodeResolve("@flowkit/core", ["--conditions=flowkit-source"])).toMatch(
        /\/packages\/core\/src\/index\.ts$/,
      );
    },
  );
});

describe("dependencies", () => {
  it.each(["core", "nodes-builtin", "engine"])("@flowkit/%s takes zod 4 as a peer", (name) => {
    const p = pkg(name);
    expect(p.peerDependencies?.zod).toBe("^4");
    expect(p.dependencies?.zod).toBeUndefined();
    expect(p.devDependencies?.zod).toBeDefined();
  });

  it("@flowkit/react declares react and react-dom as peers", () => {
    const p = pkg("react");
    expect(p.peerDependencies).toMatchObject({ react: ">=19", "react-dom": ">=19" });
  });

  it("@flowkit/engine strips @internal members from its declarations", () => {
    expect(readFileSync(join(REPO, "packages/engine/tsup.config.ts"), "utf8")).toMatch(
      /stripInternal:\s*true/,
    );
    const dts = join(REPO, "packages/engine/dist/index.d.ts");
    if (existsSync(dts)) {
      const dir = join(REPO, "packages/engine/dist");
      const text = readFileSync(dts, "utf8");
      // Declarations are split into chunks; follow the index's relative imports one level.
      const chunks = [...text.matchAll(/from ['"]\.\/([^'"]+)['"]/g)].map((m) =>
        readFileSync(join(dir, m[1]!.replace(/\.js$/, ".d.ts")), "utf8"),
      );
      for (const source of [text, ...chunks]) expect(source).not.toContain("__testHooks");
    }
  });
});
