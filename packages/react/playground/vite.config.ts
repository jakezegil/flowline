import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defaultClientConditions, defineConfig } from "vite";

/** Dev-only playground; never part of the package build. */
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [react()],
  // Run workspace packages from `src` (see /source-conditions.ts; inlined here because this
  // package's tsconfig `rootDir` can't reach the repo root).
  resolve: { conditions: ["flowline-source", ...defaultClientConditions] },
  server: { port: 5174, strictPort: false },
});
