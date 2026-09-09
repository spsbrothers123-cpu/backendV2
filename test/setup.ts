// Loaded before any test file. Provides just enough env for src/config/env.ts
// to validate successfully when a test imports a module that pulls it in
// (e.g. lib/invitationCode.ts, lib/jwt.ts) — without needing a real
// database for pure unit tests.
//
// IMPORTANT: we load the real .env FIRST so integration tests (which need a
// real database) pick up the actual DATABASE_URL/JWT_SECRET from .env.
// The placeholders below only kick in as a last-resort fallback — e.g. for
// pure unit tests running somewhere with no .env file at all.
import dotenv from "dotenv";
import path from "path";

// Load .env.test if it exists (test-specific overrides), then .env.
// dotenv.config() never overwrites a var that's already set in process.env,
// so the first file to define a given key wins.
dotenv.config({ path: path.resolve(__dirname, "../.env.test") });
dotenv.config({ path: path.resolve(__dirname, "../.env") });

process.env.NODE_ENV ??= "test";
process.env.DATABASE_URL ??= "postgresql://user:password@localhost:5432/eggmart_test?schema=public";
process.env.JWT_SECRET ??= "test-only-secret-do-not-use-in-production";