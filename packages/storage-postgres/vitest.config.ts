import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "storage-postgres",
    environment: "node",
  },
});
