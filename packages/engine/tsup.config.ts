import { defineConfig } from "tsup";

export default defineConfig({
  entry: { index: "src/index.ts", "testing/index": "src/testing/index.ts" },
  format: ["esm"],
  // `@internal` declarations (e.g. `EngineOptions.__testHooks`) stay out of the public types.
  dts: { compilerOptions: { stripInternal: true } },
  clean: true,
  sourcemap: true,
  external: ["vitest"],
});
