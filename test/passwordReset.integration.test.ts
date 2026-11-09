/**
 * The emailed-link password reset is DISABLED for every role (Cashier recovery
 * is now admin-assisted — see test/cashierRecovery.integration.test.ts; Admin
 * recovery uses a passkey/recovery code — test/adminRecoveryFlow.integration.test.ts).
 *
 * These tests pin that down: no email is sent, no token is accepted, there is no
 * fallback, and responses stay enumeration-safe.
 *
 *   RUN_INTEGRATION_TESTS=1 npx vitest run test/passwordReset.integration.test.ts
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import jwt from "jsonwebtoken";
import { buildApp } from "../src/app.js";
import { prisma } from "../src/lib/prisma.js";
import { env } from "../src/config/env.js";
import { hashPassword, verifyPassword } from "../src/lib/password.js";
import { resetDb } from "./dbReset.js";

const enabled = !!process.env.RUN_INTEGRATION_TESTS;
let app: FastifyInstance;
let shopId: string;

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
  if (!enabled) return;
  await resetDb();
  shopId = (await prisma.shop.create({ data: { name: "Test Shop", code: "TEST" } })).id;
});

async function user(role: "ADMIN" | "CASHIER", email: string) {
  return prisma.user.create({
    data: { name: role, email, passwordHash: await hashPassword("OldPassword1"), role, status: "ACTIVE", shopId },
  });
}

describe.skipIf(!enabled)("legacy email-link reset is disabled", () => {
  it("forgot-password gives one generic answer for unknown / admin / cashier emails and sends NOTHING", async () => {
    await user("ADMIN", "admin@example.com");
    await user("CASHIER", "cashier@example.com");
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const bodies: string[] = [];
    for (const email of ["nobody@example.com", "admin@example.com", "cashier@example.com"]) {
      const res = await app.inject({ method: "POST", url: "/api/auth/forgot-password", payload: { email } });
      expect(res.statusCode).toBe(200);
      bodies.push(res.payload);
    }
    expect(new Set(bodies).size).toBe(1);
    // No email transport of any kind was invoked.
    expect(log.mock.calls.flat().join(" ")).not.toMatch(/reset|token|link/i);
    log.mockRestore();
  });

  it("reset-password refuses everything — even a validly signed legacy token for a cashier", async () => {
    const cashier = await user("CASHIER", "cashier@example.com");
    const token = jwt.sign({ userId: cashier.id, purpose: "PASSWORD_RESET", pwFingerprint: "x" }, env.JWT_SECRET, {
      expiresIn: "5m",
    });
    const res = await app.inject({ method: "POST", url: "/api/auth/reset-password", payload: { token, password: "NewPassword1" } });
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.payload).code).toBe("PASSWORD_RESET_DISABLED");
    const row = await prisma.user.findUniqueOrThrow({ where: { id: cashier.id } });
    expect(await verifyPassword("OldPassword1", row.passwordHash)).toBe(true);
  });

  it("reset-password refuses garbage and empty bodies the same way (no fallback)", async () => {
    for (const payload of [{}, { token: "nope", password: "x" }]) {
      const res = await app.inject({ method: "POST", url: "/api/auth/reset-password", payload });
      expect(res.statusCode).toBe(403);
    }
  });
});
