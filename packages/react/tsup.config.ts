import { copyFile } from "node:fs/promises";
import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: true,
  clean: true,
  sourcemap: true,
  // The stylesheet ships as-is (`import "@flowlinejs/react/styles.css"`); its xyflow base import
  // resolves from the consumer's node_modules.
  onSuccess: () => copyFile("src/styles.css", "dist/styles.css"),
});
