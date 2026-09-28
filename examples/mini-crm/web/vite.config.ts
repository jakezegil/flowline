import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defaultClientConditions, defineConfig } from "vite";

/** Where the CRM server listens; `/api` and `/flowline` are proxied to it. */
const target = process.env.MINI_CRM_API ?? "http://localhost:8787";

/** The mini CRM web app: `pnpm --filter @flowlinejs/example-mini-crm dev`. */
export default defineConfig({
  // Run workspace packages from `src` (see /source-conditions.ts).
  resolve: { conditions: ["flowline-source", ...defaultClientConditions] },
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [react()],
  // In dev, the "can't reach the server" message names the address `/api` is proxied to.
  define: { "import.meta.env.VITE_CRM_API_TARGET": JSON.stringify(target) },
  server: {
    port: Number(process.env.WEB_PORT ?? 5173),
    proxy: {
      "/api": { target, changeOrigin: true },
      "/flowline": { target, changeOrigin: true },
    },
  },
  // One bundle is fine for a demo (the editor, CodeMirror and React Flow make it ~750 kB).
  build: { outDir: "dist", emptyOutDir: true, chunkSizeWarningLimit: 1500 },
});
