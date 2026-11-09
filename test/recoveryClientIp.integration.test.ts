/**
 * Phase 5/6 — the per-IP recovery limit must key on the real client address,
 * never on a client-supplied X-Forwarded-For. End to end through the real app
 * and a real Postgres.
 *
 * Run: RUN_INTEGRATION_TESTS=1 npx vitest run test/recoveryClientIp.integration.test.ts
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { prisma } from "../src/lib/prisma.js";
import { RECOVERY_THROTTLE } from "../src/lib/recoveryThrottle.js";
import { resetDb } from "./dbReset.js";

const enabled = !!process.env.RUN_INTEGRATION_TESTS;
const d = enabled ? describe : describe.skip;
const CODE = "AAAA-AAAA-AAAA-AAAA-AAAA-AAAA-AAAA-AAAA";
const URL = "/api/auth/admin/recovery/code/verify";

let app: FastifyInstance;
beforeAll(async () => {
  if (!enabled) return;
  app = await buildApp();
  await app.ready();
});
afterAll(async () => {
  if (!enabled) return;
  await app.close();
  await prisma.$disconnect();
});
beforeEach(async () => {
  if (enabled) await resetDb();
});

const attempt = (email: string, forwardedFor: string) =>
  app.inject({
    method: "POST",
    url: URL,
    payload: { email, code: CODE },
    headers: { "x-forwarded-for": forwardedFor },
  });

d("recovery throttling cannot be bypassed by forging X-Forwarded-For", () => {
  it("blocks the real client after the per-IP limit even though every request claims a new IP", async () => {
    const limit = RECOVERY_THROTTLE.ip.maxFailures;
    // A different email each time, so only the IP limit (not the per-account one) can trigger.
    for (let i = 0; i < limit; i++) {
      const res = await attempt(`probe${i}@example.com`, `198.51.100.${i + 1}`);
      expect(res.statusCode).toBe(400);
    }
    const blocked = await attempt("probe-final@example.com", "203.0.113.99");
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json().code).toBe("RECOVERY_THROTTLED");
  });

  it("records the connection's address in the audit trail, never the forged one", async () => {
    await attempt("someone@example.com", "9.9.9.9");
    const rows = await prisma.adminRecoveryAudit.findMany({ where: { event: "CODE_VERIFICATION" } });
    expect(rows).toHaveLength(1);
    expect(rows[0].ip).not.toBe("9.9.9.9");
    expect(rows[0].ip).toBeTruthy();
  });
});
