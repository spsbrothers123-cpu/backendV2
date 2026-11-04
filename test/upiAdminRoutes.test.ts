/**
 * Route-level tests for /api/admin/upi/* against an in-memory fake of the
 * Prisma calls these routes make — so authorization, validation, error
 * codes, response shapes, per-admin isolation and dormant-custom behaviour
 * can be verified WITHOUT a database. The database-level behaviour (real
 * unique indexes, FK cascades) is covered by upi.integration.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";

type Row = Record<string, any>;
const db = vi.hoisted(() => ({
  users: new Map<string, Row>(),
  sessions: new Map<string, Row>(),
  links: [] as Row[],
  shops: new Map<string, Row>(),
  common: new Map<string, Row>(), // by adminId
  shopAcc: new Map<string, Row>(), // by `${adminId}:${shopId}`
  audits: [] as Row[],
  seq: 0,
}));

vi.mock("../src/lib/prisma.js", () => {
  const now = () => new Date("2026-10-19T10:00:00Z");
  const prisma = {
    session: { findUnique: async ({ where }: Row) => db.sessions.get(where.jti) ?? null },
    user: { findUnique: async ({ where }: Row) => db.users.get(where.id) ?? null },
    shop: { findUnique: async ({ where }: Row) => db.shops.get(where.id) ?? null },
    adminShopLink: {
      findMany: async ({ where, include }: Row) => {
        let rows = db.links.filter((l) => {
          if (where.adminId !== undefined && typeof where.adminId === "string" && l.adminId !== where.adminId) return false;
          if (where.adminId?.not && l.adminId === where.adminId.not) return false;
          if (where.shopId?.in && !where.shopId.in.includes(l.shopId)) return false;
          if (where.admin) {
            const a = db.users.get(l.adminId)!;
            if (a.role !== where.admin.role || a.status !== where.admin.status) return false;
          }
          return true;
        });
        return rows.map((l) => (include?.shop ? { ...l, shop: db.shops.get(l.shopId) } : { ...l }));
      },
      findUnique: async ({ where }: Row) =>
        db.links.find((l) => l.adminId === where.adminId_shopId.adminId && l.shopId === where.adminId_shopId.shopId) ?? null,
      count: async ({ where }: Row) =>
        db.links.filter(
          (l) =>
            l.shopId === where.shopId &&
            l.adminId !== where.adminId.not &&
            db.users.get(l.adminId)!.role === where.admin.role &&
            db.users.get(l.adminId)!.status === where.admin.status
        ).length,
      create: async ({ data }: Row) => (db.links.push({ ...data, createdAt: now() }), data),
    },
    upiCommonAccount: {
      findUnique: async ({ where }: Row) => db.common.get(where.adminId) ?? null,
      upsert: async ({ where, create, update }: Row) => {
        const ex = db.common.get(where.adminId);
        const row = ex ? { ...ex, ...update, updatedAt: now() } : { id: `c${++db.seq}`, createdAt: now(), updatedAt: now(), ...create };
        db.common.set(where.adminId, row);
        return row;
      },
    },
    upiShopAccount: {
      findMany: async ({ where }: Row) =>
        [...db.shopAcc.values()].filter((r) => r.adminId === where.adminId && where.shopId.in.includes(r.shopId)),
      upsert: async ({ where, create, update }: Row) => {
        const k = `${where.adminId_shopId.adminId}:${where.adminId_shopId.shopId}`;
        const ex = db.shopAcc.get(k);
        const row = ex
          ? { ...ex, ...update, updatedAt: now() }
          : { id: `s${++db.seq}`, createdAt: now(), updatedAt: now(), mode: "COMMON", customUpiId: null, customPayeeName: null, customEnabled: false, ...create };
        db.shopAcc.set(k, row);
        return row;
      },
    },
    auditLog: { create: async ({ data }: Row) => (db.audits.push(data), data) },
  };
  return { prisma };
});
vi.mock("../src/lib/jwt.js", () => ({
  verifyAccessToken: (t: string) => ({ sub: t.split(":")[0], jti: t.split(":")[1] }),
}));

import authPlugin from "../src/plugins/auth.js";
import adminUpiRoutes from "../src/routes/admin/upi.js";
import { AppError } from "../src/lib/errors.js";
import { ZodError } from "zod";

let app: FastifyInstance;

function addUser(id: string, role: "ADMIN" | "CASHIER", shopId: string | null = null, status = "ACTIVE") {
  db.users.set(id, { id, name: id, email: `${id}@t.test`, role, status, shopId });
  db.sessions.set(`${id}-jti`, { jti: `${id}-jti`, revokedAt: null, expiresAt: new Date("2030-01-01") });
}
const auth = (id: string) => ({ authorization: `Bearer ${id}:${id}-jti` });

beforeEach(async () => {
  for (const m of [db.users, db.sessions, db.shops, db.common, db.shopAcc]) m.clear();
  db.links.length = 0;
  db.audits.length = 0;
  db.seq = 0;
  db.shops.set("shopA", { id: "shopA", name: "RBR Egg Mart - A", code: "A", location: "A" });
  db.shops.set("shopB", { id: "shopB", name: "RBR Egg Mart - B", code: "B", location: "B" });
  db.shops.set("shopX", { id: "shopX", name: "RBR Egg Mart - X", code: "X", location: "X" });
  addUser("admin1", "ADMIN", "shopA");
  addUser("admin2", "ADMIN", "shopX");
  addUser("cashier1", "CASHIER", "shopA");
  db.links.push({ adminId: "admin1", shopId: "shopA", createdAt: new Date(1) }, { adminId: "admin1", shopId: "shopB", createdAt: new Date(2) });
  db.links.push({ adminId: "admin2", shopId: "shopX", createdAt: new Date(1) });

  app = Fastify();
  await app.register(authPlugin);
  await app.register(adminUpiRoutes, { prefix: "/api/admin/upi" });
  // Same shape as the central handler in app.ts.
  app.setErrorHandler((error: any, _req, reply) => {
    if (error instanceof AppError) return reply.code(error.statusCode).send({ success: false, message: error.message, code: error.code });
    if (error instanceof ZodError) return reply.code(422).send({ success: false, code: "VALIDATION_ERROR" });
    return reply.code(500).send({ success: false, code: "INTERNAL_ERROR", message: String(error) });
  });
  await app.ready();
});

const put = (url: string, who: string, payload: unknown) => app.inject({ method: "PUT", url, headers: auth(who), payload: payload as never });
const get = (url: string, who: string) => app.inject({ method: "GET", url, headers: auth(who) });
const json = (r: { payload: string }) => JSON.parse(r.payload);

describe("authentication & roles", () => {
  it("requires authentication on every endpoint", async () => {
    expect((await app.inject({ method: "GET", url: "/api/admin/upi/overview" })).statusCode).toBe(401);
    expect((await app.inject({ method: "PUT", url: "/api/admin/upi/common", payload: {} })).statusCode).toBe(401);
    expect((await app.inject({ method: "PUT", url: "/api/admin/upi/shops/shopA", payload: {} })).statusCode).toBe(401);
  });

  it("cashiers cannot read or edit any UPI setting", async () => {
    const good = { upiId: "x@okbank", payeeName: "Me", enabled: true };
    for (const r of [
      await get("/api/admin/upi/overview", "cashier1"),
      await put("/api/admin/upi/common", "cashier1", good),
      await put("/api/admin/upi/shops/shopA", "cashier1", { mode: "COMMON" }),
    ]) {
      expect(r.statusCode).toBe(403);
      expect(json(r).code).toBe("ROLE_NOT_ALLOWED");
    }
    expect(db.common.size).toBe(0);
    expect(db.shopAcc.size).toBe(0);
  });
});

describe("common account", () => {
  it("saves, normalizes and returns the common account (+ audit entry, masked)", async () => {
    const res = await put("/api/admin/upi/common", "admin1", { upiId: "  Shop@OkBank ", payeeName: " RBR Egg Mart ", enabled: true });
    expect(res.statusCode).toBe(200);
    expect(json(res).data.common).toMatchObject({ upiId: "shop@okbank", payeeName: "RBR Egg Mart", enabled: true });
    expect(db.audits).toHaveLength(1);
    expect(db.audits[0]).toMatchObject({ action: "UPI_CONFIG_UPDATED", actorId: "admin1" });
    expect(JSON.stringify(db.audits[0])).not.toContain("shop@okbank");
  });

  it("updates in place (one row per admin)", async () => {
    await put("/api/admin/upi/common", "admin1", { upiId: "aa@okbank", payeeName: "One", enabled: true });
    await put("/api/admin/upi/common", "admin1", { upiId: "bb@okbank", payeeName: "Two", enabled: false });
    expect(db.common.size).toBe(1);
    expect(db.common.get("admin1")).toMatchObject({ upiId: "bb@okbank", enabled: false });
  });

  it("returns field-specific error codes and saves nothing", async () => {
    const badId = await put("/api/admin/upi/common", "admin1", { upiId: "nope", payeeName: "Ok Name", enabled: true });
    expect(badId.statusCode).toBe(422);
    expect(json(badId).code).toBe("UPI_ID_INVALID");
    const badName = await put("/api/admin/upi/common", "admin1", { upiId: "aa@okbank", payeeName: "x", enabled: true });
    expect(json(badName).code).toBe("PAYEE_NAME_INVALID");
    const badShape = await put("/api/admin/upi/common", "admin1", { upiId: "aa@okbank" });
    expect(badShape.statusCode).toBe(422);
    expect(json(badShape).code).toBe("VALIDATION_ERROR");
    expect(db.common.size).toBe(0);
  });
});

describe("shop accounts & resolution", () => {
  it("custom account takes priority over common; disabled custom falls back; COMMON keeps custom dormant", async () => {
    await put("/api/admin/upi/common", "admin1", { upiId: "common@okbank", payeeName: "Common Co", enabled: true });

    const noCfg = json(await get("/api/admin/upi/overview", "admin1")).data;
    expect(noCfg.branches.map((b: Row) => b.effective.source)).toEqual(["COMMON", "COMMON"]);

    const saved = await put("/api/admin/upi/shops/shopA", "admin1", { mode: "CUSTOM", upiId: "Veera@OkSBI", payeeName: "Veera Shop", enabled: true });
    expect(saved.statusCode).toBe(200);
    expect(json(saved).data.branch).toMatchObject({ shopId: "shopA", mode: "CUSTOM", effective: { source: "SHOP", upiId: "veera@oksbi", payeeName: "Veera Shop" } });

    // Switching to COMMON: effective flips to common, custom details retained.
    const back = json(await put("/api/admin/upi/shops/shopA", "admin1", { mode: "COMMON" })).data.branch;
    expect(back.mode).toBe("COMMON");
    expect(back.effective).toMatchObject({ source: "COMMON", upiId: "common@okbank" });
    expect(back.custom).toEqual({ upiId: "veera@oksbi", payeeName: "Veera Shop", enabled: true });

    // Back to CUSTOM but disabled -> common fallback with a reason.
    const dis = json(await put("/api/admin/upi/shops/shopA", "admin1", { mode: "CUSTOM", upiId: "veera@oksbi", payeeName: "Veera Shop", enabled: false })).data.branch;
    expect(dis.effective.source).toBe("COMMON");
    expect(dis.effective.reason).toMatch(/disabled/);
  });

  it("with nothing configured the effective receiver is NONE with a reason", async () => {
    const o = json(await get("/api/admin/upi/overview", "admin1")).data;
    expect(o.common).toBeNull();
    for (const b of o.branches) {
      expect(b.effective).toMatchObject({ source: "NONE", upiId: null, payeeName: null });
      expect(b.effective.reason).toBeTruthy();
    }
  });

  it("rejects CUSTOM without valid details using field codes", async () => {
    const r = await put("/api/admin/upi/shops/shopA", "admin1", { mode: "CUSTOM", upiId: "bad", payeeName: "Valid Name", enabled: true });
    expect(json(r).code).toBe("UPI_ID_INVALID");
    const r2 = await put("/api/admin/upi/shops/shopA", "admin1", { mode: "CUSTOM", upiId: "ok@okbank", payeeName: "", enabled: true });
    expect(json(r2).code).toBe("PAYEE_NAME_INVALID");
    const r3 = await put("/api/admin/upi/shops/shopA", "admin1", { mode: "WHATEVER" });
    expect(r3.statusCode).toBe(422);
    expect(db.shopAcc.size).toBe(0);
  });

  it("unauthorized shops are rejected and nothing is written", async () => {
    const r = await put("/api/admin/upi/shops/shopX", "admin1", { mode: "COMMON" });
    expect(r.statusCode).toBe(403);
    expect(json(r).code).toBe("SHOP_ACCESS_DENIED");
    const missing = await put("/api/admin/upi/shops/does-not-exist", "admin1", { mode: "COMMON" });
    expect(missing.statusCode).toBe(403);
    expect(db.shopAcc.size).toBe(0);
  });

  it("works for every authorized shop regardless of the globally selected shop (User.shopId)", async () => {
    // admin1's active shop is shopA; configuring shopB must not need (or change) a switch.
    const r = await put("/api/admin/upi/shops/shopB", "admin1", { mode: "CUSTOM", upiId: "bb@okbank", payeeName: "Shop B", enabled: true });
    expect(r.statusCode).toBe(200);
    expect(db.users.get("admin1")!.shopId).toBe("shopA");
  });
});

describe("cross-admin isolation", () => {
  it("one admin never sees or affects another admin's configuration", async () => {
    await put("/api/admin/upi/common", "admin1", { upiId: "one@okbank", payeeName: "Admin One", enabled: true });
    await put("/api/admin/upi/common", "admin2", { upiId: "two@okbank", payeeName: "Admin Two", enabled: true });
    expect(db.common.size).toBe(2);

    const o1 = json(await get("/api/admin/upi/overview", "admin1")).data;
    const o2 = json(await get("/api/admin/upi/overview", "admin2")).data;
    expect(o1.common.upiId).toBe("one@okbank");
    expect(o2.common.upiId).toBe("two@okbank");
    expect(o1.branches.map((b: Row) => b.shopId)).toEqual(["shopA", "shopB"]);
    expect(o2.branches.map((b: Row) => b.shopId)).toEqual(["shopX"]);
    expect(JSON.stringify(o1)).not.toContain("two@okbank");
    expect(JSON.stringify(o2)).not.toContain("one@okbank");
  });

  it("a shop linked to two admins keeps separate settings and reports sharing as a boolean only", async () => {
    db.links.push({ adminId: "admin2", shopId: "shopA", createdAt: new Date(3) });
    await put("/api/admin/upi/shops/shopA", "admin1", { mode: "CUSTOM", upiId: "one@okbank", payeeName: "Admin One", enabled: true });
    await put("/api/admin/upi/shops/shopA", "admin2", { mode: "CUSTOM", upiId: "two@okbank", payeeName: "Admin Two", enabled: true });
    expect(db.shopAcc.size).toBe(2);

    const o1 = json(await get("/api/admin/upi/overview", "admin1")).data;
    const a1 = o1.branches.find((b: Row) => b.shopId === "shopA");
    expect(a1.effective.upiId).toBe("one@okbank");
    expect(a1.sharedWithOtherAdmins).toBe(true);
    expect(JSON.stringify(o1)).not.toContain("two@okbank");
    expect(o1.branches.find((b: Row) => b.shopId === "shopB").sharedWithOtherAdmins).toBe(false);
  });
});
