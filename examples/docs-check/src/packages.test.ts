/**
 * Keeps the published package metadata honest: `exports` send anything outside this repo (a
 * `link:`/`file:` dependency, plain Node) to `dist`, and only the `"flowkit-source"` condition
 * picks the TypeScript sources; zod is a peer; React's DOM renderer is a declared peer.
 */
import { execFile } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import ts from "typescript";
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

/** Newest modification time (ms) of the files under `dir`, recursively. */
function newestMtime(dir: string): number {
  let newest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    const t = entry.isDirectory() ? newestMtime(path) : statSync(path).mtimeMs;
    if (t > newest) newest = t;
  }
  return newest;
}

/**
 * Whether `packages/engine/dist` was built from the current sources: its `index.d.ts` exists and
 * is no older than the newest file under `src` or the tsup config.
 */
function engineDistIsFresh(): boolean {
  const engine = join(REPO, "packages/engine");
  const dts = join(engine, "dist/index.d.ts");
  if (!existsSync(dts)) return false;
  const sources = Math.max(
    newestMtime(join(engine, "src")),
    statSync(join(engine, "tsup.config.ts")).mtimeMs,
  );
  return statSync(dts).mtimeMs >= sources;
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

  // Runs without a build: each real package.json is installed into a scratch node_modules with
  // empty files at its targets, and plain Node resolves every entry point there.
  it("plain Node resolves every entry point to dist; the source condition opts into src", async () => {
    const root = join(PKG, ".generated", "resolve");
    rmSync(root, { recursive: true, force: true });
    const expected: Record<string, { dist: string; src: string }> = {};
    for (const name of PACKAGES) {
      const p = pkg(name);
      const dir = join(root, "node_modules", "@flowkit", name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "package.json"), JSON.stringify(p));
      for (const [key, entry] of Object.entries(p.exports)) {
        for (const target of [entry["flowkit-source"], entry.default] as string[]) {
          mkdirSync(dirname(join(dir, target)), { recursive: true });
          writeFileSync(join(dir, target), "");
        }
        const specifier = `@flowkit/${name}${key === "." ? "" : key.slice(1)}`;
        expected[specifier] = {
          dist: pathToFileURL(join(dir, entry.default as string)).href,
          src: pathToFileURL(join(dir, entry["flowkit-source"] as string)).href,
        };
      }
    }
    const resolveAll = async (flags: string[]) => {
      const script = `console.log(JSON.stringify(Object.fromEntries(${JSON.stringify(
        Object.keys(expected),
      )}.map((s) => [s, import.meta.resolve(s)]))))`;
      const { stdout } = await promisify(execFile)(
        process.execPath,
        [...flags, "--input-type=module", "-e", script],
        { cwd: root },
      );
      return JSON.parse(stdout) as Record<string, string>;
    };
    const [plain, source] = await Promise.all([
      resolveAll([]),
      resolveAll(["--conditions=flowkit-source"]),
    ]);
    expect(Object.keys(expected)).toContain("@flowkit/engine/testing");
    for (const [specifier, { dist, src }] of Object.entries(expected)) {
      expect(plain[specifier], specifier).toBe(dist);
      expect(source[specifier], specifier).toBe(src);
    }
  });

  it.runIf(existsSync(join(REPO, "packages/core/dist/index.js")))(
    "after a build, the workspace's own @flowkit/core resolves to dist for plain Node",
    async () => {
      expect(await nodeResolve("@flowkit/core")).toMatch(/\/packages\/core\/dist\/index\.js$/);
    },
  );
});

/**
 * Whether a `vite.config.ts`/`vitest.config.ts` source passes the source condition to Vite, read
 * from its syntax tree (so comments and unrelated strings don't count). Accepted:
 * `export default defineConfig({ ...sourceConditions, … })` with `sourceConditions` imported from
 * the repo's `source-conditions.ts`, or `resolve: { conditions: ["flowkit-source", …] }`.
 */
function configSetsSourceCondition(source: string): boolean {
  const file = ts.createSourceFile("config.ts", source, ts.ScriptTarget.Latest, true);
  const importsShared = file.statements.some(
    (s) =>
      ts.isImportDeclaration(s) &&
      ts.isStringLiteral(s.moduleSpecifier) &&
      /(^|\/)source-conditions(\.ts)?$/.test(s.moduleSpecifier.text) &&
      s.importClause?.namedBindings !== undefined &&
      ts.isNamedImports(s.importClause.namedBindings) &&
      s.importClause.namedBindings.elements.some((e) => e.name.text === "sourceConditions"),
  );
  const property = (obj: ts.ObjectLiteralExpression, name: string) =>
    obj.properties.find(
      (p): p is ts.PropertyAssignment =>
        ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === name,
    )?.initializer;
  for (const s of file.statements) {
    if (!ts.isExportAssignment(s) || !ts.isCallExpression(s.expression)) continue;
    const config = s.expression.arguments[0];
    if (!config || !ts.isObjectLiteralExpression(config)) continue;
    const spreadsShared = config.properties.some(
      (p) =>
        ts.isSpreadAssignment(p) &&
        ts.isIdentifier(p.expression) &&
        p.expression.text === "sourceConditions",
    );
    if (spreadsShared && importsShared) return true;
    const resolve = property(config, "resolve");
    const conditions =
      resolve && ts.isObjectLiteralExpression(resolve)
        ? property(resolve, "conditions")
        : undefined;
    const first =
      conditions && ts.isArrayLiteralExpression(conditions) ? conditions.elements[0] : undefined;
    if (first && ts.isStringLiteral(first) && first.text === "flowkit-source") return true;
  }
  return false;
}

/** Every file under `dir` (skipping node_modules and build output) whose name matches `re`. */
function findFiles(dir: string, re: RegExp): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (["node_modules", "dist", ".generated"].includes(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...findFiles(full, re));
    else if (re.test(entry.name)) out.push(full);
  }
  return out;
}

describe("dev entry points run workspace sources", () => {
  const roots = [join(REPO, "packages"), join(REPO, "examples")];

  it("every tsx command (scripts, Playwright webServers) passes the source condition", () => {
    const commands: { where: string; command: string }[] = [];
    for (const file of roots.flatMap((r) => findFiles(r, /^package\.json$/))) {
      const scripts = (JSON.parse(readFileSync(file, "utf8")) as { scripts?: object }).scripts;
      for (const [name, command] of Object.entries(scripts ?? {})) {
        commands.push({ where: `${file} scripts.${name}`, command: String(command) });
      }
    }
    for (const file of roots.flatMap((r) => findFiles(r, /^playwright\.config\.ts$/))) {
      for (const m of readFileSync(file, "utf8").matchAll(/command:\s*"([^"]*)"/g)) {
        commands.push({ where: file, command: m[1] as string });
      }
    }
    const tsx = commands.filter((c) => /\btsx\s/.test(c.command));
    expect(tsx.length).toBeGreaterThan(0);
    for (const { where, command } of tsx) {
      // Each tsx invocation in the command (e.g. both halves of a `concurrently`).
      for (const m of command.matchAll(/\btsx\s+(?:watch\s+)?(\S+)/g)) {
        expect(m[1], `${where}: ${command}`).toBe("--conditions=flowkit-source");
      }
    }
  });

  it("every Vite and Vitest config sets the source condition", () => {
    const configs = roots.flatMap((r) => findFiles(r, /^vite(st)?\.config\.ts$/));
    expect(configs.length).toBeGreaterThanOrEqual(11);
    for (const file of configs) {
      expect(configSetsSourceCondition(readFileSync(file, "utf8")), file).toBe(true);
    }
  });

  it("the config check reads code, not comments or unrelated strings", () => {
    const wrap = (body: string, imports = "") =>
      `import { defineConfig } from "vite";\n${imports}\nexport default defineConfig({\n${body}\n});\n`;
    const imported = 'import { sourceConditions } from "../../source-conditions.ts";';
    // Passing shapes.
    expect(configSetsSourceCondition(wrap("  ...sourceConditions,", imported))).toBe(true);
    expect(
      configSetsSourceCondition(
        wrap('  resolve: { conditions: ["flowkit-source", ...defaultClientConditions] },'),
      ),
    ).toBe(true);
    // Failing shapes: a comment, a stray string, a spread that isn't the shared config, the
    // condition somewhere other than resolve.conditions.
    expect(
      configSetsSourceCondition(wrap('  // resolve: { conditions: ["flowkit-source"] }')),
    ).toBe(false);
    expect(configSetsSourceCondition(wrap("  /* ...sourceConditions */", imported))).toBe(false);
    expect(configSetsSourceCondition(wrap('  define: { x: "flowkit-source" },'))).toBe(false);
    expect(configSetsSourceCondition(wrap("  ...sourceConditions,"))).toBe(false);
    expect(configSetsSourceCondition(wrap('  resolve: { conditions: ["module"] },'))).toBe(false);
  });

  it("source-conditions.ts keeps Vite's own default conditions", async () => {
    const vitePath = createRequire(join(REPO, "examples/mini-crm/package.json")).resolve("vite");
    const vite = (await import(pathToFileURL(vitePath).href)) as {
      defaultClientConditions: string[];
      defaultServerConditions: string[];
    };
    const { sourceConditions, SOURCE_CONDITION } = await import("../../../source-conditions.ts");
    expect(sourceConditions.resolve.conditions).toEqual([
      SOURCE_CONDITION,
      ...vite.defaultClientConditions,
    ]);
    expect(sourceConditions.ssr.resolve.conditions).toEqual([
      SOURCE_CONDITION,
      ...vite.defaultServerConditions,
    ]);
  });
});

describe("dependencies", () => {
  it.each(PACKAGES)("@flowkit/%s takes zod 4 as a peer", (name) => {
    const p = pkg(name);
    expect(p.peerDependencies?.zod).toBe("^4");
    expect(p.dependencies?.zod).toBeUndefined();
    expect(p.devDependencies?.zod).toBeDefined();
  });

  it("@flowkit/react declares react and react-dom as peers", () => {
    const p = pkg("react");
    expect(p.peerDependencies).toMatchObject({ react: ">=19", "react-dom": "^19" });
  });

  it("@flowkit/engine builds its declarations with stripInternal", () => {
    expect(readFileSync(join(REPO, "packages/engine/tsup.config.ts"), "utf8")).toMatch(
      /stripInternal:\s*true/,
    );
  });

  // Reads the built declarations, so it runs only against a dist at least as new as the sources:
  // `pnpm test` before `pnpm build` (no dist, or a stale one) skips it instead of failing.
  it.skipIf(!engineDistIsFresh())(
    "@flowkit/engine strips @internal members from its built declarations",
    () => {
      const dir = join(REPO, "packages/engine/dist");
      const text = readFileSync(join(dir, "index.d.ts"), "utf8");
      // Declarations are split into chunks; follow the index's relative imports one level.
      const chunks = [...text.matchAll(/from ['"]\.\/([^'"]+)['"]/g)].map((m) =>
        readFileSync(join(dir, m[1]!.replace(/\.js$/, ".d.ts")), "utf8"),
      );
      for (const source of [text, ...chunks]) expect(source).not.toContain("__testHooks");
    },
  );
});
