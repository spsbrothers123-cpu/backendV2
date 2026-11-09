/**
 * Integration tests for Admin UPI Management against a REAL Postgres
 * (unique indexes, FK cascades, concurrent first-time saves, real auth).
 * Same setup as the other *.integration.test.ts files:
 *
 *   1. Point DATABASE_URL (.env.test) at a disposable *test* database.
 *   2. npx prisma migrate deploy
 *   3. RUN_INTEGRATION_TESTS=1 npx vitest run test/upi.integration.test.ts
 *
 * Route-level behaviour without a DB is covered by upiAdminRoutes.test.ts.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { prisma } from "../src/lib/prisma.js";
import { hashPassword } from "../src/lib/password.js";
import { resetDb } from "./dbReset.js";
import { createAdminFixture } from "./adminFixture.js";

let app: FastifyInstance;

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
});

async function adminSignup(email: string, shopLocation: string) {
  return (await createAdminFixture(app, { email, shopLocation })) as { token: string; user: { id: string }; shop: { id: string } };
}

async function cashierToken(shopId: string, email: string) {
  await prisma.user.create({
    data: { name: "Cash", email, passwordHash: await hashPassword("Password123"), role: "CASHIER", status: "ACTIVE", shopId },
  });
  const res = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email, password: "Password123" } });
  return JSON.parse(res.payload).token as string;
}

const call = (method: "GET" | "PUT", url: string, token: string, payload?: unknown) =>
  app.inject({ method, url, headers: { authorization: `Bearer ${token}` }, payload: payload as never });

const common = { upiId: "shop@okbank", payeeName: "RBR Egg Mart", enabled: true };

describe("Admin UPI Management (real database)", () => {
  it("saves common + custom config and resolves the effective receiver per shop", async () => {
    const a = await adminSignup("owner@rbr.test", "Veerapandi");
    const b = await adminSignup("owner@rbr.test", "Gandhipuram");

    const activeBefore = (await prisma.user.findUnique({ where: { id: a.user.id } }))!.shopId;
    expect((await call("PUT", "/api/admin/upi/common", b.token, common)).statusCode).toBe(200);
    const custom = await call("PUT", `/api/admin/upi/shops/${a.shop.id}`, b.token, {
      mode: "CUSTOM", upiId: "veera@oksbi", payeeName: "Veerapandi", enabled: true,
    });
    expect(custom.statusCode).toBe(200);

    const overview = JSON.parse((await call("GET", "/api/admin/upi/overview", b.token)).payload).data;
    const bySh = Object.fromEntries(overview.branches.map((x: { shopId: string }) => [x.shopId, x]));
    expect(bySh[a.shop.id].effective).toMatchObject({ source: "SHOP", upiId: "veera@oksbi" });
    expect(bySh[b.shop.id].effective).toMatchObject({ source: "COMMON", upiId: "shop@okbank" });

    // Global shop selection is untouched by UPI management.
    const me = await prisma.user.findUnique({ where: { id: a.user.id } });
    expect(me!.shopId).toBe(activeBefore);
  });

  it("COMMON mode keeps saved custom details dormant in the database", async () => {
    const a = await adminSignup("owner@rbr.test", "Veerapandi");
    await call("PUT", "/api/admin/upi/common", a.token, common);
    await call("PUT", `/api/admin/upi/shops/${a.shop.id}`, a.token, { mode: "CUSTOM", upiId: "veera@oksbi", payeeName: "Veerapandi", enabled: true });
    await call("PUT", `/api/admin/upi/shops/${a.shop.id}`, a.token, { mode: "COMMON" });
    const row = await prisma.upiShopAccount.findFirstOrThrow({ where: { shopId: a.shop.id } });
    expect(row).toMatchObject({ mode: "COMMON", customUpiId: "veera@oksbi", customPayeeName: "Veerapandi", customEnabled: true });
    const overview = JSON.parse((await call("GET", "/api/admin/upi/overview", a.token)).payload).data;
    expect(overview.branches[0].effective.source).toBe("COMMON");
  });

  it("cashiers cannot edit; unauthorized shops are rejected; admins are isolated", async () => {
    const one = await adminSignup("one@rbr.test", "Veerapandi");
    const two = await adminSignup("two@rbr.test", "Singanallur");
    const cashier = await cashierToken(one.shop.id, "c@rbr.test");

    expect((await call("PUT", "/api/admin/upi/common", cashier, common)).statusCode).toBe(403);
    expect((await call("GET", "/api/admin/upi/overview", cashier)).statusCode).toBe(403);

    const foreign = await call("PUT", `/api/admin/upi/shops/${two.shop.id}`, one.token, { mode: "COMMON" });
    expect(foreign.statusCode).toBe(403);
    expect(await prisma.upiShopAccount.count()).toBe(0);

    await call("PUT", "/api/admin/upi/common", one.token, common);
    const o2 = (await call("GET", "/api/admin/upi/overview", two.token)).payload;
    expect(o2).not.toContain("shop@okbank");
  });

  it("concurrent first-time saves end with exactly one row per admin / (admin, shop)", async () => {
    const a = await adminSignup("owner@rbr.test", "Veerapandi");
    const results = await Promise.all([
      ...Array.from({ length: 5 }, () => call("PUT", "/api/admin/upi/common", a.token, common)),
      ...Array.from({ length: 5 }, () => call("PUT", `/api/admin/upi/shops/${a.shop.id}`, a.token, { mode: "COMMON" })),
    ]);
    for (const r of results) expect(r.statusCode).toBe(200);
    expect(await prisma.upiCommonAccount.count()).toBe(1);
    expect(await prisma.upiShopAccount.count()).toBe(1);
  });

  it("existing billing/payment tables are untouched by UPI configuration", async () => {
    const a = await adminSignup("owner@rbr.test", "Veerapandi");
    await call("PUT", "/api/admin/upi/common", a.token, common);
    expect(await prisma.bill.count()).toBe(0);
    expect(await prisma.payment.count()).toBe(0);
  });
});
