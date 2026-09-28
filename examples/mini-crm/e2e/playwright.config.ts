import { defineConfig, devices } from "playwright/test";

/**
 * End-to-end tests of the mini CRM: `pnpm --filter @flowkit/example-mini-crm e2e`.
 *
 * Playwright starts its own server and web app on dedicated ports and never reuses a running one,
 * so a `pnpm dev` on the default ports doesn't interfere. Engine storage is in memory, so every
 * suite run starts from the seed workflows, and each test resets the CRM data first.
 */
const SERVER_PORT = 8921;
const WEB_PORT = 5421;

export default defineConfig({
  testDir: ".",
  // One server is shared by all tests and each test resets its data: run them one at a time.
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  timeout: 30_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI ? "github" : "list",
  // Traces of failed tests. Under node_modules so neither git nor Biome picks them up.
  outputDir: "../node_modules/.e2e-results",
  use: {
    baseURL: `http://localhost:${WEB_PORT}`,
    trace: "retain-on-failure",
    viewport: { width: 1440, height: 900 },
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } },
    },
  ],
  webServer: [
    {
      command: "pnpm exec tsx --conditions=flowkit-source server/src/index.ts",
      cwd: "..",
      url: `http://localhost:${SERVER_PORT}/api/demo`,
      reuseExistingServer: false,
      timeout: 60_000,
      env: {
        PORT: String(SERVER_PORT),
        PUBLIC_URL: `http://localhost:${SERVER_PORT}`,
        DATABASE_URL: "",
      },
    },
    {
      command: "pnpm exec vite --config web/vite.config.ts --strictPort",
      cwd: "..",
      url: `http://localhost:${WEB_PORT}`,
      reuseExistingServer: false,
      timeout: 60_000,
      env: { WEB_PORT: String(WEB_PORT), MINI_CRM_API: `http://localhost:${SERVER_PORT}` },
    },
  ],
});
