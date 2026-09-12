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
    // Phase 3's fixtures (twoShopAdminWithCashiers: 3 sequential admin
    // signups + cashier creates + shop switches, each several real
    // round-trips to Supabase) run noticeably more queries per test than
    // earlier phases did. 30s was tuned for those earlier phases and is
    // now routinely too tight for the heavier Phase 3 tests specifically —
    // bumping the ceiling rather than the query count, since the latency
    // here is network RTT to a remote DB, not anything CPU-bound.
    testTimeout: 90000,
    hookTimeout: 90000,
  },
});