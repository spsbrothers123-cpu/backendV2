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

async function adminSignup(payload: {
  name?: string;
  email: string;
  password: string;
  shopLocation: string;
}) {
  return app.inject({
    method: "POST",
    url: "/api/auth/admin/signup",
    payload: { name: payload.name ?? "Admin", ...payload },
  });
}

describe("Admin signup — multi-shop foundation", () => {
  it("creates a new admin and a new shop named 'RBR Egg Mart - <Location>'", async () => {
    const res = await adminSignup({
      email: "owner@rbr.test",
      password: "Password123",
      shopLocation: "Veerapandi",
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.payload);
    expect(body.token).toBeTruthy();
    expect(body.shop.name).toBe("RBR Egg Mart - Veerapandi");
    expect(body.shop.location).toBe("Veerapandi");

    const shopsInDb = await prisma.shop.count();
    expect(shopsInDb).toBe(1);
  });

  it("does not create a duplicate shop for the same location typed differently", async () => {
    const first = await adminSignup({
      email: "owner1@rbr.test",
      password: "Password123",
      shopLocation: "Veerapandi",
    });
    const second = await adminSignup({
      email: "owner2@rbr.test",
      password: "Password123",
      shopLocation: "  veerapandi  ",
    });

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect(JSON.parse(first.payload).shop.id).toBe(JSON.parse(second.payload).shop.id);

    const shopsInDb = await prisma.shop.count();
    expect(shopsInDb).toBe(1);
  });

  it("lets an existing admin add a second shop under the same account", async () => {
    const first = await adminSignup({
      email: "owner@rbr.test",
      password: "Password123",
      shopLocation: "Veerapandi",
    });
    const firstBody = JSON.parse(first.payload);

    const second = await adminSignup({
      email: "owner@rbr.test",
      password: "Password123",
      shopLocation: "Gandhipuram",
    });
    expect(second.statusCode).toBe(200); // not 201 — no new account created
    const secondBody = JSON.parse(second.payload);
    expect(secondBody.user.id).toBe(firstBody.user.id);
    expect(secondBody.shop.name).toBe("RBR Egg Mart - Gandhipuram");

    const usersInDb = await prisma.user.count();
    expect(usersInDb).toBe(1); // still one admin account, not two

    const shopsRes = await app.inject({
      method: "GET",
      url: "/api/admin/shops",
      headers: { authorization: `Bearer ${secondBody.token}` },
    });
    const shops = JSON.parse(shopsRes.payload).data;
    expect(shops).toHaveLength(2);
    expect(shops.map((s: { location: string }) => s.location).sort()).toEqual(["Gandhipuram", "Veerapandi"]);
  });

  it("rejects adding a shop to an existing admin email with the wrong password", async () => {
    await adminSignup({ email: "owner@rbr.test", password: "Password123", shopLocation: "Veerapandi" });

    const res = await adminSignup({
      email: "owner@rbr.test",
      password: "WrongPassword1",
      shopLocation: "Gandhipuram",
    });
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.payload).code).toBe("INVALID_CREDENTIALS");

    const shopsInDb = await prisma.shop.count();
    expect(shopsInDb).toBe(1); // no shop created off the failed attempt
  });

  it("rejects admin signup on an email already used by a cashier", async () => {
    const ownerRes = await adminSignup({
      email: "owner@rbr.test",
      password: "Password123",
      shopLocation: "Veerapandi",
    });
    const shopId = JSON.parse(ownerRes.payload).shop.id;
    await prisma.user.create({
      data: {
        name: "Cashier",
        email: "cashier@rbr.test",
        passwordHash: "irrelevant",
        role: "CASHIER",
        status: "ACTIVE",
        shopId,
      },
    });

    const res = await adminSignup({
      email: "cashier@rbr.test",
      password: "Password123",
      shopLocation: "Singanallur",
    });
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.payload).code).toBe("ACCOUNT_ALREADY_EXISTS");
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
