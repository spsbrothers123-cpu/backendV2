// Loaded before any test file. Provides just enough env for src/config/env.ts
// to validate successfully when a test imports a module that pulls it in
// (e.g. lib/invitationCode.ts, lib/jwt.ts) — without needing a real
// database for pure unit tests.
//
// .env.test is loaded FIRST so its DATABASE_URL wins (dotenv never overwrites
// an already-set var). .env is only a fallback for shared, non-DB values.
import dotenv from "dotenv";
import path from "path";

dotenv.config({ path: path.resolve(__dirname, "../.env.test") });
dotenv.config({ path: path.resolve(__dirname, "../.env") });

process.env.NODE_ENV ??= "test";
process.env.DATABASE_URL ??= "postgresql://user:password@localhost:5432/eggmart_test?schema=public";
process.env.JWT_SECRET ??= "test-only-secret-do-not-use-in-production";

// Safety net for integration runs: resetDb() wipes tables, so refuse to start
// unless DATABASE_URL clearly points at a disposable *local* "test" database.
// (Without this, a missing/empty .env.test silently falls back to the DB in
// .env — which is how the earlier run ended up on a slow remote database.)
if (process.env.RUN_INTEGRATION_TESTS) {
  const url = process.env.DATABASE_URL!;
  let dbName = "";
  let host = "";
  try {
    const u = new URL(url);
    dbName = u.pathname.replace(/^\//, "");
    host = u.hostname;
  } catch {
    /* fall through to the throw below */
  }
  const isLocal = host === "localhost" || host === "127.0.0.1" || host === "::1";
  if (!dbName.toLowerCase().includes("test") || !isLocal) {
    throw new Error(
      `Refusing to run integration tests: DATABASE_URL must be a local database whose name contains "test" ` +
        `(got host="${host}", db="${dbName}"). Create backend/.env.test from env.test and set DATABASE_URL there.`
    );
  }
}
