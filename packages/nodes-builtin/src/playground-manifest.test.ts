/**
 * Keeps the React playground's snapshot of the built-in manifest (which the React panel tests also
 * use) in sync with this package. After changing a node or trigger, regenerate it with
 * `pnpm --filter @flowline/nodes-builtin manifest:playground`.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createRegistry } from "@flowline/core";
import { expect, it } from "vitest";
import { builtinPlugin } from "./index";

const file = fileURLToPath(
  new URL("../../react/playground/builtin-manifest.json", import.meta.url),
);

it("the playground's builtin-manifest.json matches the registry's manifest", () => {
  const current = `${JSON.stringify(createRegistry([builtinPlugin]).manifest(), null, 2)}\n`;
  if (process.env.UPDATE_PLAYGROUND_MANIFEST === "1") writeFileSync(file, current);
  expect(
    JSON.parse(readFileSync(file, "utf8")),
    "builtin-manifest.json is stale: run `pnpm --filter @flowline/nodes-builtin manifest:playground`",
  ).toEqual(JSON.parse(current));
});
