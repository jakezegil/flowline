import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "mini-crm",
    environment: "node",
    include: ["server/src/**/*.test.ts"],
  },
});
