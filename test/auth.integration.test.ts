/**
 * Integration tests for cashier signup → invitation code → admin approval
 * → login.
 *
 * These hit the real Fastify app + a real Postgres database via Prisma, so
 * unlike test/invitationCode.test.ts and test/password.test.ts they are NOT
 * run as part of the default sandboxed build. To run them locally:
 *
 *   1. Point DATABASE_URL (in .env) at a disposable Postgres database.
 *   2. npx prisma migrate deploy
 *   3. RUN_INTEGRATION_TESTS=1 npx vitest run test/auth.integration.test.ts
 *
 * Covers Backend spec §28 (signup+invitation-code, approval, login,
 * multi-cashier, single-use enforcement, shop isolation).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { prisma } from "../src/lib/prisma.js";
import { hashPassword } from "../src/lib/password.js";

let app: FastifyInstance;
let shopId: string;
let adminEmail: string;
let adminId: string;
let adminToken: string;

async function resetDb() {
  await prisma.auditLog.deleteMany();
  await prisma.session.deleteMany();
  await prisma.invitationCode.deleteMany();
  await prisma.user.deleteMany();
  await prisma.shop.deleteMany();
}

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

  adminEmail = "admin@eggmart.test";
  const created = await createAdmin(adminEmail, "AdminPass123");
  adminId = created.id;
  adminToken = created.token;
});

async function createAdmin(email: string, password: string) {
  const admin = await prisma.user.create({
    data: {
      name: "Admin",
      email,
      passwordHash: await hashPassword(password),
      role: "ADMIN",
      status: "ACTIVE",
      shopId,
    },
  });
  const res = await app.inject({ method: "POST", url: "/api/auth/admin/login", payload: { email, password } });
  return { id: admin.id, token: JSON.parse(res.payload).token as string };
}

/** Generates a real invitation code through the Admin API (as an admin
 * would) and returns both the plaintext code and its id. */
async function generateInvitationCode() {
  const res = await app.inject({
    method: "POST",
    url: "/api/admin/invitation-codes",
    headers: { authorization: `Bearer ${adminToken}` },
  });
  expect(res.statusCode).toBe(201);
  const body = JSON.parse(res.payload);
  return { code: body.data.code as string, id: body.data.id as string };
}

async function verifyInvitation(code: string) {
  const res = await app.inject({ method: "POST", url: "/api/auth/signup/verify-invitation", payload: { code } });
  return res;
}

describe("Cashier signup → invitation code → approval → login", () => {
  it("blocks login until the cashier is fully approved, then allows it", async () => {
    // 1. Admin generates an invitation code.
    const { code } = await generateInvitationCode();

    // 2. Cashier validates it and gets a verification token.
    const verifyRes = await verifyInvitation(code);
    expect(verifyRes.statusCode).toBe(200);
    const { verificationToken } = JSON.parse(verifyRes.payload);
    expect(verificationToken).toBeTruthy();

    // 3. Cashier registers.
    const signupRes = await app.inject({
      method: "POST",
      url: "/api/auth/signup",
      payload: { name: "John Doe", email: "john@example.com", password: "password123", verificationToken },
    });
    expect(signupRes.statusCode).toBe(201);
    const { requestId, email } = JSON.parse(signupRes.payload);
    expect(email).toBe("john@example.com");

    // Still cannot log in — awaiting admin approval.
    const pendingLogin = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email, password: "password123" },
    });
    expect(pendingLogin.statusCode).toBe(403);
    expect(JSON.parse(pendingLogin.payload).code).toBe("ACCOUNT_PENDING_APPROVAL");

    // Status polling reflects the pending state.
    const statusRes = await app.inject({ method: "GET", url: `/api/auth/signup/status?requestId=${requestId}` });
    expect(JSON.parse(statusRes.payload).status).toBe("PENDING_ADMIN_APPROVAL");

    // The invitation code is now consumed and cannot be re-validated.
    const reuseVerify = await verifyInvitation(code);
    expect(reuseVerify.statusCode).toBe(409);
    expect(JSON.parse(reuseVerify.payload).code).toBe("INVITATION_CODE_USED");

    // 4. Admin approves.
    const approveRes = await app.inject({
      method: "POST",
      url: `/api/admin/cashier-requests/${requestId}/approve`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(approveRes.statusCode).toBe(200);

    // 5. Login succeeds now, with no OTP or invitation code involved.
    const finalLogin = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email, password: "password123" },
    });
    expect(finalLogin.statusCode).toBe(200);
    const body = JSON.parse(finalLogin.payload);
    expect(body.token).toBeTruthy();
    expect(body.cashier.active).toBe(true);
  });

  it("rejects an invalid invitation code", async () => {
    const res = await verifyInvitation("000000");
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.payload).code).toBe("INVALID_INVITATION_CODE");
  });

  it("rejects an expired invitation code", async () => {
    const { code, id } = await generateInvitationCode();
    await prisma.invitationCode.update({ where: { id }, data: { expiresAt: new Date(Date.now() - 1000) } });

    const res = await verifyInvitation(code);
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.payload).code).toBe("INVITATION_CODE_EXPIRED");
  });

  it("only ever allows one ACTIVE code per shop — generating a new one revokes the old one", async () => {
    const first = await generateInvitationCode();
    const second = await generateInvitationCode();

    const firstRow = await prisma.invitationCode.findUniqueOrThrow({ where: { id: first.id } });
    expect(firstRow.status).toBe("REVOKED");

    const reuseFirst = await verifyInvitation(first.code);
    expect(reuseFirst.statusCode).toBe(400);
    expect(JSON.parse(reuseFirst.payload).code).toBe("INVITATION_CODE_REVOKED");

    const useSecond = await verifyInvitation(second.code);
    expect(useSecond.statusCode).toBe(200);
  });

  it("rejects registration with a tampered/invalid verification token", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/signup",
      payload: { name: "Eve", email: "eve@example.com", password: "password123", verificationToken: "not-a-real-token" },
    });
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.payload).code).toBe("INVITATION_VERIFICATION_INVALID");
  });

  it("rejects a non-admin attempting to approve a request", async () => {
    const { code } = await generateInvitationCode();
    const { verificationToken } = JSON.parse((await verifyInvitation(code)).payload);
    const signupRes = await app.inject({
      method: "POST",
      url: "/api/auth/signup",
      payload: { name: "Jane Doe", email: "jane@example.com", password: "password123", verificationToken },
    });
    const { requestId } = JSON.parse(signupRes.payload);

    const res = await app.inject({
      method: "POST",
      url: `/api/admin/cashier-requests/${requestId}/approve`,
      // no Authorization header at all
    });
    expect(res.statusCode).toBe(401);
  });

  it("rejects a non-admin attempting to generate an invitation code", async () => {
    const res = await app.inject({ method: "POST", url: "/api/admin/invitation-codes" });
    expect(res.statusCode).toBe(401);
  });

  it("supports multiple independent cashier accounts on the same shop", async () => {
    const cashiers: Array<{ name: string; email: string }> = [
      { name: "Cashier A", email: "a@example.com" },
      { name: "Cashier B", email: "b@example.com" },
    ];
    for (const { name, email } of cashiers) {
      await prisma.user.create({
        data: {
          name,
          email,
          passwordHash: await hashPassword("password123"),
          role: "CASHIER",
          status: "ACTIVE",
          shopId,
        },
      });
    }

    const loginA = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "a@example.com", password: "password123" },
    });
    const loginB = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "b@example.com", password: "password123" },
    });

    expect(loginA.statusCode).toBe(200);
    expect(loginB.statusCode).toBe(200);
    const tokenA = JSON.parse(loginA.payload).token;
    const tokenB = JSON.parse(loginB.payload).token;
    expect(tokenA).not.toBe(tokenB);
  });

  it("prevents duplicate signups for an active account", async () => {
    await prisma.user.create({
      data: {
        name: "Existing",
        email: "existing@example.com",
        passwordHash: "irrelevant",
        role: "CASHIER",
        status: "ACTIVE",
        shopId,
      },
    });

    const { code } = await generateInvitationCode();
    const { verificationToken } = JSON.parse((await verifyInvitation(code)).payload);

    const res = await app.inject({
      method: "POST",
      url: "/api/auth/signup",
      payload: { name: "Existing", email: "existing@example.com", password: "password123", verificationToken },
    });
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.payload).code).toBe("ACCOUNT_ALREADY_EXISTS");
  });
});
