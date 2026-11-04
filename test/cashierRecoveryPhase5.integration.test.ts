/**
 * Phase 5 supplement — cases the Phase 2 suite (cashierRecovery.integration.test.ts)
 * does not exercise directly:
 *   16/17  recovery across several branches while the Admin actually SWITCHES shops
 *   15/20  other Cashiers' passwords/sessions untouched; a pending request never locks login;
 *          a recovered Cashier reaches ordinary POS APIs with a normal login
 *   legacy the old emailed-link endpoints stay inert
 *   e2e    expired code -> fresh request -> approve -> reset
 *
 * Needs a disposable LOCAL Postgres (test setup refuses anything else):
 *   RUN_INTEGRATION_TESTS=1 npx vitest run test/cashierRecoveryPhase5.integration.test.ts
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { prisma } from "../src/lib/prisma.js";
import { env } from "../src/config/env.js";
import { hashPassword } from "../src/lib/password.js";
import { resetDb } from "./dbReset.js";
import { createAdminFixture } from "./adminFixture.js";

const enabled = !!process.env.RUN_INTEGRATION_TESTS;
const OLD = "OldPassword1";
const NEW = "BrandNewPass9";
const ADMIN_PW = "Password123";
const envMut = env as unknown as { CENTRAL_ADMIN_USER_ID?: string };

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
  if (!enabled) return;
  await resetDb();
  envMut.CENTRAL_ADMIN_USER_ID = undefined;
});

const auth = (token?: string) => (token ? { authorization: `Bearer ${token}` } : {});
const post = (url: string, payload: unknown, token?: string) =>
  app.inject({ method: "POST", url, payload: payload as object, headers: auth(token) });
const get = (url: string, token?: string) => app.inject({ method: "GET", url, headers: auth(token) });
const json = (r: { payload: string }) => JSON.parse(r.payload);

async function cashier(shopId: string, email: string, name = "Cashier") {
  return prisma.user.create({
    data: { name, email, passwordHash: await hashPassword(OLD), role: "CASHIER", status: "ACTIVE", shopId },
  });
}
const login = (email: string, password = OLD) => post("/api/auth/login", { email, password });
const request = (email: string) => post("/api/auth/cashier-recovery/request", { email });
const reset = (email: string, code: string, newPassword = NEW) =>
  post("/api/auth/cashier-recovery/reset", { email, code, newPassword });
const approve = (token: string, id: string) =>
  post(`/api/admin/cashier-recovery/${id}/approve`, { currentPassword: ADMIN_PW, identityVerified: true }, token);
const reqFor = (userId: string) => prisma.cashierRecoveryRequest.findFirstOrThrow({ where: { userId }, orderBy: { createdAt: "desc" } });
async function backdate(id: string, minutes: number) {
  await prisma.$executeRaw`UPDATE cashier_recovery_requests SET "createdAt" = "createdAt" - make_interval(mins => ${minutes}::int), "expiresAt" = "expiresAt" - make_interval(mins => ${minutes}::int) WHERE id = ${id}`;
}
describe.skipIf(!enabled)("16/17 — recovery across branches while the Admin switches shops", () => {
  it("central Admin approves cashiers of every shop (owned or not) from whichever shop is selected", async () => {
    const a = await createAdminFixture(app, { email: "central@rbr.test", shopLocation: "Veerapandi" });
    const b = await createAdminFixture(app, { email: "central@rbr.test", shopLocation: "Gandhipuram" });
    const outsider = await createAdminFixture(app, { email: "other@rbr.test", shopLocation: "Singanallur" });
    envMut.CENTRAL_ADMIN_USER_ID = a.user.id;

    const shops = [a.shop.id, b.shop.id, outsider.shop.id];
    const emails = ["ca@rbr.test", "cb@rbr.test", "cc@rbr.test"];
    const users = await Promise.all(emails.map((e, i) => cashier(shops[i], e, `Cashier ${i}`)));
    for (const e of emails) expect((await request(e)).statusCode).toBe(200);

    // Select shop B (the Admin owns A and B, NOT the outsider's shop).
    expect((await post("/api/admin/shops/switch", { shopId: b.shop.id }, b.token)).statusCode).toBe(200);
    expect(json(await get("/api/admin/cashier-recovery", b.token)).data).toHaveLength(3);

    for (const [i, u] of users.entries()) {
      // Flip the selected shop between approvals: it must never matter.
      const target = i % 2 === 0 ? a.shop.id : b.shop.id;
      expect((await post("/api/admin/shops/switch", { shopId: target }, b.token)).statusCode).toBe(200);
      const res = await approve(b.token, (await reqFor(u.id)).id);
      expect(res.statusCode).toBe(200);
      expect((await reset(emails[i], json(res).data.code)).statusCode).toBe(200);
      expect((await login(emails[i], NEW)).statusCode).toBe(200);
    }
  });
});

describe.skipIf(!enabled)("15/20 — nobody else is affected; POS access works after recovery", () => {
  it("a pending/approved request never locks login, and recovering X leaves Y untouched", async () => {
    const admin = await createAdminFixture(app, { email: "central@rbr.test", shopLocation: "Veerapandi" });
    envMut.CENTRAL_ADMIN_USER_ID = admin.user.id;
    const x = await cashier(admin.shop.id, "x@rbr.test", "X");
    const y = await cashier(admin.shop.id, "y@rbr.test", "Y");
    const yBefore = await prisma.user.findUniqueOrThrow({ where: { id: y.id } });
    const yToken = json(await login("y@rbr.test")).token as string;

    await request("x@rbr.test");
    expect((await login("x@rbr.test", OLD)).statusCode).toBe(200); // pending: login still fine
    const approved = await approve(admin.token, (await reqFor(x.id)).id);
    expect((await login("x@rbr.test", OLD)).statusCode).toBe(200); // approved, not yet redeemed: still fine
    const xOldToken = json(await login("x@rbr.test")).token as string;

    expect((await reset("x@rbr.test", json(approved).data.code)).statusCode).toBe(200);

    expect((await get("/api/auth/me", xOldToken)).statusCode).toBe(401); // X signed out everywhere
    expect((await get("/api/auth/me", yToken)).statusCode).toBe(200); // Y's session survives
    expect((await login("y@rbr.test", OLD)).statusCode).toBe(200);
    const yAfter = await prisma.user.findUniqueOrThrow({ where: { id: y.id } });
    expect(yAfter.passwordHash).toBe(yBefore.passwordHash);
    expect(await prisma.session.count({ where: { userId: y.id, revokedAt: { not: null } } })).toBe(0);
  });

  it("a recovered Cashier logs in normally and reaches ordinary POS APIs", async () => {
    const admin = await createAdminFixture(app, { email: "central@rbr.test", shopLocation: "Veerapandi" });
    envMut.CENTRAL_ADMIN_USER_ID = admin.user.id;
    const c = await cashier(admin.shop.id, "c@rbr.test");
    await request("c@rbr.test");
    const code = json(await approve(admin.token, (await reqFor(c.id)).id)).data.code as string;
    await reset("c@rbr.test", code);

    const token = json(await login("c@rbr.test", NEW)).token as string;
    const me = await get("/api/auth/me", token);
    expect(me.statusCode).toBe(200);
    expect(json(me).role).toBe("cashier");
    const products = await get("/api/products", token);
    expect([401, 403]).not.toContain(products.statusCode);
    // …and the recovery code is not a credential anywhere else.
    expect((await get("/api/products", code)).statusCode).toBe(401);
  });
});

describe.skipIf(!enabled)("legacy — the old emailed-link endpoints are inert", () => {
  it("forgot-password sends/creates nothing and answers identically; reset-password always refuses", async () => {
    const admin = await createAdminFixture(app, { email: "central@rbr.test", shopLocation: "Veerapandi" });
    envMut.CENTRAL_ADMIN_USER_ID = admin.user.id;
    const c = await cashier(admin.shop.id, "c@rbr.test");

    const known = await post("/api/auth/forgot-password", { email: "c@rbr.test" });
    const unknown = await post("/api/auth/forgot-password", { email: "nobody@rbr.test" });
    expect(known.statusCode).toBe(unknown.statusCode);
    expect(known.payload).toBe(unknown.payload);
    expect(await prisma.cashierRecoveryRequest.count({ where: { userId: c.id } })).toBe(0);

    const res = await post("/api/auth/reset-password", { token: "anything", password: NEW });
    expect(res.statusCode).toBe(403);
    expect(json(res).code).toBe("PASSWORD_RESET_DISABLED");
    expect((await login("c@rbr.test", NEW)).statusCode).toBe(401);
    expect((await login("c@rbr.test", OLD)).statusCode).toBe(200);
  });
});

describe.skipIf(!enabled)("e2e — expiry then a fresh request", () => {
  it("an expired approved code fails; a new request, approval and reset succeed; the old code stays dead", async () => {
    const admin = await createAdminFixture(app, { email: "central@rbr.test", shopLocation: "Veerapandi" });
    envMut.CENTRAL_ADMIN_USER_ID = admin.user.id;
    const c = await cashier(admin.shop.id, "c@rbr.test");

    await request("c@rbr.test");
    const first = await reqFor(c.id);
    const oldCode = json(await approve(admin.token, first.id)).data.code as string;
    await backdate(first.id, 16);
    const late = await reset("c@rbr.test", oldCode);
    expect(late.statusCode).toBe(400);
    expect((await login("c@rbr.test", OLD)).statusCode).toBe(200); // password untouched

    await request("c@rbr.test");
    const second = await reqFor(c.id);
    expect(second.id).not.toBe(first.id);
    expect(second.status).toBe("PENDING");
    const newCode = json(await approve(admin.token, second.id)).data.code as string;
    expect(newCode).not.toBe(oldCode);

    expect((await reset("c@rbr.test", oldCode)).statusCode).toBe(400); // old code never works for the new request
    expect((await reset("c@rbr.test", newCode)).statusCode).toBe(200);
    expect((await reset("c@rbr.test", newCode, "AnotherPass77")).statusCode).toBe(400); // single use
    expect((await login("c@rbr.test", NEW)).statusCode).toBe(200);
  });
});
