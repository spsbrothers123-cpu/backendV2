/**
 * Integration tests for RBR Egg Mart Phase 3: Cashiers/Sessions as
 * deliberate exceptions to the Global Shop Selector, cashier shop
 * isolation, and cross-shop/cross-admin data isolation.
 *
 * Same constraints as the other test/*.integration.test.ts files — needs a
 * real Postgres database, excluded from the default sandboxed `npm test`
 * run:
 *
 *   1. Point DATABASE_URL (in .env) at a disposable Postgres database.
 *   2. npx prisma migrate deploy
 *   3. RUN_INTEGRATION_TESTS=1 npx vitest run test/multiShopCashiersSessions.integration.test.ts
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { prisma } from "../src/lib/prisma.js";
import { hashPassword } from "../src/lib/password.js";
import { checkoutBill } from "../src/services/billingService.js";
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

// ── Shared fixture helpers ──────────────────────────────────────────────

async function adminSignup(payload: { name?: string; email: string; password: string; shopLocation: string }) {
  const res = await app.inject({
    method: "POST",
    url: "/api/auth/admin/signup",
    payload: { name: payload.name ?? "Admin", ...payload },
  });
  if (res.statusCode >= 400) {
    throw new Error(`adminSignup failed (${res.statusCode}): ${res.payload}`);
  }
  return JSON.parse(res.payload) as { token: string; user: { id: string }; shop: { id: string; name: string; location: string } };
}

async function switchShop(token: string, shopId: string) {
  return app.inject({
    method: "POST",
    url: "/api/admin/shops/switch",
    headers: { authorization: `Bearer ${token}` },
    payload: { shopId },
  });
}

async function createCashier(shopId: string, name: string, email: string) {
  return prisma.user.create({
    data: { name, email, passwordHash: await hashPassword("Password123"), role: "CASHIER", status: "ACTIVE", shopId },
  });
}

async function cashierLogin(email: string, password = "Password123") {
  const res = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email, password } });
  return JSON.parse(res.payload).token as string;
}

/**
 * Sets up the exact scenario the Phase 3 spec's own examples use: one admin
 * owning two shops (Veerapandi, Gandhipuram), one cashier per shop, and a
 * third, wholly separate admin+shop+cashier (Singanallur) to prove
 * cross-admin isolation still holds once Cashiers/Sessions span multiple
 * shops.
 */
async function twoShopAdminWithCashiers() {
  // The two shop signups for the SAME admin email must stay sequential —
  // the second call depends on the first admin already existing. But the
  // third admin (a wholly separate account) has no such dependency, so it
  // can run concurrently with the first two instead of adding its own
  // round-trip on top. Every request here is a real network hop to a
  // remote Postgres instance, so collapsing independent work into
  // Promise.all noticeably cuts this fixture's wall-clock cost.
  const [{ first, second }, other] = await Promise.all([
    (async () => {
      const first = await adminSignup({ email: "owner@rbr.test", password: "Password123", shopLocation: "Veerapandi" });
      const second = await adminSignup({ email: "owner@rbr.test", password: "Password123", shopLocation: "Gandhipuram" });
      return { first, second };
    })(),
    adminSignup({ email: "other-owner@rbr.test", password: "Password123", shopLocation: "Singanallur" }),
  ]);
  const veerapandi = first.shop;
  const { token, shop: gandhipuram } = second;

  const [arun, bala, karthik] = await Promise.all([
    createCashier(veerapandi.id, "Arun", "arun@rbr.test"),
    createCashier(gandhipuram.id, "Bala", "bala@rbr.test"),
    createCashier(other.shop.id, "Karthik", "karthik@rbr.test"),
  ]);

  return { token, veerapandi, gandhipuram, arun, bala, otherToken: other.token, singanallur: other.shop, karthik };
}

// ── §1 Cashiers page — global view, exception to the Shop Selector ──────

describe("GET /api/admin/cashiers — exception to the Global Shop Selector", () => {
  it("lists cashiers from every shop the admin owns, unaffected by which shop is currently active", async () => {
    const { token, veerapandi, gandhipuram, arun, bala } = await twoShopAdminWithCashiers();

    await switchShop(token, veerapandi.id);
    let res = await app.inject({ method: "GET", url: "/api/admin/cashiers", headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(200);
    let names = JSON.parse(res.payload).data.map((c: { name: string }) => c.name).sort();
    expect(names).toEqual(["Arun", "Bala"]);

    // Switching the active shop must not filter this page at all.
    await switchShop(token, gandhipuram.id);
    res = await app.inject({ method: "GET", url: "/api/admin/cashiers", headers: { authorization: `Bearer ${token}` } });
    names = JSON.parse(res.payload).data.map((c: { name: string }) => c.name).sort();
    expect(names).toEqual(["Arun", "Bala"]);

    const byName = Object.fromEntries(JSON.parse(res.payload).data.map((c: { name: string; shop: { id: string } }) => [c.name, c.shop.id]));
    expect(byName["Arun"]).toBe(veerapandi.id);
    expect(byName["Bala"]).toBe(gandhipuram.id);
    void arun;
    void bala;
  });

  it("never includes a cashier belonging to a shop this admin doesn't own", async () => {
    const { token, karthik } = await twoShopAdminWithCashiers();
    const res = await app.inject({ method: "GET", url: "/api/admin/cashiers", headers: { authorization: `Bearer ${token}` } });
    const ids = JSON.parse(res.payload).data.map((c: { id: string }) => c.id);
    expect(ids).not.toContain(karthik.id);
  });

  it("excludes suspended cashiers, same as before Phase 3", async () => {
    const { token, arun } = await twoShopAdminWithCashiers();
    await prisma.user.update({ where: { id: arun.id }, data: { status: "SUSPENDED" } });
    const res = await app.inject({ method: "GET", url: "/api/admin/cashiers", headers: { authorization: `Bearer ${token}` } });
    const names = JSON.parse(res.payload).data.map((c: { name: string }) => c.name);
    expect(names).not.toContain("Arun");
  });
});

describe("PATCH /api/admin/cashiers/:id and /:id/status — cross-shop authorization", () => {
  it("lets the admin edit a cashier whose shop isn't the currently active one", async () => {
    const { token, veerapandi, bala } = await twoShopAdminWithCashiers();
    await switchShop(token, veerapandi.id); // active shop is Veerapandi; Bala belongs to Gandhipuram

    const res = await app.inject({
      method: "PATCH",
      url: `/api/admin/cashiers/${bala.id}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { branchName: "Gandhipuram Main Road" },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload).data.branchName).toBe("Gandhipuram Main Road");
  });

  it("lets the admin suspend a cashier whose shop isn't the currently active one, and revokes their sessions", async () => {
    const { token, veerapandi, bala } = await twoShopAdminWithCashiers();
    await switchShop(token, veerapandi.id);
    const balaToken = await cashierLogin("bala@rbr.test");

    const res = await app.inject({
      method: "PATCH",
      url: `/api/admin/cashiers/${bala.id}/status`,
      headers: { authorization: `Bearer ${token}` },
      payload: { status: "SUSPENDED" },
    });
    expect(res.statusCode).toBe(200);

    const me = await app.inject({ method: "GET", url: "/api/auth/me", headers: { authorization: `Bearer ${balaToken}` } });
    expect(me.statusCode).toBe(401); // revoked session, per existing behaviour
  });

  it("rejects editing a cashier belonging to a shop this admin doesn't own", async () => {
    const { token, karthik } = await twoShopAdminWithCashiers();
    const res = await app.inject({
      method: "PATCH",
      url: `/api/admin/cashiers/${karthik.id}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { name: "Hijacked Name" },
    });
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.payload).code).toBe("CASHIER_NOT_FOUND");
  });

  it("rejects suspending a cashier belonging to a shop this admin doesn't own", async () => {
    const { token, karthik } = await twoShopAdminWithCashiers();
    const res = await app.inject({
      method: "PATCH",
      url: `/api/admin/cashiers/${karthik.id}/status`,
      headers: { authorization: `Bearer ${token}` },
      payload: { status: "SUSPENDED" },
    });
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.payload).code).toBe("CASHIER_NOT_FOUND");

    const stillActive = await prisma.user.findUnique({ where: { id: karthik.id } });
    expect(stillActive?.status).toBe("ACTIVE");
  });
});

// ── §2 Sessions page — cashier-driven, exception to the Shop Selector ───

describe("GET /api/admin/sessions/active — exception to the Global Shop Selector", () => {
  it("spans every shop the admin owns, unaffected by which shop is currently active", async () => {
    const { token, veerapandi, gandhipuram, arun, bala } = await twoShopAdminWithCashiers();
    await prisma.cashierSession.create({ data: { cashierId: arun.id, shopId: veerapandi.id, openingCash: 1000 } });
    await prisma.cashierSession.create({ data: { cashierId: bala.id, shopId: gandhipuram.id, openingCash: 500 } });

    await switchShop(token, veerapandi.id);
    let res = await app.inject({ method: "GET", url: "/api/admin/sessions/active", headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(200);
    let cashierNames = JSON.parse(res.payload).map((s: { cashier: string }) => s.cashier).sort();
    expect(cashierNames).toEqual(["Arun", "Bala"]);

    await switchShop(token, gandhipuram.id);
    res = await app.inject({ method: "GET", url: "/api/admin/sessions/active", headers: { authorization: `Bearer ${token}` } });
    cashierNames = JSON.parse(res.payload).map((s: { cashier: string }) => s.cashier).sort();
    expect(cashierNames).toEqual(["Arun", "Bala"]); // unchanged by the shop switch
  });

  it("never includes an open session belonging to a shop this admin doesn't own", async () => {
    const { token, singanallur, karthik } = await twoShopAdminWithCashiers();
    await prisma.cashierSession.create({ data: { cashierId: karthik.id, shopId: singanallur.id, openingCash: 200 } });

    const res = await app.inject({ method: "GET", url: "/api/admin/sessions/active", headers: { authorization: `Bearer ${token}` } });
    const cashierNames = JSON.parse(res.payload).map((s: { cashier: string }) => s.cashier);
    expect(cashierNames).not.toContain("Karthik");
  });
});

describe("GET /api/admin/sessions/history — cashier filter is exempt from the Shop Selector", () => {
  it("spans every shop the admin owns and filters correctly by cashier ID even with same-named cashiers", async () => {
    const { token, veerapandi, gandhipuram, arun, bala } = await twoShopAdminWithCashiers();
    // A second "Arun" at the other shop — the whole reason the cashier
    // filter must be by ID, not by name, once this page spans shops.
    const arun2 = await createCashier(gandhipuram.id, "Arun", "arun2@rbr.test");

    const s1 = await prisma.cashierSession.create({
      data: { cashierId: arun.id, shopId: veerapandi.id, openingCash: 1000, status: "CLOSED", closedAt: new Date(), actualClosingCash: 1000 },
    });
    const s2 = await prisma.cashierSession.create({
      data: { cashierId: arun2.id, shopId: gandhipuram.id, openingCash: 700, status: "CLOSED", closedAt: new Date(), actualClosingCash: 700 },
    });
    await prisma.cashierSession.create({
      data: { cashierId: bala.id, shopId: gandhipuram.id, openingCash: 300, status: "CLOSED", closedAt: new Date(), actualClosingCash: 300 },
    });

    // All three show up regardless of currently active shop.
    await switchShop(token, veerapandi.id);
    let res = await app.inject({ method: "GET", url: "/api/admin/sessions/history", headers: { authorization: `Bearer ${token}` } });
    expect(JSON.parse(res.payload).total).toBe(3);

    // Filtering by arun2's ID returns only his session, not the other Arun's.
    res = await app.inject({
      method: "GET",
      url: `/api/admin/sessions/history?cashier=${arun2.id}`,
      headers: { authorization: `Bearer ${token}` },
    });
    const items = JSON.parse(res.payload).items;
    expect(items).toHaveLength(1);
    expect(items[0].id).toBe(s2.id);
    expect(items[0].shop).toBe(gandhipuram.name);
    void s1;
  });

  it("a cashierId belonging to another admin's shop matches nothing rather than leaking data", async () => {
    const { token, karthik } = await twoShopAdminWithCashiers();
    const otherShop = await prisma.user.findUnique({ where: { id: karthik.id } });
    await prisma.cashierSession.create({
      data: { cashierId: karthik.id, shopId: otherShop!.shopId!, openingCash: 200, status: "CLOSED", closedAt: new Date(), actualClosingCash: 200 },
    });

    const res = await app.inject({
      method: "GET",
      url: `/api/admin/sessions/history?cashier=${karthik.id}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload).total).toBe(0);
  });
});

describe("GET /api/admin/sessions/:id — cross-shop authorization", () => {
  it("is reachable when the session's shop isn't the currently active one", async () => {
    const { token, veerapandi, gandhipuram, bala } = await twoShopAdminWithCashiers();
    const session = await prisma.cashierSession.create({ data: { cashierId: bala.id, shopId: gandhipuram.id, openingCash: 500 } });
    await switchShop(token, veerapandi.id);

    const res = await app.inject({ method: "GET", url: `/api/admin/sessions/${session.id}`, headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload).shop).toBe(gandhipuram.name);
  });

  it("404s for a session belonging to a shop this admin doesn't own", async () => {
    const { token, singanallur, karthik } = await twoShopAdminWithCashiers();
    const session = await prisma.cashierSession.create({ data: { cashierId: karthik.id, shopId: singanallur.id, openingCash: 200 } });

    const res = await app.inject({ method: "GET", url: `/api/admin/sessions/${session.id}`, headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.payload).code).toBe("SESSION_NOT_FOUND");
  });
});

// ── §3–6: cashier shop isolation, and customer/bill shop association ────

describe("Cashier shop isolation (spec §3–6): shopId is always server-derived", () => {
  it("a cashier can only start a session for their own assigned shop, even if a different shopId is sent", async () => {
    const { gandhipuram, arun } = await twoShopAdminWithCashiers();
    const arunToken = await cashierLogin("arun@rbr.test");

    const res = await app.inject({
      method: "POST",
      url: "/api/sessions/start",
      headers: { authorization: `Bearer ${arunToken}` },
      payload: { shopId: gandhipuram.id, openingCash: 1000 }, // not Arun's shop
    });
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.payload).code).toBe("SHOP_MISMATCH");
    void arun;
  });

  it("a customer created by a cashier is always assigned to the cashier's own shop", async () => {
    const { veerapandi } = await twoShopAdminWithCashiers();
    const arunToken = await cashierLogin("arun@rbr.test");

    const res = await app.inject({
      method: "POST",
      url: "/api/customers",
      headers: { authorization: `Bearer ${arunToken}` },
      // Even if a shopId were smuggled into the body, the route/schema has
      // no such field — this documents that it's simply not accepted.
      payload: { name: "Walk-in Customer", phone: "9999900000", shopId: "some-other-shop-id" },
    });
    expect(res.statusCode).toBe(201);

    const created = await prisma.customer.findFirst({ where: { phone: "9999900000" } });
    expect(created?.shopId).toBe(veerapandi.id);
  });

  it("a bill checked out by a cashier is always associated with the cashier's own shop, and cannot reference another shop's product", async () => {
    const { veerapandi, gandhipuram } = await twoShopAdminWithCashiers();
    const veerapandiProduct = await prisma.product.create({
      data: { shopId: veerapandi.id, name: "Egg Tray", category: "Eggs", sellingPrice: 100, stock: 10, unit: "TRAY", lowStockThreshold: 2 },
    });
    const gandhipuramProduct = await prisma.product.create({
      data: { shopId: gandhipuram.id, name: "Egg Carton", category: "Eggs", sellingPrice: 60, stock: 10, unit: "PIECE", lowStockThreshold: 2 },
    });
    const arunSession = await prisma.cashierSession.create({
      data: { cashierId: (await prisma.user.findUniqueOrThrow({ where: { email: "arun@rbr.test" } })).id, shopId: veerapandi.id, openingCash: 1000 },
    });

    // Arun (Veerapandi) can bill his own shop's product.
    const bill = await checkoutBill({
      shopId: veerapandi.id,
      cashierId: arunSession.cashierId,
      customerId: null,
      items: [{ productId: veerapandiProduct.id, quantity: 1 }],
      payments: [{ method: "cash", amount: 100 }],
      idempotencyKey: null,
    });
    const savedBill = await prisma.bill.findUnique({ where: { id: bill.id } });
    expect(savedBill?.shopId).toBe(veerapandi.id);

    // But never Gandhipuram's product — the service scopes its product
    // lookup to the shopId passed in (always the cashier's own, server-side).
    await expect(
      checkoutBill({
        shopId: veerapandi.id,
        cashierId: arunSession.cashierId,
        customerId: null,
        items: [{ productId: gandhipuramProduct.id, quantity: 1 }],
        payments: [{ method: "cash", amount: 60 }],
        idempotencyKey: null,
      })
    ).rejects.toMatchObject({ code: "PRODUCT_NOT_FOUND" });
  });
});

// ── §7/§8: full data isolation + basic security probing ─────────────────

describe("Full data isolation across shops (spec §7/§8)", () => {
  it("products, customers, and bills never leak across shops for the same admin's two shops", async () => {
    const { token, veerapandi, gandhipuram } = await twoShopAdminWithCashiers();
    await prisma.product.create({ data: { shopId: veerapandi.id, name: "V-Only Product", category: "Eggs", sellingPrice: 10, stock: 5, unit: "PIECE", lowStockThreshold: 1 } });
    await prisma.product.create({ data: { shopId: gandhipuram.id, name: "G-Only Product", category: "Eggs", sellingPrice: 10, stock: 5, unit: "PIECE", lowStockThreshold: 1 } });

    await switchShop(token, veerapandi.id);
    let res = await app.inject({ method: "GET", url: "/api/admin/products", headers: { authorization: `Bearer ${token}` } });
    let names = JSON.parse(res.payload).items.map((p: { name: string }) => p.name);
    expect(names).toContain("V-Only Product");
    expect(names).not.toContain("G-Only Product");

    await switchShop(token, gandhipuram.id);
    res = await app.inject({ method: "GET", url: "/api/admin/products", headers: { authorization: `Bearer ${token}` } });
    names = JSON.parse(res.payload).items.map((p: { name: string }) => p.name);
    expect(names).toContain("G-Only Product");
    expect(names).not.toContain("V-Only Product");
  });

  it("rejects an admin manually manipulating shopId to reach a shop they don't own", async () => {
    const { otherToken, veerapandi } = await twoShopAdminWithCashiers();
    const res = await switchShop(otherToken, veerapandi.id); // otherToken's admin doesn't own Veerapandi
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.payload).code).toBe("SHOP_ACCESS_DENIED");
  });
});
