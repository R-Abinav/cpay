import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/test/**/*.test.ts", "packages/*/*/test/**/*.test.ts", "apps/*/test/**/*.test.ts"],
    // The ScopeLift SDK's ESM build uses directory imports that Node's ESM loader rejects.
    server: { deps: { inline: ["@scopelift/stealth-address-sdk"] } },
  },
});
