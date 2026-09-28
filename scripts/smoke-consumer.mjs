#!/usr/bin/env node
// Installs the packed @flowlinejs/* tarballs into a throwaway npm project and imports every
// published entry point, on whatever Node runs this script. CI runs it on Node 20.18.1 (the
// packages' `engines` floor) and 22: the dev toolchain (Vitest 5, Vite 8) needs Node >= 22.12,
// so this is how the published runtime is checked on the minimum supported Node.
//
//   node scripts/smoke-consumer.mjs DIR     DIR holds the tarballs and manifest.json from
//                                           `node scripts/release.mjs pack --out DIR`

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Optional peers the entry points need at import time. Versions match the workspace's dev pins.
const PEERS = { zod: "4.6.5", react: "19.3.0", "react-dom": "19.3.0" };
// Entry points that import optional peers the smoke test can't load on every Node (vitest).
const SKIP = new Set(["@flowlinejs/engine/conformance"]);

const dir = resolve(process.argv[2] ?? "");
const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
const app = mkdtempSync(join(tmpdir(), "flowline-smoke-"));

const tarballs = Object.fromEntries(manifest.map((m) => [m.name, `file:${join(dir, m.file)}`]));
writeFileSync(
  join(app, "package.json"),
  JSON.stringify(
    {
      name: "flowline-smoke",
      private: true,
      type: "module",
      dependencies: { ...tarballs, ...PEERS },
      // Point inter-package ranges (^0.x) at the local tarballs, not the registry.
      overrides: tarballs,
    },
    null,
    2,
  ),
);

const install = spawnSync("npm", ["install", "--no-audit", "--no-fund", "--engine-strict"], {
  cwd: app,
  stdio: "inherit",
});
if (install.status !== 0) process.exit(install.status ?? 1);

const specifiers = [];
for (const m of manifest) {
  const pkg = JSON.parse(readFileSync(join(app, "node_modules", m.name, "package.json"), "utf8"));
  for (const [sub, target] of Object.entries(pkg.exports ?? { ".": pkg.main })) {
    const spec = sub === "." ? m.name : `${m.name}/${sub.replace(/^\.\//, "")}`;
    const file = typeof target === "string" ? target : (target?.default ?? "");
    if (SKIP.has(spec) || file.endsWith(".css")) continue;
    specifiers.push(spec);
  }
}

const script = `
const specs = ${JSON.stringify(specifiers)};
let failed = 0;
for (const s of specs) {
  try {
    const mod = await import(s);
    console.log("ok  ", s, Object.keys(mod).length + " exports");
  } catch (e) {
    failed++;
    console.error("FAIL", s, e);
  }
}
process.exit(failed ? 1 : 0);
`;
writeFileSync(join(app, "smoke.mjs"), script);
console.log(`Node ${process.version}: importing ${specifiers.length} entry points`);
const res = spawnSync(process.execPath, ["smoke.mjs"], { cwd: app, stdio: "inherit" });
process.exit(res.status ?? 1);
