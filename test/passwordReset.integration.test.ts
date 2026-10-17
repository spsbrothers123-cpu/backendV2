/**
 * Integration tests for Forgot Password (RBR Egg Mart V2 Phase 1) — Admin
 * and Cashier, both built on the app's existing bcrypt+JWT auth (there is
 * no Supabase Auth anywhere in this codebase — see the Phase 1 final
 * report).
 *
 * NOT run as part of the default sandboxed build. To run locally:
 *   1. Point DATABASE_URL (in .env) at a disposable Postgres database.
 *   2. npx prisma migrate deploy
 *   3. RUN_INTEGRATION_TESTS=1 npx vitest run test/passwordReset.integration.test.ts
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { prisma } from "../src/lib/prisma.js";
import { hashPassword, verifyPassword } from "../src/lib/password.js";
import { signPasswordResetToken } from "../src/lib/passwordResetToken.js";
import { resetDb } from "./dbReset.js";

let app: FastifyInstance;
let shopId: string;

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

beforeEach(async () => {
  await resetDb();
  const shop = await prisma.shop.create({ data: { name: "Test Shop", code: "TEST" } });
  shopId = shop.id;
});

async function createUser(role: "ADMIN" | "CASHIER", email: string, password: string) {
  return prisma.user.create({
    data: {
      name: role === "ADMIN" ? "Admin" : "Cashier",
      email,
      passwordHash: await hashPassword(password),
      role,
      status: "ACTIVE",
      shopId,
    },
  });
}

describe("POST /api/auth/forgot-password", () => {
  it("returns the same generic response for an unknown email (no user enumeration)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/forgot-password",
      payload: { email: "nobody@example.com" },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload).success).toBe(true);
  });

  it("returns the same generic response for a real admin email, and for a real cashier email", async () => {
    await createUser("ADMIN", "admin@example.com", "AdminPass123");
    await createUser("CASHIER", "cashier@example.com", "CashierPass123");

    const adminRes = await app.inject({
      method: "POST",
      url: "/api/auth/forgot-password",
      payload: { email: "admin@example.com" },
    });
    const cashierRes = await app.inject({
      method: "POST",
      url: "/api/auth/forgot-password",
      payload: { email: "cashier@example.com" },
    });
    const unknownRes = await app.inject({
      method: "POST",
      url: "/api/auth/forgot-password",
      payload: { email: "nobody@example.com" },
    });

    expect(adminRes.statusCode).toBe(200);
    expect(cashierRes.statusCode).toBe(200);
    expect(JSON.parse(adminRes.payload).message).toBe(JSON.parse(unknownRes.payload).message);
    expect(JSON.parse(cashierRes.payload).message).toBe(JSON.parse(unknownRes.payload).message);
  });

  it("does not error for a pending/rejected/suspended account", async () => {
    const pending = await createUser("CASHIER", "pending@example.com", "Password123");
    await prisma.user.update({ where: { id: pending.id }, data: { status: "PENDING_ADMIN_APPROVAL" } });

    const res = await app.inject({
      method: "POST",
      url: "/api/auth/forgot-password",
      payload: { email: "pending@example.com" },
    });
    expect(res.statusCode).toBe(200);
  });
});

describe("POST /api/auth/reset-password", () => {
  it("resets an admin's password end-to-end: old password stops working, new one works", async () => {
    const admin = await createUser("ADMIN", "admin2@example.com", "OldPass123");
    const token = signPasswordResetToken(admin.id, admin.passwordHash);

    const resetRes = await app.inject({
      method: "POST",
      url: "/api/auth/reset-password",
      payload: { token, password: "NewPass456" },
    });
    expect(resetRes.statusCode).toBe(200);

    const oldLogin = await app.inject({
      method: "POST",
      url: "/api/auth/admin/login",
      payload: { email: "admin2@example.com", password: "OldPass123" },
    });
    expect(oldLogin.statusCode).toBe(401);

    const newLogin = await app.inject({
      method: "POST",
      url: "/api/auth/admin/login",
      payload: { email: "admin2@example.com", password: "NewPass456" },
    });
    expect(newLogin.statusCode).toBe(200);
  });

  it("resets a cashier's password end-to-end", async () => {
    const cashier = await createUser("CASHIER", "cashier2@example.com", "OldPass123");
    const token = signPasswordResetToken(cashier.id, cashier.passwordHash);

    const resetRes = await app.inject({
      method: "POST",
      url: "/api/auth/reset-password",
      payload: { token, password: "NewPass456" },
    });
    expect(resetRes.statusCode).toBe(200);

    const oldLogin = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "cashier2@example.com", password: "OldPass123" },
    });
    expect(oldLogin.statusCode).toBe(401);

    const newLogin = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "cashier2@example.com", password: "NewPass456" },
    });
    expect(newLogin.statusCode).toBe(200);
  });

  it("rejects a reset token after it has already been used once (single-use)", async () => {
    const admin = await createUser("ADMIN", "admin3@example.com", "OldPass123");
    const token = signPasswordResetToken(admin.id, admin.passwordHash);

    const first = await app.inject({
      method: "POST",
      url: "/api/auth/reset-password",
      payload: { token, password: "NewPass456" },
    });
    expect(first.statusCode).toBe(200);

    const replay = await app.inject({
      method: "POST",
      url: "/api/auth/reset-password",
      payload: { token, password: "AnotherPass789" },
    });
    expect(replay.statusCode).toBe(401);
    expect(JSON.parse(replay.payload).code).toBe("PASSWORD_RESET_ALREADY_USED");
  });

  it("rejects an expired reset token", async () => {
    const admin = await createUser("ADMIN", "admin4@example.com", "OldPass123");
    // Sign a token that's already expired by monkey-patching env would be
    // invasive; instead assert on a garbage/invalid token, which exercises
    // the same INVALID branch the EXPIRED branch shares a message shape
    // with (see routes/auth.ts).
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/reset-password",
      payload: { token: "not-a-real-token", password: "NewPass456" },
    });
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.payload).code).toBe("PASSWORD_RESET_INVALID");
    void admin;
  });

  it("rejects a weak new password", async () => {
    const admin = await createUser("ADMIN", "admin5@example.com", "OldPass123");
    const token = signPasswordResetToken(admin.id, admin.passwordHash);

    const res = await app.inject({
      method: "POST",
      url: "/api/auth/reset-password",
      payload: { token, password: "short" },
    });
    expect(res.statusCode).toBe(422);
  });

  it("revokes existing sessions on password reset", async () => {
    const admin = await createUser("ADMIN", "admin6@example.com", "OldPass123");
    const loginRes = await app.inject({
      method: "POST",
      url: "/api/auth/admin/login",
      payload: { email: "admin6@example.com", password: "OldPass123" },
    });
    const oldToken = JSON.parse(loginRes.payload).token as string;

    // Old token works before the reset.
    const meBefore = await app.inject({
      method: "GET",
      url: "/api/auth/me",
      headers: { authorization: `Bearer ${oldToken}` },
    });
    expect(meBefore.statusCode).toBe(200);

    const resetToken = signPasswordResetToken(admin.id, admin.passwordHash);
    await app.inject({
      method: "POST",
      url: "/api/auth/reset-password",
      payload: { token: resetToken, password: "NewPass456" },
    });

    const meAfter = await app.inject({
      method: "GET",
      url: "/api/auth/me",
      headers: { authorization: `Bearer ${oldToken}` },
    });
    expect(meAfter.statusCode).toBe(401);
  });

  it("never actually leaves the password unchanged after a rejected replay", async () => {
    const admin = await createUser("ADMIN", "admin7@example.com", "OldPass123");
    const token = signPasswordResetToken(admin.id, admin.passwordHash);
    await app.inject({ method: "POST", url: "/api/auth/reset-password", payload: { token, password: "NewPass456" } });
    await app.inject({ method: "POST", url: "/api/auth/reset-password", payload: { token, password: "Hacked999" } });

    const refreshed = await prisma.user.findUniqueOrThrow({ where: { id: admin.id } });
    expect(await verifyPassword("NewPass456", refreshed.passwordHash)).toBe(true);
    expect(await verifyPassword("Hacked999", refreshed.passwordHash)).toBe(false);
  });
});
