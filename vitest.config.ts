import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    passWithNoTests: true,
    // Property tests generate hundreds of maps each; the 5 s default is too tight on a loaded or slow machine. Speed budgets are asserted in the tests themselves.
    testTimeout: 20_000,
    include: ["packages/*/src/**/*.test.ts", "packages/*/test/**/*.test.ts", "apps/*/src/**/*.test.ts", "apps/*/test/**/*.test.ts"],
  },
});
