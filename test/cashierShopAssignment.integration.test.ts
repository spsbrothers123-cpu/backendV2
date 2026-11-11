/**
 * Integration tests for cashier shop assignment: invite → signup → approval
 * → login → authenticated shop scoping, plus Shop A vs Shop B isolation.
 *
 * Contract (Phase 2, Stage 2.4): an invitation code is generic (never tied
 * to a shop). The cashier SELECTS an existing branch at signup by sending
 * its `shopId`; free-text branch names never create, find or choose a shop.
 * One cashier per branch: a taken branch is refused and the invite is NOT
 * consumed. Branch scoping of products/stock is via BranchProduct, not
 * Product.shopId.
 *
 * Same constraints as the other test/*.integration.test.ts files — needs a
 * real Postgres database, excluded from the default sandboxed `npm test`
 * run:
 *
 *   1. Point DATABASE_URL (in .env.test) at a disposable Postgres database.
 *   2. npx prisma migrate deploy
 *   3. RUN_INTEGRATION_TESTS=1 npx vitest run test/cashierShopAssignment.integration.test.ts
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { prisma } from "../src/lib/prisma.js";
import { resetDb } from "./dbReset.js";
import { createAdminFixture } from "./adminFixture.js";
import { createAssignedProduct, seedStock } from "./branchFixtures.js";

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
  return (await createAdminFixture(app, { email, shopLocation })) as { token: string; shop: ShopInfo };
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

/** Full cashier lifecycle through the real HTTP API: verify code → signup
 * (SELECTING the given existing branch by id) → admin approves → cashier logs in. Returns the
 * cashier's token + login body. */
async function onboardCashier(
  adminToken: string,
  code: string,
  email: string,
  branchShopId: string,
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
      shopId: branchShopId,
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

// ── §2 Cashier signup SELECTS an existing branch ────────────────────────

/** Verify an invite and return the signup verification token. */
async function verifyToken(code: string) {
  const verify = await app.inject({ method: "POST", url: "/api/auth/signup/verify-invitation", payload: { code } });
  expect(verify.statusCode).toBe(200);
  return JSON.parse(verify.payload).verificationToken as string;
}

function rawSignup(payload: Record<string, unknown>) {
  return app.inject({ method: "POST", url: "/api/auth/signup", payload });
}

describe("Cashier signup selects an existing branch", () => {
  it("two cashiers with the same admin's codes select different branches and land in those two shops — no shop is created", async () => {
    const { token, shopA, shopB } = await adminWithTwoShops();
    const shopsBefore = await prisma.shop.count();

    const c1 = await onboardCashier(token, (await inviteFor(token)).code, "cashier1@eggmart.test", shopA.id);
    // A single-use code — mint a fresh one for the second cashier.
    const c2 = await onboardCashier(token, (await inviteFor(token)).code, "cashier2@eggmart.test", shopB.id);

    expect(c1.cashier.shop.id).toBe(shopA.id);
    expect(c2.cashier.shop.id).toBe(shopB.id);
    expect(c1.cashier.shop.id).not.toBe(c2.cashier.shop.id);
    expect(await prisma.shop.count()).toBe(shopsBefore);
  });

  it("requires a shopId: a free-text branchName alone is rejected and creates no shop", async () => {
    const { token } = await adminWithTwoShops();
    const invite = await inviteFor(token);
    const verificationToken = await verifyToken(invite.code);
    const shopsBefore = await prisma.shop.count();

    const res = await rawSignup({
      name: "typed",
      email: "typed@eggmart.test",
      password: "Password123",
      branchName: "  veerapandi ",
      verificationToken,
    });
    expect(res.statusCode).toBe(422);
    expect(JSON.parse(res.payload).message).toContain("shopId");
    expect(await prisma.shop.count()).toBe(shopsBefore);
  });

  it("an extra free-text branchName is ignored: the selected shopId alone decides the shop", async () => {
    const { token, shopA } = await adminWithTwoShops();
    const invite = await inviteFor(token);
    const shopsBefore = await prisma.shop.count();

    // ASSUMPTION: the signup schema strips unknown keys (zod default). If it
    // is .strict(), this returns 422 instead and the test should be dropped.
    const c = await onboardCashier(token, invite.code, "sneaky@eggmart.test", shopA.id, {
      branchName: "Brand New Branch",
    });
    expect(c.cashier.shop.id).toBe(shopA.id);
    expect(await prisma.shop.count()).toBe(shopsBefore);
  });

  it("an unknown shopId is rejected with BRANCH_NOT_FOUND and the invite stays ACTIVE", async () => {
    const { token } = await adminWithTwoShops();
    const invite = await inviteFor(token);
    const verificationToken = await verifyToken(invite.code);

    const res = await rawSignup({
      name: "ghost",
      email: "ghost@eggmart.test",
      password: "Password123",
      shopId: "00000000-0000-0000-0000-000000000000",
      verificationToken,
    });
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.payload).code).toBe("BRANCH_NOT_FOUND");

    const row = await prisma.invitationCode.findUniqueOrThrow({ where: { id: invite.id } });
    expect(row.status).toBe("ACTIVE");
  });

  it("one cashier per branch: a branch that already has a cashier is refused and the invite is NOT consumed", async () => {
    const { token, shopA, shopB } = await adminWithTwoShops();
    await onboardCashier(token, (await inviteFor(token)).code, "first@eggmart.test", shopA.id);

    const invite = await inviteFor(token);
    const verificationToken = await verifyToken(invite.code);
    const res = await rawSignup({
      name: "second",
      email: "second@eggmart.test",
      password: "Password123",
      shopId: shopA.id,
      verificationToken,
    });
    // ASSUMPTION: 409. assertBranchCashierSlotFree (lib/branchCashier.ts) was
    // not provided — adjust the status/code here if it differs.
    expect(res.statusCode).toBe(409);

    const row = await prisma.invitationCode.findUniqueOrThrow({ where: { id: invite.id } });
    expect(row.status).toBe("ACTIVE");

    // The same invite still works for a branch with no cashier.
    const retry = await rawSignup({
      name: "second",
      email: "second@eggmart.test",
      password: "Password123",
      shopId: shopB.id,
      verificationToken,
    });
    expect(retry.statusCode).toBe(201);
  });

  it("approval keeps the cashier's own shop no matter which shop the admin has selected at that moment", async () => {
    const { token, shopA, shopB } = await adminWithTwoShops();

    // Two cashiers sign up (approval deliberately NOT done yet): one for
    // shop A, one for shop B.
    async function signupOnly(email: string, branchShopId: string) {
      const invite = await inviteFor(token);
      const verificationToken = await verifyToken(invite.code);
      const signup = await rawSignup({
        name: email.split("@")[0],
        email,
        password: "Password123",
        shopId: branchShopId,
        verificationToken,
      });
      expect(signup.statusCode).toBe(201);
      return JSON.parse(signup.payload).requestId as string;
    }
    const requestA = await signupOnly("toA@eggmart.test", shopA.id);
    const requestB = await signupOnly("toB@eggmart.test", shopB.id);

    async function selectShop(shopId: string) {
      const res = await app.inject({ method: "POST", url: "/api/admin/shops/switch", headers: auth(token), payload: { shopId } });
      expect(res.statusCode).toBe(200);
    }
    // NOTE: if this fails with 404 on approve, that is the known gap in
    // routes/admin/cashierRequests.ts (scopes to the active shop instead of
    // every shop the admin owns) — a real backend bug, not a test problem.
    async function approve(requestId: string) {
      const res = await app.inject({ method: "POST", url: `/api/admin/cashier-requests/${requestId}/approve`, headers: auth(token) });
      expect(res.statusCode).toBe(200);
    }

    // Approve A's cashier while B is selected, and B's cashier while A is
    // selected — the exact "wrong selector" case in both directions.
    await selectShop(shopB.id);
    await approve(requestA);
    await selectShop(shopA.id);
    await approve(requestB);

    const cashierA = await prisma.user.findUniqueOrThrow({ where: { id: requestA } });
    const cashierB = await prisma.user.findUniqueOrThrow({ where: { id: requestB } });
    expect(cashierA.status).toBe("ACTIVE");
    expect(cashierB.status).toBe("ACTIVE");
    expect(cashierA.shopId).toBe(shopA.id);
    expect(cashierB.shopId).toBe(shopB.id);
  });

  it("an invite is single-use: a second verification with the same code is rejected", async () => {
    const { token, shopA } = await adminWithTwoShops();
    const invite = await inviteFor(token);
    await onboardCashier(token, invite.code, "first@eggmart.test", shopA.id);

    const verify = await app.inject({ method: "POST", url: "/api/auth/signup/verify-invitation", payload: { code: invite.code } });
    expect(verify.statusCode).toBe(409);
  });
});

// ── §3 Authenticated shop scoping / Shop A vs Shop B isolation ──────────

describe("Authenticated cashier scoping — Shop A vs Shop B", () => {
  async function twoCashiersWithData() {
    const { token, shopA, shopB } = await adminWithTwoShops();
    const cashierA = await onboardCashier(token, (await inviteFor(token)).code, "cashier1@eggmart.test", shopA.id);
    const cashierB = await onboardCashier(token, (await inviteFor(token)).code, "cashier2@eggmart.test", shopB.id);

    // Each product is ASSIGNED to its own branch only (BranchProduct).
    const mk = (shopId: string, name: string, barcode: string) =>
      createAssignedProduct({
        shopId, name, category: "Egg", sellingPrice: 6, costPrice: 5, stock: 10, unit: "PIECE", lowStockThreshold: 1, barcode,
      });
    const productA = await mk(shopA.id, "Product only in A", "A-1");
    const productB = await mk(shopB.id, "Product only in B", "B-1");

    // Stock in whichever table the active inventory mode reads (a zero-stock
    // product can never enter a cart or be held).
    await seedStock(shopA.id, cashierA.id, productA.id, 10);
    await seedStock(shopB.id, cashierB.id, productB.id, 10);

    return { token, shopA, shopB, cashierA, cashierB, productA, productB };
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
    const { cashierA, shopA, shopB, productA, productB } = await twoCashiersWithData();
    await app.inject({
      method: "POST",
      url: "/api/sessions/start",
      headers: auth(cashierA.token),
      payload: { openingCash: 0 },
    });

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
