import dotenv from "dotenv";

const isTest = process.env.NODE_ENV === "test";

if (isTest) {
  // Test mode: .env.test ONLY. Never fall back to .env, or a missing key
  // silently resolves to the real (Supabase) database.
  dotenv.config({ path: ".env.test", override: true, quiet: true });

  // Hard guard: refuse to run tests against anything but a local *test* DB.
  const raw = process.env.DATABASE_URL ?? "";
  let host = "";
  let dbName = "";
  try {
    const u = new URL(raw);
    host = u.hostname;
    dbName = u.pathname.replace(/^\//, "");
  } catch {
    throw new Error("Test setup: DATABASE_URL is missing or invalid in .env.test");
  }

  const isLocalHost = host === "localhost" || host === "127.0.0.1";
  if (!isLocalHost || !/test/i.test(dbName)) {
    throw new Error(
      `Refusing to run tests: DATABASE_URL must point to a local database whose name contains "test" (got host "${host}", db "${dbName}").`
    );
  }
} else {
  dotenv.config({ path: ".env", quiet: true });
}
