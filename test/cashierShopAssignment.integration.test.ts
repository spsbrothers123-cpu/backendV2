/**
 * Integration tests for cashier shop assignment: invite → signup → approval
 * → login → authenticated shop scoping, plus Shop A vs Shop B isolation.
 *
 * RBR Egg Mart V2 Phase 1 (invitation code / branch-name rework): an
 * invitation code is now generic (never tied to any shop, never taken from
 * or displayed with the Global Shop Selector) and the shop a cashier joins
 * is resolved at signup time from the Branch Name they themselves type in
 * — see src/lib/shopAccess.ts resolveOrCreateShopByLocation and
 * src/routes/auth.ts POST /signup. This file replaces an earlier version
 * that asserted the opposite (invitation codes carrying an explicit target
 * shopId) — that was the bug this rework fixes.
 *
 * Same constraints as the other test/*.integration.test.ts files — needs a
 * real Postgres database, excluded from the default sandboxed `npm test`
 * run:
 *
 *   1. Point DATABASE_URL (in .env) at a disposable Postgres database.
 *   2. npx prisma migrate deploy
 *   3. RUN_INTEGRATION_TESTS=1 npx vitest run test/cashierShopAssignment.integration.test.ts
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

// ── Fixture helpers ─────────────────────────────────────────────────────

type ShopInfo = { id: string; name: string; location: string };

async function adminSignup(email: string, shopLocation: string) {
  const res = await app.inject({
    method: "POST",
    url: "/api/auth/admin/signup",
    payload: { name: "Admin", email, password: "Password123", shopLocation },
  });
  if (res.statusCode >= 400) throw new Error(`adminSignup failed: ${res.payload}`);
  return JSON.parse(res.payload) as { token: string; shop: ShopInfo };
}

/** One admin owning two shops. After this, the admin's ACTIVE shop is Veerapandi
 * (the first shop) — deliberately NOT the shop most tests target. */
async function adminWithTwoShops() {
  const first = await adminSignup("owner@rbr.test", "Veerapandi");
  const second = await adminSignup("owner@rbr.test", "Gandhipuram");
  return { token: first.token, shopA: first.shop, shopB: second.shop };
}

function auth(token: string) {
  return { authorization: `Bearer ${token}` };
}

// The invite-generation endpoint is rate-limited per client IP. app.inject()
// makes every request come from 127.0.0.1, so across the whole file (~20+
// invite calls) the limit trips and later tests get a 429 body with no
// `data` -> "Cannot read properties of undefined (reading 'code')".
// Giving each call its own fake IP keeps the limiter from ever accumulating.
let ipCounter = 0;
function nextIp() {
  ipCounter += 1;
  return `10.${(ipCounter >> 8) & 255}.${ipCounter & 255}.1`;
}

// Invitation codes are generic (Phase 1 rework): generating one takes no
// body at all — there is no shop to target.
function generateInvite(token: string) {
  return app.inject({
    method: "POST",
    url: "/api/admin/invitation-codes",
    headers: auth(token),
    remoteAddress: nextIp(),
  });
}

type InviteData = { id: string; code: string };

/** generateInvite + assert success. Fails with the real status/body instead of
 * a confusing "undefined.code" TypeError further down. */
async function inviteFor(token: string): Promise<InviteData> {
  const res = await generateInvite(token);
  if (res.statusCode !== 201) {
    throw new Error(`generateInvite failed: ${res.statusCode} ${res.payload}`);
  }
  return JSON.parse(res.payload).data as InviteData;
}

/** Full cashier lifecycle through the real HTTP API: verify code → signup (with
 * the given Branch Name) → admin approves → cashier logs in. Returns the
 * cashier's token + login body. */
async function onboardCashier(
  adminToken: string,
  code: string,
  email: string,
  branchName: string,
  extraSignupFields: Record<string, unknown> = {}
) {
  const verify = await app.inject({ method: "POST", url: "/api/auth/signup/verify-invitation", payload: { code } });
  expect(verify.statusCode).toBe(200);
  const { verificationToken } = JSON.parse(verify.payload);

  const signup = await app.inject({
    method: "POST",
    url: "/api/auth/signup",
    payload: {
      name: email.split("@")[0],
      email,
      password: "Password123",
      branchName,
      verificationToken,
      ...extraSignupFields,
    },
  });
  expect(signup.statusCode).toBe(201);
  const { requestId } = JSON.parse(signup.payload);

  const approve = await app.inject({
    method: "POST",
    url: `/api/admin/cashier-requests/${requestId}/approve`,
    headers: auth(adminToken),
  });
  expect(approve.statusCode).toBe(200);

  const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email, password: "Password123" } });
  expect(login.statusCode).toBe(200);
  const body = JSON.parse(login.payload);
  return { id: requestId as string, token: body.token as string, cashier: body.cashier };
}

// ── §1 Invitation codes are generic — never shop-scoped ──────────────────

describe("POST /api/admin/invitation-codes — generic, not shop-scoped", () => {
  it("generates a code with no shop attached, regardless of a shopId in the body", async () => {
    const { token, shopA } = await adminWithTwoShops();

    const res = await app.inject({
      method: "POST",
      url: "/api/admin/invitation-codes",
      headers: auth(token),
      payload: { shopId: shopA.id },
      remoteAddress: nextIp(),
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.payload);
    expect(body.data.shop).toBeUndefined();

    const row = await prisma.invitationCode.findUniqueOrThrow({ where: { id: body.data.id } });
    expect(row.shopId).toBeNull();
  });

  it("stays generic no matter which shop the Global Shop Selector has active", async () => {
    const { token, shopA, shopB } = await adminWithTwoShops();
    // Admin's active shop is A (first shop signed up for) — see adminWithTwoShops.
    const me = await prisma.user.findUniqueOrThrow({ where: { email: "owner@rbr.test" } });
    expect(me.shopId).toBe(shopA.id);

    const whileOnA = await inviteFor(token);
    const rowA = await prisma.invitationCode.findUniqueOrThrow({ where: { id: whileOnA.id } });
    expect(rowA.shopId).toBeNull();

    // Switch the admin's active shop to B, generate again — still generic.
    await app.inject({
      method: "POST",
      url: "/api/admin/shops/switch",
      headers: auth(token),
      payload: { shopId: shopB.id },
    });
    const whileOnB = await inviteFor(token);
    const rowB = await prisma.invitationCode.findUniqueOrThrow({ where: { id: whileOnB.id } });
    expect(rowB.shopId).toBeNull();
  });

  it("keeps one ACTIVE code per admin — generating a new one revokes the previous one, even across their different shops", async () => {
    const { token } = await adminWithTwoShops();
    const first = await inviteFor(token);
    const second = await inviteFor(token);

    const firstRow = await prisma.invitationCode.findUniqueOrThrow({ where: { id: first.id } });
    const secondRow = await prisma.invitationCode.findUniqueOrThrow({ where: { id: second.id } });
    expect(firstRow.status).toBe("REVOKED");
    expect(secondRow.status).toBe("ACTIVE");
  });
});

describe("GET /api/admin/invitation-codes/active — this admin's one code", () => {
  it("returns the requesting admin's own code with no shop attached", async () => {
    const { token } = await adminWithTwoShops();
    const created = await inviteFor(token);

    const res = await app.inject({ method: "GET", url: "/api/admin/invitation-codes/active", headers: auth(token) });
    expect(JSON.parse(res.payload).data.code).toBe(created.code);
    expect(JSON.parse(res.payload).data.shop).toBeUndefined();
  });

  it("never returns another admin's code", async () => {
    const { token } = await adminWithTwoShops();
    const other = await adminSignup("other@rbr.test", "Singanallur");
    await inviteFor(other.token);

    const res = await app.inject({ method: "GET", url: "/api/admin/invitation-codes/active", headers: auth(token) });
    expect(JSON.parse(res.payload).data).toBeNull();
  });
});

describe("POST /api/admin/invitation-codes/:id/revoke", () => {
  it("revokes the requesting admin's own code", async () => {
    const { token } = await adminWithTwoShops();
    const created = await inviteFor(token);
    const res = await app.inject({ method: "POST", url: `/api/admin/invitation-codes/${created.id}/revoke`, headers: auth(token) });
    expect(res.statusCode).toBe(200);
  });

  it("reports another admin's code as not found", async () => {
    const { token } = await adminWithTwoShops();
    const other = await adminSignup("other@rbr.test", "Singanallur");
    const theirs = await inviteFor(other.token);
    const res = await app.inject({ method: "POST", url: `/api/admin/invitation-codes/${theirs.id}/revoke`, headers: auth(token) });
    expect(res.statusCode).toBe(404);
  });
});

// ── §2 Cashier signup assigns the shop resolved from Branch Name ────────

describe("Cashier signup resolves the shop from Branch Name", () => {
  it("two cashiers signing up with the same code but different branch names end up in two different (auto-created) shops", async () => {
    const { token } = await adminWithTwoShops();
    const invite = await inviteFor(token);

    const c1 = await onboardCashier(token, invite.code, "cashier1@eggmart.test", "Coimbatore");
    // A single-use code — mint a fresh one for the second cashier.
    const invite2 = await inviteFor(token);
    const c2 = await onboardCashier(token, invite2.code, "cashier2@eggmart.test", "RS Puram");

    expect(c1.cashier.shop.name).toContain("Coimbatore");
    expect(c2.cashier.shop.name).toContain("RS Puram");
    expect(c1.cashier.shop.id).not.toBe(c2.cashier.shop.id);
  });

  it("reuses an existing shop rather than creating a duplicate, and normalizes casing/whitespace", async () => {
    const { token, shopA } = await adminWithTwoShops(); // shopA.location === "Veerapandi"
    const invite = await inviteFor(token);

    const c = await onboardCashier(token, invite.code, "cashier@eggmart.test", "  veerapandi ");
    expect(c.cashier.shop.id).toBe(shopA.id);

    const shopsNamedVeerapandi = await prisma.shop.count({ where: { location: { equals: "Veerapandi", mode: "insensitive" } } });
    expect(shopsNamedVeerapandi).toBe(1);
  });

  it("ignores any shopId the cashier frontend tries to send at signup — only Branch Name decides the shop", async () => {
    const { token, shopA } = await adminWithTwoShops();
    const invite = await inviteFor(token);

    // Cashier tries to sneak directly into shop A via a raw shopId while
    // typing an unrelated branch name.
    const c = await onboardCashier(token, invite.code, "sneaky@eggmart.test", "Brand New Branch", {
      shopId: shopA.id,
    });
    expect(c.cashier.shop.id).not.toBe(shopA.id);
    expect(c.cashier.shop.name).toContain("Brand New Branch");
  });

  it("an invite is single-use: a second signup with the same code is rejected", async () => {
    const { token } = await adminWithTwoShops();
    const invite = await inviteFor(token);
    await onboardCashier(token, invite.code, "first@eggmart.test", "Peelamedu");

    const verify = await app.inject({ method: "POST", url: "/api/auth/signup/verify-invitation", payload: { code: invite.code } });
    expect(verify.statusCode).toBe(409);
  });
});

// ── §3 Authenticated shop scoping / Shop A vs Shop B isolation ──────────

describe("Authenticated cashier scoping — Shop A vs Shop B", () => {
  async function twoCashiersWithData() {
    const { token, shopA, shopB } = await adminWithTwoShops();
    const inviteA = await inviteFor(token);
    const cashierA = await onboardCashier(token, inviteA.code, "cashier1@eggmart.test", shopA.location);
    const inviteB = await inviteFor(token);
    const cashierB = await onboardCashier(token, inviteB.code, "cashier2@eggmart.test", shopB.location);

    const mk = (shopId: string, name: string, barcode: string) =>
      prisma.product.create({
        data: { shopId, name, category: "Egg", sellingPrice: 6, costPrice: 5, stock: 10, unit: "PIECE", lowStockThreshold: 1, barcode },
      });
    await mk(shopA.id, "Product only in A", "A-1");
    await mk(shopB.id, "Product only in B", "B-1");

    return { token, shopA, shopB, cashierA, cashierB };
  }

  it("each cashier sees only their own shop's products", async () => {
    const { cashierA, cashierB } = await twoCashiersWithData();
    const namesFor = async (t: string) =>
      (JSON.parse((await app.inject({ method: "GET", url: "/api/products", headers: auth(t) })).payload) as { name: string }[]).map((p) => p.name);

    expect(await namesFor(cashierA.token)).toEqual(["Product only in A"]);
    expect(await namesFor(cashierB.token)).toEqual(["Product only in B"]);
  });

  it("a shopId query param cannot widen a cashier's scope", async () => {
    const { shopB, cashierA } = await twoCashiersWithData();
    const res = await app.inject({ method: "GET", url: `/api/products?shopId=${shopB.id}`, headers: auth(cashierA.token) });
    const names = (JSON.parse(res.payload) as { name: string }[]).map((p) => p.name);
    expect(names).toEqual(["Product only in A"]);
  });

  it("customers are created in, and only visible from, the creating cashier's own shop", async () => {
    const { cashierA, cashierB, shopA, shopB } = await twoCashiersWithData();
    const created = await app.inject({
      method: "POST",
      url: "/api/customers",
      headers: auth(cashierA.token),
      // A hostile client sends shop B's id in the body — it must be ignored.
      payload: { name: "Cust A", phone: "9000000001", shopId: shopB.id },
    });
    expect(created.statusCode).toBe(201);
    const row = await prisma.customer.findFirstOrThrow({ where: { phone: "9000000001" } });
    expect(row.shopId).toBe(shopA.id);

    const seenByB = JSON.parse((await app.inject({ method: "GET", url: "/api/customers", headers: auth(cashierB.token) })).payload);
    expect(seenByB).toEqual([]);
  });

  it("session start: shop comes from the cashier's account; a different shopId is rejected", async () => {
    const { cashierA, shopA, shopB } = await twoCashiersWithData();

    const forged = await app.inject({
      method: "POST",
      url: "/api/sessions/start",
      headers: auth(cashierA.token),
      payload: { shopId: shopB.id, openingCash: 100 },
    });
    expect(forged.statusCode).toBe(403);
    expect(JSON.parse(forged.payload).code).toBe("SHOP_MISMATCH");
    expect(await prisma.cashierSession.count()).toBe(0);

    // No shopId at all → still works, and lands in the cashier's own shop.
    const ok = await app.inject({
      method: "POST",
      url: "/api/sessions/start",
      headers: auth(cashierA.token),
      payload: { openingCash: 100 },
    });
    expect(ok.statusCode).toBe(200);
    const session = await prisma.cashierSession.findFirstOrThrow();
    expect(session.shopId).toBe(shopA.id);
  });

  it("hold-bill ignores a client shopId and bills into the cashier's own shop", async () => {
    const { cashierA, shopA, shopB } = await twoCashiersWithData();
    await app.inject({
      method: "POST",
      url: "/api/sessions/start",
      headers: auth(cashierA.token),
      payload: { openingCash: 0 },
    });
    const productA = await prisma.product.findFirstOrThrow({ where: { shopId: shopA.id } });
    const productB = await prisma.product.findFirstOrThrow({ where: { shopId: shopB.id } });

    // A's product is billable…
    const held = await app.inject({
      method: "POST",
      url: "/api/bills/hold",
      headers: auth(cashierA.token),
      payload: { shopId: shopB.id, items: [{ product: { id: productA.id }, quantity: 1 }] },
    });
    expect(held.statusCode).toBeLessThan(300);
    const bill = await prisma.bill.findFirstOrThrow();
    expect(bill.shopId).toBe(shopA.id);

    // …but B's product is not reachable from A's account, even with B's shopId supplied.
    const cross = await app.inject({
      method: "POST",
      url: "/api/bills/hold",
      headers: auth(cashierA.token),
      payload: { shopId: shopB.id, items: [{ product: { id: productB.id }, quantity: 1 }] },
    });
    expect(cross.statusCode).toBe(404);
    expect(JSON.parse(cross.payload).code).toBe("PRODUCT_NOT_FOUND");
    expect(await prisma.bill.count()).toBe(1);
  });
});
