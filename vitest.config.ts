import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    setupFiles: ["./test/setup.ts"],
    include: ["test/**/*.test.ts"],
    // Integration tests need a real Postgres database (see the file's own
    // header comment) — excluded from the default `npm test` run so CI/dev
    // machines without DATABASE_URL configured still get a green run from
    // the pure unit tests. Run them explicitly with:
    //   RUN_INTEGRATION_TESTS=1 npx vitest run test/billing.integration.test.ts
    exclude: process.env.RUN_INTEGRATION_TESTS
      ? ["node_modules/**"]
      : ["node_modules/**", "test/auth.integration.test.ts", "test/billing.integration.test.ts"],
  },
});