import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    setupFiles: ["./test/setup.ts"],
    include: ["test/**/*.test.ts"],
    exclude: process.env.RUN_INTEGRATION_TESTS
      ? ["node_modules/**"]
      : [
          "node_modules/**",
          "test/auth.integration.test.ts",
          "test/billing.integration.test.ts",
          "test/adminShops.integration.test.ts",
        ],

    fileParallelism: false,
    pool: "forks",
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },

    // Real network round-trips to Supabase (bcrypt + several sequential
    // queries per request) routinely exceed Vitest's 5s/10s defaults.
    // A timed-out test's in-flight promise chain keeps running in the
    // background even after Vitest gives up on it — letting it collide
    // with the next test's resetDb() and throw spurious FK violations.
    // Generous timeouts here aren't just about patience; they prevent
    // that class of false failure entirely.
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});