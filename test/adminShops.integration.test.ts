/**
 * Integration tests for the multi-shop foundation (RBR Egg Mart Phase 1):
 * admin signup (new account, and an existing admin adding a second shop),
 * shop-location dedup, GET /api/admin/shops, and POST /api/admin/shops/switch.
 *
 * Same constraints as test/auth.integration.test.ts — needs a real Postgres
 * database, excluded from the default sandboxed `npm test` run:
 *
 *   1. Point DATABASE_URL (in .env) at a disposable Postgres database.
 *   2. npx prisma migrate deploy
 *   3. RUN_INTEGRATION_TESTS=1 npx vitest run test/adminShops.integration.test.ts
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { prisma } from "../src/lib/prisma.js";
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

/** Provisions an Admin + shop like an operator would (see adminFixture.ts); returns a response-shaped object. */
async function adminSignup(payload: {
  name?: string;
  email: string;
  password: string;
  shopLocation: string;
}) {
  const body = await createAdminFixture(app, payload);
  return { statusCode: 201, payload: JSON.stringify(body) };
}

function signupAs(token: string | null, payload: Record<string, unknown>) {
  return app.inject({
    method: "POST",
    url: "/api/auth/admin/signup",
    headers: token ? { authorization: `Bearer ${token}` } : {},
    payload,
  });
}

describe("Admin signup — gated (security regression)", () => {
  it("REFUSES unauthenticated requests — anyone could previously mint an ADMIN and join an existing shop", async () => {
    const owner = await adminSignup({ email: "owner@rbr.test", password: "Password123", shopLocation: "Veerapandi" });
    const shopId = JSON.parse(owner.payload).shop.id;
    const usersBefore = await prisma.user.count();

    const res = await signupAs(null, {
      name: "Intruder",
      email: "intruder@evil.test",
      password: "Password123",
      shopLocation: "Veerapandi",
    });
    expect(res.statusCode).toBe(401);
    expect(await prisma.user.count()).toBe(usersBefore);
    expect(await prisma.user.findUnique({ where: { email: "intruder@evil.test" } })).toBeNull();
    expect(await prisma.adminShopLink.count({ where: { shopId } })).toBe(1);
  });

  it("refuses a Cashier token", async () => {
    const owner = JSON.parse((await adminSignup({ email: "owner@rbr.test", password: "Password123", shopLocation: "Veerapandi" })).payload);
    await prisma.user.create({
      data: { name: "C", email: "c@rbr.test", passwordHash: await (await import("../src/lib/password.js")).hashPassword("Password123"), role: "CASHIER", status: "ACTIVE", shopId: owner.shop.id },
    });
    const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "c@rbr.test", password: "Password123" } });
    const res = await signupAs(JSON.parse(login.payload).token, {
      name: "x", email: "c@rbr.test", password: "Password123", shopLocation: "Gandhipuram",
    });
    expect(res.statusCode).toBe(403);
  });

  it("cannot create a NEW admin account even when authenticated as an admin", async () => {
    const owner = JSON.parse((await adminSignup({ email: "owner@rbr.test", password: "Password123", shopLocation: "Veerapandi" })).payload);
    const res = await signupAs(owner.token, {
      name: "Second", email: "second@rbr.test", password: "Password123", shopLocation: "Gandhipuram",
    });
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.payload).code).toBe("ADMIN_CREATION_DISABLED");
    expect(await prisma.user.count({ where: { role: "ADMIN" } })).toBe(1);
  });

  it("lets an authenticated admin add a NEW shop to their own account (existing legitimate use)", async () => {
    const owner = JSON.parse((await adminSignup({ email: "owner@rbr.test", password: "Password123", shopLocation: "Veerapandi" })).payload);
    const res = await signupAs(owner.token, {
      name: "Admin", email: "owner@rbr.test", password: "Password123", shopLocation: "Gandhipuram",
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.user.id).toBe(owner.user.id);
    expect(body.shop.name).toBe("RBR Egg Mart - Gandhipuram");
    expect(await prisma.user.count()).toBe(1);

    const shopsRes = await app.inject({ method: "GET", url: "/api/admin/shops", headers: { authorization: `Bearer ${owner.token}` } });
    const shops = JSON.parse(shopsRes.payload).data;
    expect(shops.map((x: { location: string }) => x.location).sort()).toEqual(["Gandhipuram", "Veerapandi"]);
  });

  it("is idempotent for a shop the admin already owns and dedupes the location typed differently", async () => {
    const owner = JSON.parse((await adminSignup({ email: "owner@rbr.test", password: "Password123", shopLocation: "Veerapandi" })).payload);
    const res = await signupAs(owner.token, {
      name: "Admin", email: "owner@rbr.test", password: "Password123", shopLocation: "  veerapandi ",
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload).shop.id).toBe(owner.shop.id);
    expect(await prisma.shop.count()).toBe(1);
  });

  it("will NOT link an admin to a shop another admin already manages", async () => {
    const a = JSON.parse((await adminSignup({ email: "a@rbr.test", password: "Password123", shopLocation: "Veerapandi" })).payload);
    const b = JSON.parse((await adminSignup({ email: "b@rbr.test", password: "Password123", shopLocation: "Gandhipuram" })).payload);
    const res = await signupAs(b.token, {
      name: "B", email: "b@rbr.test", password: "Password123", shopLocation: "Veerapandi",
    });
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.payload).code).toBe("SHOP_OWNED_BY_ANOTHER_ADMIN");
    expect(await prisma.adminShopLink.count({ where: { shopId: a.shop.id } })).toBe(1);
  });

  it("requires the caller's current password (wrong password adds nothing)", async () => {
    const owner = JSON.parse((await adminSignup({ email: "owner@rbr.test", password: "Password123", shopLocation: "Veerapandi" })).payload);
    const res = await signupAs(owner.token, {
      name: "Admin", email: "owner@rbr.test", password: "WrongPassword1", shopLocation: "Gandhipuram",
    });
    expect(res.statusCode).toBe(403);
    expect(await prisma.shop.count()).toBe(1);
  });

  it("existing admin login is unaffected", async () => {
    await adminSignup({ email: "owner@rbr.test", password: "Password123", shopLocation: "Veerapandi" });
    const res = await app.inject({ method: "POST", url: "/api/auth/admin/login", payload: { email: "owner@rbr.test", password: "Password123" } });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload).token).toBeTruthy();
  });
});

describe("POST /api/admin/shops/switch", () => {
  async function signUpTwoShopAdmin() {
    const first = await adminSignup({
      email: "owner@rbr.test",
      password: "Password123",
      shopLocation: "Veerapandi",
    });
    const veerapandi = JSON.parse(first.payload).shop;
    const second = await adminSignup({
      email: "owner@rbr.test",
      password: "Password123",
      shopLocation: "Gandhipuram",
    });
    const { token, shop: gandhipuram } = JSON.parse(second.payload);
    return { token, veerapandi, gandhipuram };
  }

  it("switches the admin's active shop when they own it", async () => {
    const { token, gandhipuram } = await signUpTwoShopAdmin();

    const res = await app.inject({
      method: "POST",
      url: "/api/admin/shops/switch",
      headers: { authorization: `Bearer ${token}` },
      payload: { shopId: gandhipuram.id },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload).data.current).toBe(true);

    const me = await app.inject({ method: "GET", url: "/api/auth/me", headers: { authorization: `Bearer ${token}` } });
    expect(JSON.parse(me.payload).id).toBeTruthy();
  });

  it("rejects switching to a shop the admin does not own", async () => {
    const { token } = await signUpTwoShopAdmin();

    const otherAdminRes = await adminSignup({
      email: "other@rbr.test",
      password: "Password123",
      shopLocation: "Singanallur",
    });
    const otherShop = JSON.parse(otherAdminRes.payload).shop;

    const res = await app.inject({
      method: "POST",
      url: "/api/admin/shops/switch",
      headers: { authorization: `Bearer ${token}` },
      payload: { shopId: otherShop.id },
    });
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.payload).code).toBe("SHOP_ACCESS_DENIED");
  });

  it("rejects an unauthenticated switch request", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/admin/shops/switch",
      payload: { shopId: "does-not-matter" },
    });
    expect(res.statusCode).toBe(401);
  });
});
