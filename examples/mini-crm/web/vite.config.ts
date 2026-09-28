import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defaultClientConditions, defineConfig } from "vite";

/** Where the CRM server listens; `/api` and `/flowkit` are proxied to it. */
const target = process.env.MINI_CRM_API ?? "http://localhost:8787";

/** The mini CRM web app: `pnpm --filter @flowkit/example-mini-crm dev`. */
export default defineConfig({
  // Run workspace packages from `src` (see /source-conditions.ts).
  resolve: { conditions: ["flowkit-source", ...defaultClientConditions] },
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [react()],
  server: {
    port: Number(process.env.WEB_PORT ?? 5173),
    proxy: {
      "/api": { target, changeOrigin: true },
      "/flowkit": { target, changeOrigin: true },
    },
  },
  // One bundle is fine for a demo (the editor, CodeMirror and React Flow make it ~750 kB).
  build: { outDir: "dist", emptyOutDir: true, chunkSizeWarningLimit: 1500 },
});
