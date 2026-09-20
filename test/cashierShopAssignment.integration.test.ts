/**
 * Integration tests for cashier shop assignment: invite → signup → approval
 * → login → authenticated shop scoping, plus Shop A vs Shop B isolation.
 *
 * Regression target: every new cashier ended up on "Egg Mart — Main Branch"
 * because invitation codes were stamped with the admin's mutable *active*
 * shop (User.shopId) instead of an explicit, ownership-checked target shop.
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
import { hashPassword } from "../src/lib/password.js";
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

function generateInvite(token: string, payload?: Record<string, unknown>) {
  return app.inject({
    method: "POST",
    url: "/api/admin/invitation-codes",
    headers: auth(token),
    payload,
    remoteAddress: nextIp(),
  });
}

type InviteData = { id: string; code: string; shop: { id: string; name: string } };

/** generateInvite + assert success. Fails with the real status/body instead of
 * a confusing "undefined.code" TypeError further down. */
async function inviteFor(token: string, shopId: string): Promise<InviteData> {
  const res = await generateInvite(token, { shopId });
  if (res.statusCode !== 201) {
    throw new Error(`generateInvite(${shopId}) failed: ${res.statusCode} ${res.payload}`);
  }
  return JSON.parse(res.payload).data as InviteData;
}

/** Full cashier lifecycle through the real HTTP API: verify code → signup →
 * admin approves → cashier logs in. Returns the cashier's token + login body. */
async function onboardCashier(
  adminToken: string,
  code: string,
  email: string,
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
      branchName: "Whatever the cashier typed",
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

// ── §1 Invite carries the explicit target shop ──────────────────────────

describe("POST /api/admin/invitation-codes — explicit target shop", () => {
  it("stamps the invite with the requested shop, NOT the admin's currently active shop", async () => {
    const { token, shopA, shopB } = await adminWithTwoShops();
    // Sanity: the admin's active shop is A (first shop) …
    const me = await prisma.user.findUniqueOrThrow({ where: { email: "owner@rbr.test" } });
    expect(me.shopId).toBe(shopA.id);

    // … yet an invite requested for B must belong to B.
    const res = await generateInvite(token, { shopId: shopB.id });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.payload);
    expect(body.data.shop.id).toBe(shopB.id);
    expect(body.data.shop.name).toBe(shopB.name);

    const row = await prisma.invitationCode.findUniqueOrThrow({ where: { id: body.data.id } });
    expect(row.shopId).toBe(shopB.id);
  });

  it("rejects a request with no shopId (no implicit / default shop)", async () => {
    const { token } = await adminWithTwoShops();
    const res = await generateInvite(token);
    // Schema-validation failures in this API return 422 (not 400).
    expect(res.statusCode).toBe(422);
    expect(await prisma.invitationCode.count()).toBe(0);
  });

  it("rejects a shop the admin does not own, including another admin's shop", async () => {
    const { token } = await adminWithTwoShops();
    const other = await adminSignup("other@rbr.test", "Singanallur");

    const res = await generateInvite(token, { shopId: other.shop.id });
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.payload).code).toBe("SHOP_ACCESS_DENIED");

    const bogus = await generateInvite(token, { shopId: "does-not-exist" });
    expect(bogus.statusCode).toBe(403);
    expect(await prisma.invitationCode.count()).toBe(0);
  });

  it("keeps one ACTIVE code per shop — generating for B does not revoke A's code", async () => {
    const { token, shopA, shopB } = await adminWithTwoShops();
    const a = await inviteFor(token, shopA.id);
    const b = await inviteFor(token, shopB.id);

    const rowA = await prisma.invitationCode.findUniqueOrThrow({ where: { id: a.id } });
    const rowB = await prisma.invitationCode.findUniqueOrThrow({ where: { id: b.id } });
    expect(rowA.status).toBe("ACTIVE");
    expect(rowB.status).toBe("ACTIVE");
  });
});

describe("GET /api/admin/invitation-codes/active — per-shop, never stale", () => {
  it("returns only the requested shop's code and labels it with that shop", async () => {
    const { token, shopA, shopB } = await adminWithTwoShops();
    const a = await inviteFor(token, shopA.id);
    const b = await inviteFor(token, shopB.id);

    const resA = await app.inject({ method: "GET", url: `/api/admin/invitation-codes/active?shopId=${shopA.id}`, headers: auth(token) });
    const resB = await app.inject({ method: "GET", url: `/api/admin/invitation-codes/active?shopId=${shopB.id}`, headers: auth(token) });
    expect(JSON.parse(resA.payload).data.code).toBe(a.code);
    expect(JSON.parse(resA.payload).data.shop.id).toBe(shopA.id);
    expect(JSON.parse(resB.payload).data.code).toBe(b.code);
    expect(JSON.parse(resB.payload).data.shop.id).toBe(shopB.id);
  });

  it("returns null when the requested shop has no active code, and 403 for a shop not owned", async () => {
    const { token, shopA, shopB } = await adminWithTwoShops();
    await generateInvite(token, { shopId: shopA.id });

    const none = await app.inject({ method: "GET", url: `/api/admin/invitation-codes/active?shopId=${shopB.id}`, headers: auth(token) });
    expect(JSON.parse(none.payload).data).toBeNull();

    const other = await adminSignup("other@rbr.test", "Singanallur");
    const denied = await app.inject({ method: "GET", url: `/api/admin/invitation-codes/active?shopId=${other.shop.id}`, headers: auth(token) });
    expect(denied.statusCode).toBe(403);
  });
});

describe("POST /api/admin/invitation-codes/:id/revoke", () => {
  it("revokes a code for an owned shop even when that shop is not the active one", async () => {
    const { token, shopB } = await adminWithTwoShops();
    const b = await inviteFor(token, shopB.id);
    const res = await app.inject({ method: "POST", url: `/api/admin/invitation-codes/${b.id}/revoke`, headers: auth(token) });
    expect(res.statusCode).toBe(200);
  });

  it("reports another admin's code as not found", async () => {
    const { token } = await adminWithTwoShops();
    const other = await adminSignup("other@rbr.test", "Singanallur");
    const theirs = await inviteFor(other.token, other.shop.id);
    const res = await app.inject({ method: "POST", url: `/api/admin/invitation-codes/${theirs.id}/revoke`, headers: auth(token) });
    expect(res.statusCode).toBe(404);
  });
});

// ── §2 Invite → signup → cashier → shop ─────────────────────────────────

describe("Cashier signup assigns the invite's shop", () => {
  it("two cashiers invited to two different shops end up in those two shops", async () => {
    const { token, shopA, shopB } = await adminWithTwoShops();
    const inviteA = await inviteFor(token, shopA.id);
    const inviteB = await inviteFor(token, shopB.id);

    const c1 = await onboardCashier(token, inviteA.code, "cashier1@eggmart.test");
    const c2 = await onboardCashier(token, inviteB.code, "cashier2@eggmart.test");

    expect(c1.cashier.shop.id).toBe(shopA.id);
    expect(c2.cashier.shop.id).toBe(shopB.id);
    expect(c1.cashier.shop.id).not.toBe(c2.cashier.shop.id);

    // Persisted, not just serialized:
    expect((await prisma.user.findUniqueOrThrow({ where: { id: c1.id } })).shopId).toBe(shopA.id);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: c2.id } })).shopId).toBe(shopB.id);

    // /auth/me (what the Cashier Profile page displays) agrees:
    const meB = await app.inject({ method: "GET", url: "/api/auth/me", headers: auth(c2.token) });
    expect(JSON.parse(meB.payload).shop.name).toBe(shopB.name);
  });

  it("ignores any shopId / shop info the cashier frontend tries to send at signup", async () => {
    const { token, shopA, shopB } = await adminWithTwoShops();
    const inviteB = await inviteFor(token, shopB.id);

    // Cashier tries to sneak into A (and types A's location as branch name).
    const c = await onboardCashier(token, inviteB.code, "sneaky@eggmart.test", {
      shopId: shopA.id,
      branchName: shopA.location,
    });
    expect(c.cashier.shop.id).toBe(shopB.id);
  });

  it("an invite is single-use: a second signup with the same code is rejected", async () => {
    const { token, shopB } = await adminWithTwoShops();
    const invite = await inviteFor(token, shopB.id);
    await onboardCashier(token, invite.code, "first@eggmart.test");

    const verify = await app.inject({ method: "POST", url: "/api/auth/signup/verify-invitation", payload: { code: invite.code } });
    expect(verify.statusCode).toBe(409);
  });
});

// ── §3 Authenticated shop scoping / Shop A vs Shop B isolation ──────────

describe("Authenticated cashier scoping — Shop A vs Shop B", () => {
  async function twoCashiersWithData() {
    const { token, shopA, shopB } = await adminWithTwoShops();
    const inviteA = await inviteFor(token, shopA.id);
    const inviteB = await inviteFor(token, shopB.id);
    const cashierA = await onboardCashier(token, inviteA.code, "cashier1@eggmart.test");
    const cashierB = await onboardCashier(token, inviteB.code, "cashier2@eggmart.test");

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
