/**
 * Integration tests — Cashier admin-assisted password recovery (Phase 2 backend).
 *
 * Needs a disposable LOCAL Postgres (the test setup refuses anything else):
 *   RUN_INTEGRATION_TESTS=1 npx vitest run test/cashierRecovery.integration.test.ts
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { prisma } from "../src/lib/prisma.js";
import { env } from "../src/config/env.js";
import { hashPassword, verifyPassword } from "../src/lib/password.js";
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

// ── helpers ────────────────────────────────────────────────────────────
const post = (url: string, payload: unknown, token?: string, remoteAddress?: string) =>
  app.inject({
    method: "POST",
    url,
    payload: payload as object,
    remoteAddress,
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
const get = (url: string, token?: string) =>
  app.inject({ method: "GET", url, headers: token ? { authorization: `Bearer ${token}` } : {} });
const json = (r: { payload: string }) => JSON.parse(r.payload);

async function centralAdmin(location = "Veerapandi", email = "central@rbr.test") {
  const a = await createAdminFixture(app, { email, shopLocation: location });
  envMut.CENTRAL_ADMIN_USER_ID = a.user.id;
  return a;
}
async function cashier(shopId: string, email: string, name = "Cashier") {
  return prisma.user.create({
    data: { name, email, passwordHash: await hashPassword(OLD), role: "CASHIER", status: "ACTIVE", shopId },
  });
}
async function cashierLogin(email: string, password = OLD) {
  return post("/api/auth/login", { email, password });
}
const request = (email: string, ip?: string) => post("/api/auth/cashier-recovery/request", { email }, undefined, ip);
const reset = (email: string, code: string, newPassword = NEW) =>
  post("/api/auth/cashier-recovery/reset", { email, code, newPassword });
const approve = (token: string, id: string, body: object = { currentPassword: ADMIN_PW, identityVerified: true }) =>
  post(`/api/admin/cashier-recovery/${id}/approve`, body, token);

/** central admin + a cashier with a PENDING request */
async function pendingSetup(email = "cash@rbr.test") {
  const admin = await centralAdmin();
  const c = await cashier(admin.shop.id, email);
  expect((await request(email)).statusCode).toBe(200);
  const req = await prisma.cashierRecoveryRequest.findFirstOrThrow({ where: { userId: c.id } });
  return { admin, c, req };
}
async function approvedSetup(email = "cash@rbr.test") {
  const s = await pendingSetup(email);
  const res = await approve(s.admin.token, s.req.id);
  expect(res.statusCode).toBe(200);
  return { ...s, code: json(res).data.code as string };
}
/** Moves a request into the past (createdAt & expiresAt together, as the CHECK demands). */
async function backdate(id: string, minutes: number) {
  await prisma.$executeRaw`UPDATE cashier_recovery_requests SET "createdAt" = "createdAt" - make_interval(mins => ${minutes}::int), "expiresAt" = "expiresAt" - make_interval(mins => ${minutes}::int) WHERE id = ${id}`;
}
// ── 1–2. request + enumeration safety ──────────────────────────────────
describe.skipIf(!enabled)("request", () => {
  it("creates a PENDING request with expiresAt exactly createdAt + 15 minutes", async () => {
    const { req } = await pendingSetup();
    expect(req.status).toBe("PENDING");
    expect(req.expiresAt.getTime() - req.createdAt.getTime()).toBe(15 * 60_000);
    expect(req.codeHash).toBeNull();
  });

  it("returns the identical generic response for known, unknown, admin, and non-active accounts — and creates nothing for the latter three", async () => {
    const admin = await centralAdmin();
    await cashier(admin.shop.id, "real@rbr.test");
    const suspended = await cashier(admin.shop.id, "sus@rbr.test");
    await prisma.user.update({ where: { id: suspended.id }, data: { status: "SUSPENDED" } });

    const payloads = new Set<string>();
    for (const e of ["real@rbr.test", "ghost@rbr.test", "central@rbr.test", "sus@rbr.test"]) {
      const r = await request(e);
      expect(r.statusCode).toBe(200);
      payloads.add(r.payload);
    }
    expect(payloads.size).toBe(1);
    expect(await prisma.cashierRecoveryRequest.count()).toBe(1);
  });

  it("does not create a second active request; repeated submits look identical", async () => {
    const { c } = await pendingSetup();
    const again = await request("cash@rbr.test");
    expect(again.statusCode).toBe(200);
    expect(await prisma.cashierRecoveryRequest.count({ where: { userId: c.id } })).toBe(1);
  });

  it("concurrent duplicate submits yield exactly one row (partial unique index)", async () => {
    const admin = await centralAdmin();
    await cashier(admin.shop.id, "cash@rbr.test");
    const rs = await Promise.all(Array.from({ length: 8 }, () => request("cash@rbr.test")));
    expect(rs.every((r) => r.statusCode === 200)).toBe(true);
    expect(await prisma.cashierRecoveryRequest.count()).toBe(1);
  });

  it("a rejected/expired request does not block an immediate new one", async () => {
    const { admin, c, req } = await pendingSetup();
    expect((await post(`/api/admin/cashier-recovery/${req.id}/reject`, {}, admin.token)).statusCode).toBe(200);
    await request("cash@rbr.test");
    expect(await prisma.cashierRecoveryRequest.count({ where: { userId: c.id, status: "PENDING" } })).toBe(1);

    const second = await prisma.cashierRecoveryRequest.findFirstOrThrow({ where: { userId: c.id, status: "PENDING" } });
    await backdate(second.id, 20); // lapsed, but still "PENDING" on disk
    await request("cash@rbr.test");
    const rows = await prisma.cashierRecoveryRequest.findMany({ where: { userId: c.id }, orderBy: { createdAt: "asc" } });
    expect(rows.map((r) => r.status).sort()).toEqual(["EXPIRED", "PENDING", "REJECTED"]);
  });

  it("throttles per account (5/hour) and per IP (10/hour) without changing the 200 for the account throttle", async () => {
    const admin = await centralAdmin();
    const c = await cashier(admin.shop.id, "cash@rbr.test");
    for (let i = 0; i < 6; i++) {
      await prisma.cashierRecoveryRequest.updateMany({ where: { userId: c.id, status: "PENDING" }, data: { status: "REJECTED" } });
      expect((await request("cash@rbr.test")).statusCode).toBe(200);
    }
    expect(await prisma.cashierRecoveryRequest.count({ where: { userId: c.id } })).toBe(5);

    for (let i = 0; i < 10; i++) {
      await prisma.cashierRecoveryRequest.create({
        data: { userId: c.id, status: "REJECTED", createdAt: new Date(), expiresAt: new Date(Date.now() + 15 * 60_000), ip: "10.9.9.9" },
      }).catch(() => undefined);
    }
    const flooded = await request("cash@rbr.test", "10.9.9.9");
    expect(flooded.statusCode).toBe(429);
  });

  it("fails closed (503) when the Central Admin or pepper is not configured", async () => {
    const admin = await createAdminFixture(app, { email: "a@rbr.test", shopLocation: "Veerapandi" });
    await cashier(admin.shop.id, "cash@rbr.test");
    expect((await request("cash@rbr.test")).statusCode).toBe(503);
    expect((await reset("cash@rbr.test", "AAAA", NEW)).statusCode).toBe(503);
    expect((await get("/api/admin/cashier-recovery", admin.token)).statusCode).toBe(503);
  });
});

// ── 3–5. Admin authorization ───────────────────────────────────────────
describe.skipIf(!enabled)("central admin authorization", () => {
  it("central admin sees requests from EVERY shop, regardless of the selected shop", async () => {
    const admin = await centralAdmin("Veerapandi");
    const other = await createAdminFixture(app, { email: "branch@rbr.test", shopLocation: "Gandhipuram" });
    const s1 = await cashier(admin.shop.id, "c1@rbr.test", "One");
    const s2 = await cashier(other.shop.id, "c2@rbr.test", "Two"); // a shop the central admin is NOT linked to
    await request("c1@rbr.test");
    await request("c2@rbr.test");
    expect(await prisma.adminShopLink.count({ where: { adminId: admin.user.id, shopId: other.shop.id } })).toBe(0);

    const list = json(await get("/api/admin/cashier-recovery", admin.token)).data;
    expect(list.map((r: { cashier: { id: string } }) => r.cashier.id).sort()).toEqual([s1.id, s2.id].sort());
    expect(list[0]).toHaveProperty("shop.name");
    expect(list[0]).toHaveProperty("expiresAt");
    expect(JSON.stringify(list)).not.toMatch(/codeHash|userAgent|"ip"/);

    // Switching the active shop changes nothing.
    await post("/api/admin/shops/switch", { shopId: admin.shop.id }, admin.token);
    expect(json(await get("/api/admin/cashier-recovery", admin.token)).data).toHaveLength(2);
  });

  it("a different ADMIN is refused (403) on every route, and the attempt is audited", async () => {
    const { req } = await pendingSetup();
    const other = await createAdminFixture(app, { email: "branch@rbr.test", shopLocation: "Gandhipuram" });
    expect((await get("/api/admin/cashier-recovery", other.token)).statusCode).toBe(403);
    expect((await approve(other.token, req.id)).statusCode).toBe(403);
    expect((await post(`/api/admin/cashier-recovery/${req.id}/reject`, {}, other.token)).statusCode).toBe(403);
    expect(json(await get("/api/admin/cashier-recovery", other.token)).code).toBe("CENTRAL_ADMIN_REQUIRED");
    expect(await prisma.auditLog.count({ where: { action: "CASHIER_RECOVERY_DENIED", actorId: other.user.id } })).toBe(3 + 1);
    expect((await prisma.cashierRecoveryRequest.findUniqueOrThrow({ where: { id: req.id } })).status).toBe("PENDING");
  });

  it("a Cashier token is refused; anonymous callers get 401", async () => {
    const { req } = await pendingSetup();
    const login = json(await cashierLogin("cash@rbr.test"));
    expect((await get("/api/admin/cashier-recovery", login.token)).statusCode).toBe(403);
    expect((await approve(login.token, req.id)).statusCode).toBe(403);
    expect((await get("/api/admin/cashier-recovery")).statusCode).toBe(401);
    expect((await approve("", req.id)).statusCode).toBe(401);
    expect((await prisma.cashierRecoveryRequest.findUniqueOrThrow({ where: { id: req.id } })).status).toBe("PENDING");
  });

  it("a recovery-flow client holds nothing usable on ordinary APIs (no token is ever issued by recovery)", async () => {
    const { c, code } = await approvedSetup();
    const res = await reset("cash@rbr.test", code);
    expect(res.statusCode).toBe(200);
    expect(JSON.stringify(json(res))).not.toMatch(/token|jwt/i);
    expect((await get("/api/auth/me", code)).statusCode).toBe(401);
    void c;
  });
});

// ── approval ───────────────────────────────────────────────────────────
describe.skipIf(!enabled)("approval", () => {
  it("requires password re-auth and the in-person confirmation", async () => {
    const { admin, req } = await pendingSetup();
    expect((await approve(admin.token, req.id, { currentPassword: "WrongPassword1", identityVerified: true })).statusCode).toBe(403);
    expect((await approve(admin.token, req.id, { currentPassword: ADMIN_PW })).statusCode).toBe(422);
    expect((await approve(admin.token, req.id, { currentPassword: ADMIN_PW, identityVerified: false })).statusCode).toBe(422);
    expect((await prisma.cashierRecoveryRequest.findUniqueOrThrow({ where: { id: req.id } })).status).toBe("PENDING");
  });

  it("issues a code once; stores only a keyed hash; does not move the deadline; never leaks via list", async () => {
    const { admin, req } = await pendingSetup();
    const res = await approve(admin.token, req.id);
    expect(res.statusCode).toBe(200);
    const { code, expiresAt } = json(res).data;
    expect(code).toMatch(/^([0-9A-Z]{4}-){7}[0-9A-Z]{4}$/); // 32 chars / 160 bits
    expect(new Date(expiresAt).getTime()).toBe(req.expiresAt.getTime());

    const row = await prisma.cashierRecoveryRequest.findUniqueOrThrow({ where: { id: req.id } });
    expect(row.status).toBe("APPROVED");
    expect(row.expiresAt.getTime()).toBe(req.expiresAt.getTime());
    expect(row.codeHash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.codeHash).not.toContain(code.replace(/-/g, ""));
    expect(row.decidedById).toBe(admin.user.id);

    const list = await get("/api/admin/cashier-recovery?filter=all", admin.token);
    expect(list.payload).not.toContain(code);
    expect(list.payload).not.toContain(code.replace(/-/g, ""));
    expect(list.headers["cache-control"]).toBe("no-store");
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  it("cannot be approved twice (and concurrent approvals produce a single winner)", async () => {
    const { admin, req } = await pendingSetup();
    const rs = await Promise.all(Array.from({ length: 6 }, () => approve(admin.token, req.id)));
    expect(rs.filter((r) => r.statusCode === 200)).toHaveLength(1);
    expect(rs.filter((r) => r.statusCode === 409)).toHaveLength(5);
  });

  it("rejects approval of an expired request and does not extend it", async () => {
    const { admin, req } = await pendingSetup();
    await backdate(req.id, 16);
    const res = await approve(admin.token, req.id);
    expect(res.statusCode).toBe(409);
    expect(json(res).code).toBe("RECOVERY_REQUEST_EXPIRED");
    expect((await prisma.cashierRecoveryRequest.findUniqueOrThrow({ where: { id: req.id } })).status).toBe("EXPIRED");
  });

  it("a rejected request cannot be approved or reused; rejecting an approved one revokes its code", async () => {
    const { admin, req } = await pendingSetup();
    expect((await post(`/api/admin/cashier-recovery/${req.id}/reject`, {}, admin.token)).statusCode).toBe(200);
    expect((await approve(admin.token, req.id)).statusCode).toBe(409);

    const s = await approvedSetup("second@rbr.test");
    expect((await post(`/api/admin/cashier-recovery/${s.req.id}/reject`, {}, s.admin.token)).statusCode).toBe(200);
    expect((await reset("second@rbr.test", s.code)).statusCode).toBe(400);
    const row = await prisma.cashierRecoveryRequest.findUniqueOrThrow({ where: { id: s.req.id } });
    expect(row.status).toBe("REJECTED");
    expect(row.codeHash).toBeNull();
  });
});

// ── 8–15. redemption ───────────────────────────────────────────────────
describe.skipIf(!enabled)("redemption", () => {
  it("valid code: password changes, ALL sessions revoked, old password dead, new works, admin untouched", async () => {
    const { admin, c, code } = await approvedSetup();
    const oldSession = json(await cashierLogin("cash@rbr.test"));
    const adminBefore = await prisma.user.findUniqueOrThrow({ where: { id: admin.user.id } });

    const res = await reset("cash@rbr.test", code);
    expect(res.statusCode).toBe(200);

    expect((await get("/api/auth/me", oldSession.token)).statusCode).toBe(401);
    expect(await prisma.session.count({ where: { userId: c.id, revokedAt: null } })).toBe(0);
    expect((await cashierLogin("cash@rbr.test", OLD)).statusCode).toBe(401);
    expect((await cashierLogin("cash@rbr.test", NEW)).statusCode).toBe(200);

    const adminAfter = await prisma.user.findUniqueOrThrow({ where: { id: admin.user.id } });
    expect(adminAfter.passwordHash).toBe(adminBefore.passwordHash);
    expect(await verifyPassword(ADMIN_PW, adminAfter.passwordHash)).toBe(true);

    const row = await prisma.cashierRecoveryRequest.findFirstOrThrow({ where: { userId: c.id } });
    expect(row.status).toBe("COMPLETED");
    expect(row.codeHash).toBeNull();
    expect(row.consumedAt).not.toBeNull();
  });

  it("accepts the code typed in lowercase / without dashes (what a human will do)", async () => {
    const { code } = await approvedSetup();
    expect((await reset("cash@rbr.test", code.toLowerCase().replace(/-/g, ""))).statusCode).toBe(200);
  });

  it("a used code is rejected", async () => {
    const { code } = await approvedSetup();
    expect((await reset("cash@rbr.test", code)).statusCode).toBe(200);
    expect((await reset("cash@rbr.test", code, "AnotherPass77")).statusCode).toBe(400);
    expect((await cashierLogin("cash@rbr.test", NEW)).statusCode).toBe(200);
  });

  it("every failure is the SAME 400 — unknown email, wrong code, no approval, wrong account", async () => {
    const s = await approvedSetup("a@rbr.test");
    await cashier(s.admin.shop.id, "b@rbr.test");
    const bodies = new Set<string>();
    const wrongCode = "ABCD-EFGH-JKMN-PQRS-TVWX-YZ01-2345-6789";
    for (const [email, code] of [
      ["ghost@rbr.test", wrongCode],
      ["a@rbr.test", wrongCode],
      ["b@rbr.test", s.code], // a's valid code against b's account
      ["central@rbr.test", s.code], // an admin account
    ] as const) {
      const r = await reset(email, code);
      expect(r.statusCode).toBe(400);
      bodies.add(r.payload);
    }
    expect(bodies.size).toBe(1);
    // …and a's code still works afterwards (failed guesses don't burn it).
    expect((await reset("a@rbr.test", s.code)).statusCode).toBe(200);
  });

  it("an expired request's code is rejected", async () => {
    const { req, code } = await approvedSetup();
    await backdate(req.id, 16);
    expect((await reset("cash@rbr.test", code)).statusCode).toBe(400);
    expect((await cashierLogin("cash@rbr.test", OLD)).statusCode).toBe(200);
  });

  it("a weak password is rejected (422) WITHOUT consuming the code", async () => {
    const { code } = await approvedSetup();
    expect((await reset("cash@rbr.test", code, "short1")).statusCode).toBe(422);
    expect((await reset("cash@rbr.test", code, "alllettersnonum")).statusCode).toBe(422);
    expect((await reset("cash@rbr.test", code, NEW)).statusCode).toBe(200);
  });

  it("concurrent redemption: exactly one of N parallel attempts wins", async () => {
    const { c, code } = await approvedSetup();
    const rs = await Promise.all(Array.from({ length: 8 }, (_, i) => reset("cash@rbr.test", code, `ParallelPass${i}x`)));
    expect(rs.filter((r) => r.statusCode === 200)).toHaveLength(1);
    expect(rs.filter((r) => r.statusCode === 400)).toHaveLength(7);
    const winner = rs.findIndex((r) => r.statusCode === 200);
    expect((await cashierLogin("cash@rbr.test", `ParallelPass${winner}x`)).statusCode).toBe(200);
    expect(await prisma.cashierRecoveryRequest.count({ where: { userId: c.id, status: "COMPLETED" } })).toBe(1);
  });

  it("recovery works for cashiers of different branches, each only with their own code", async () => {
    const admin = await centralAdmin("Veerapandi");
    const other = await createAdminFixture(app, { email: "branch@rbr.test", shopLocation: "Gandhipuram" });
    await cashier(admin.shop.id, "v@rbr.test");
    await cashier(other.shop.id, "g@rbr.test");
    await request("v@rbr.test");
    await request("g@rbr.test");
    const list = json(await get("/api/admin/cashier-recovery", admin.token)).data as { id: string; cashier: { email: string } }[];
    const codes: Record<string, string> = {};
    for (const r of list) codes[r.cashier.email] = json(await approve(admin.token, r.id)).data.code;
    expect((await reset("v@rbr.test", codes["g@rbr.test"])).statusCode).toBe(400);
    expect((await reset("v@rbr.test", codes["v@rbr.test"])).statusCode).toBe(200);
    expect((await reset("g@rbr.test", codes["g@rbr.test"])).statusCode).toBe(200);
  });

  it("repeated wrong codes trigger the durable throttle (429), and the valid code works once the window clears", async () => {
    const { code } = await approvedSetup();
    for (let i = 0; i < 5; i++) expect((await reset("cash@rbr.test", `AAAA-AAAA-AAAA-AAAA-AAAA-AAAA-AAAA-AAA${i}`)).statusCode).toBe(400);
    const blocked = await reset("cash@rbr.test", `AAAA-AAAA-AAAA-AAAA-AAAA-AAAA-AAAA-AAA9`);
    expect(blocked.statusCode).toBe(429);
    expect((await reset("cash@rbr.test", code)).statusCode).toBe(429); // even the right code is held during the delay
    await prisma.adminRecoveryAudit.updateMany({ data: { createdAt: new Date(Date.now() - 3 * 3600_000) } });
    expect((await reset("cash@rbr.test", code)).statusCode).toBe(200);
  });
});

// ── DB-level guarantees ────────────────────────────────────────────────
describe.skipIf(!enabled)("database constraints", () => {
  it("rejects a non-15-minute deadline, a code hash on a non-approved row, and a raw (non-hex) hash", async () => {
    const { c } = await pendingSetup();
    const now = new Date();
    const base = { userId: c.id, status: "REJECTED" as const };
    await expect(
      prisma.cashierRecoveryRequest.create({ data: { ...base, createdAt: now, expiresAt: new Date(now.getTime() + 20 * 60_000) } })
    ).rejects.toThrow();
    await expect(
      prisma.cashierRecoveryRequest.create({ data: { ...base, createdAt: now, expiresAt: new Date(now.getTime() + 15 * 60_000), codeHash: "a".repeat(64) } })
    ).rejects.toThrow();
    await expect(
      prisma.cashierRecoveryRequest.create({ data: { userId: c.id, status: "APPROVED", createdAt: now, expiresAt: new Date(now.getTime() + 15 * 60_000), codeHash: "ABCD-plaintext" } })
    ).rejects.toThrow();
  });
});

// ── audit ──────────────────────────────────────────────────────────────
describe.skipIf(!enabled)("audit logging", () => {
  it("records request → approval → failure → completion, and never a code, hash or password", async () => {
    const { admin, code } = await approvedSetup();
    await reset("cash@rbr.test", "AAAA-AAAA-AAAA-AAAA-AAAA-AAAA-AAAA-AAAA");
    await reset("cash@rbr.test", code);
    const rows = await prisma.auditLog.findMany({ where: { action: { in: ["CASHIER_RECOVERY_REQUESTED", "CASHIER_RECOVERY_APPROVED", "CASHIER_RECOVERY_FAILED", "CASHIER_RECOVERY_COMPLETED", "CASHIER_RECOVERY_REJECTED", "CASHIER_RECOVERY_THROTTLED", "CASHIER_RECOVERY_DENIED"] } }, orderBy: { createdAt: "asc" } });
    const actions = rows.map((r) => r.action);
    expect(actions).toEqual(
      expect.arrayContaining(["CASHIER_RECOVERY_REQUESTED", "CASHIER_RECOVERY_APPROVED", "CASHIER_RECOVERY_FAILED", "CASHIER_RECOVERY_COMPLETED"])
    );
    expect(rows.find((r) => r.action === "CASHIER_RECOVERY_APPROVED")?.actorId).toBe(admin.user.id);
    const blob = JSON.stringify(rows) + JSON.stringify(await prisma.adminRecoveryAudit.findMany());
    expect(blob).not.toContain(code);
    expect(blob).not.toContain(code.replace(/-/g, ""));
    expect(blob).not.toContain(NEW);
    const reqRow = await prisma.cashierRecoveryRequest.findFirstOrThrow();
    expect(blob).not.toContain(reqRow.codeHash ?? "zzzz-never");
  });
});
