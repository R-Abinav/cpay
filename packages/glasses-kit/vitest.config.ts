import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["bridge/test/**/*.test.ts"],
    environment: "node",
    testTimeout: 10_000,
  },
});
