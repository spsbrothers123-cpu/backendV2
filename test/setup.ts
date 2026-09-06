// Loaded before any test file. Provides just enough env for src/config/env.ts
// to validate successfully when a test imports a module that pulls it in
// (e.g. lib/invitationCode.ts, lib/jwt.ts) — without needing a real
// database for pure unit tests.
process.env.NODE_ENV ??= "test";
process.env.DATABASE_URL ??= "postgresql://user:password@localhost:5432/eggmart_test?schema=public";
process.env.JWT_SECRET ??= "test-only-secret-do-not-use-in-production";
