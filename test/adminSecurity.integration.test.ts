/**
 * Integration tests for Admin Security Settings (Phase 2): recovery-code
 * management, passkey registration/removal, re-authentication, role
 * isolation and audit logging — through the real HTTP layer and a real
 * Postgres.
 *
 * NOT run as part of the default build. To run locally:
 *   1. Point DATABASE_URL (in .env.test) at a disposable LOCAL Postgres
 *      database whose name contains "test" (test/setup.ts refuses anything else).
 *   2. npx prisma migrate deploy   (applies 20261021000000_admin_security_settings)
 *   3. RUN_INTEGRATION_TESTS=1 npx vitest run test/adminSecurity.integration.test.ts
 *
 * Without RUN_INTEGRATION_TESTS this whole file is skipped.
 *
 * Passkey registration uses a software authenticator (test/helpers) that
 * emits real WebAuthn attestation data, so the server-side verification
 * exercised here is the production code path.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { prisma } from "../src/lib/prisma.js";
import { hashPassword } from "../src/lib/password.js";
import { signAccessToken, expiresInToDate } from "../src/lib/jwt.js";
import { env } from "../src/config/env.js";
import { consumeRecoveryCode } from "../src/lib/recoveryCodes.js";
import { RECOVERY_THROTTLE } from "../src/lib/recoveryThrottle.js";
import { resetDb } from "./dbReset.js";
import { createSoftRegistration } from "./helpers/softAuthenticator.js";

const enabled = !!process.env.RUN_INTEGRATION_TESTS;
const PASSWORD = "AdminPass123";
const RP_ID = env.WEBAUTHN_RP_ID ?? "localhost";
const ORIGIN = env.WEBAUTHN_ORIGINS_LIST[0] ?? "http://localhost:5173";

let app: FastifyInstance;
let shopId: string;

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
  const shop = await prisma.shop.create({ data: { name: "Test Shop", code: "TEST" } });
  shopId = shop.id;
});

async function createUser(role: "ADMIN" | "CASHIER", email: string) {
  return prisma.user.create({
    data: { name: role === "ADMIN" ? "Admin" : "Cashier", email, passwordHash: await hashPassword(PASSWORD), role, status: "ACTIVE", shopId },
  });
}

/** Real session row + real signed JWT, exactly as login would create them. */
async function tokenFor(user: { id: string; role: "ADMIN" | "CASHIER" }) {
  const { token, jti } = signAccessToken(user.id, user.role);
  await prisma.session.create({ data: { jti, userId: user.id, expiresAt: expiresInToDate(env.JWT_EXPIRES_IN) } });
  return token;
}

async function call(method: "GET" | "POST", url: string, token: string | null, payload?: unknown) {
  const res = await app.inject({
    method,
    url,
    payload: payload as never,
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  return { status: res.statusCode, body: res.payload ? JSON.parse(res.payload) : null, headers: res.headers };
}

const generateCodes = (token: string, currentPassword = PASSWORD) =>
  call("POST", "/api/admin/security/recovery-codes", token, { currentPassword });

async function registerPasskey(token: string, name?: string, opts: { credentialId?: Buffer } = {}) {
  const options = await call("POST", "/api/admin/security/passkeys/register/options", token, { currentPassword: PASSWORD });
  expect(options.status).toBe(200);
  const soft = createSoftRegistration({
    rpID: RP_ID,
    origin: ORIGIN,
    challenge: options.body.options.challenge,
    credentialId: opts.credentialId,
  });
  const verify = await call("POST", "/api/admin/security/passkeys/register/verify", token, {
    challengeId: options.body.challengeId,
    name,
    response: soft.response,
  });
  return { options, soft, verify };
}

describe.skipIf(!enabled)("Admin login remains functional", () => {
  it("POST /api/auth/admin/login still works and the token reaches the new endpoints", async () => {
    await createUser("ADMIN", "admin@example.com");
    const login = await call("POST", "/api/auth/admin/login", null, { email: "admin@example.com", password: PASSWORD });
    expect(login.status).toBe(200);
    const status = await call("GET", "/api/admin/security/status", login.body.token);
    expect(status.status).toBe(200);
  });
});

describe.skipIf(!enabled)("access control & role isolation", () => {
  it("rejects unauthenticated callers (401) on every route", async () => {
    const id = "00000000-0000-4000-8000-000000000000";
    expect((await call("GET", "/api/admin/security/status", null)).status).toBe(401);
    expect((await call("POST", "/api/admin/security/recovery-codes", null, { currentPassword: PASSWORD })).status).toBe(401);
    expect((await call("POST", "/api/admin/security/passkeys/register/options", null, { currentPassword: PASSWORD })).status).toBe(401);
    expect((await call("POST", "/api/admin/security/passkeys/register/verify", null, {})).status).toBe(401);
    expect((await call("POST", `/api/admin/security/passkeys/${id}/remove`, null, { currentPassword: PASSWORD })).status).toBe(401);
  });

  it("rejects a Cashier (403) on every route and never creates credentials for them", async () => {
    const cashier = await createUser("CASHIER", "cashier@example.com");
    const token = await tokenFor(cashier);
    const id = "00000000-0000-4000-8000-000000000000";
    for (const [method, url, body] of [
      ["GET", "/api/admin/security/status", undefined],
      ["POST", "/api/admin/security/recovery-codes", { currentPassword: PASSWORD }],
      ["POST", "/api/admin/security/passkeys/register/options", { currentPassword: PASSWORD }],
      ["POST", `/api/admin/security/passkeys/${id}/remove`, { currentPassword: PASSWORD }],
    ] as const) {
      const res = await call(method, url, token, body);
      expect(res.status, `${method} ${url}`).toBe(403);
      expect(res.body.code).toBe("ROLE_NOT_ALLOWED");
    }
    expect(await prisma.adminRecoveryCode.count({ where: { userId: cashier.id } })).toBe(0);
    expect(await prisma.adminPasskey.count({ where: { userId: cashier.id } })).toBe(0);
  });

  it("responses are marked Cache-Control: no-store", async () => {
    const admin = await createUser("ADMIN", "admin@example.com");
    const res = await call("GET", "/api/admin/security/status", await tokenFor(admin));
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  it("the new tables are locked down with row-level security", async () => {
    const rows = await prisma.$queryRaw<Array<{ relname: string; relrowsecurity: boolean }>>`
      SELECT relname::text AS relname, relrowsecurity FROM pg_class
      WHERE relname IN ('admin_passkeys','admin_passkey_challenges','admin_recovery_codes','admin_recovery_grants','admin_recovery_audit')`;
    expect(rows).toHaveLength(5);
    for (const r of rows) expect(r.relrowsecurity, r.relname).toBe(true);
  });
});

describe.skipIf(!enabled)("GET /api/admin/security/status", () => {
  it("reports no recovery method configured for a fresh Admin (drives the non-blocking warning)", async () => {
    const admin = await createUser("ADMIN", "admin@example.com");
    const res = await call("GET", "/api/admin/security/status", await tokenFor(admin));
    expect(res.status).toBe(200);
    expect(res.body.noRecoveryMethodConfigured).toBe(true);
    expect(res.body.recoveryCodes).toMatchObject({ configured: false, remaining: 0, total: 8, generatedAt: null });
    expect(res.body.passkeys.items).toEqual([]);
    expect(res.body.passkeys.available).toBe(true);
  });

  it("clears the warning with either method alone (both are optional)", async () => {
    const a = await createUser("ADMIN", "a@example.com");
    const b = await createUser("ADMIN", "b@example.com");
    const ta = await tokenFor(a);
    const tb = await tokenFor(b);
    await generateCodes(ta);
    await registerPasskey(tb);
    expect((await call("GET", "/api/admin/security/status", ta)).body.noRecoveryMethodConfigured).toBe(false);
    expect((await call("GET", "/api/admin/security/status", tb)).body.noRecoveryMethodConfigured).toBe(false);
  });
});

describe.skipIf(!enabled)("recovery codes — generation & regeneration", () => {
  it("generates eight distinct, well-formed codes; only keyed hashes are stored", async () => {
    const admin = await createUser("ADMIN", "admin@example.com");
    const res = await generateCodes(await tokenFor(admin));
    expect(res.status).toBe(200);
    expect(res.body.regenerated).toBe(false);
    expect(res.body.codes).toHaveLength(8);
    expect(new Set(res.body.codes).size).toBe(8);
    for (const code of res.body.codes) expect(code).toMatch(/^([0-9A-HJKMNP-TV-Z]{4}-){7}[0-9A-HJKMNP-TV-Z]{4}$/);

    const rows = await prisma.adminRecoveryCode.findMany({ where: { userId: admin.id } });
    expect(rows).toHaveLength(8);
    const dump = JSON.stringify(rows);
    for (const code of res.body.codes) {
      expect(dump).not.toContain(code);
      expect(dump).not.toContain(code.replace(/-/g, ""));
    }
    for (const r of rows) expect(r.codeHash).toMatch(/^[0-9a-f]{64}$/);

    const status = await call("GET", "/api/admin/security/status", await tokenFor(admin));
    expect(status.body.recoveryCodes).toMatchObject({ configured: true, remaining: 8 });
    expect(JSON.stringify(status.body)).not.toContain(res.body.codes[0]);
  });

  it("requires the current password: wrong → 403 and NOTHING is generated", async () => {
    const admin = await createUser("ADMIN", "admin@example.com");
    const res = await generateCodes(await tokenFor(admin), "WrongPass999");
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("INVALID_CURRENT_PASSWORD");
    expect(await prisma.adminRecoveryCode.count({ where: { userId: admin.id } })).toBe(0);
  });

  it("a missing password is a validation error, not a generation", async () => {
    const admin = await createUser("ADMIN", "admin@example.com");
    const res = await call("POST", "/api/admin/security/recovery-codes", await tokenFor(admin), {});
    expect(res.status).toBe(422);
    expect(await prisma.adminRecoveryCode.count({ where: { userId: admin.id } })).toBe(0);
  });

  it("regeneration invalidates the previous set and the new set works", async () => {
    const admin = await createUser("ADMIN", "admin@example.com");
    const token = await tokenFor(admin);
    const first = await generateCodes(token);
    const second = await generateCodes(token);
    expect(second.body.regenerated).toBe(true);

    for (const old of first.body.codes) expect(await consumeRecoveryCode(admin.id, old)).toBe(false);
    expect(await consumeRecoveryCode(admin.id, second.body.codes[0])).toBe(true);
    expect(await prisma.adminRecoveryCode.count({ where: { userId: admin.id, usedAt: null, revokedAt: null } })).toBe(7);
  });

  it("concurrent regenerations never leave more than one active set of eight", async () => {
    const admin = await createUser("ADMIN", "admin@example.com");
    const token = await tokenFor(admin);
    const results = await Promise.all(Array.from({ length: 5 }, () => generateCodes(token)));
    for (const r of results) expect(r.status).toBe(200);
    expect(await prisma.adminRecoveryCode.count({ where: { userId: admin.id, usedAt: null, revokedAt: null } })).toBe(8);
  });

  it("a code is single-use even under concurrent redemption (exactly one winner)", async () => {
    const admin = await createUser("ADMIN", "admin@example.com");
    const { body } = await generateCodes(await tokenFor(admin));
    const outcomes = await Promise.all(Array.from({ length: 12 }, () => consumeRecoveryCode(admin.id, body.codes[3])));
    expect(outcomes.filter(Boolean)).toHaveLength(1);
  });

  it("one Admin's codes never work for another Admin (cross-account)", async () => {
    const a = await createUser("ADMIN", "a@example.com");
    const b = await createUser("ADMIN", "b@example.com");
    const { body } = await generateCodes(await tokenFor(a));
    expect(await consumeRecoveryCode(b.id, body.codes[0])).toBe(false);
    expect(await consumeRecoveryCode(a.id, body.codes[0])).toBe(true);
  });
});

describe.skipIf(!enabled)("re-authentication throttle", () => {
  it("blocks further attempts after repeated wrong passwords — even the correct one — and is per account", async () => {
    const a = await createUser("ADMIN", "a@example.com");
    const other = await createUser("ADMIN", "other@example.com");
    const token = await tokenFor(a);

    for (let i = 0; i < RECOVERY_THROTTLE.account.freeFailures; i++) {
      expect((await generateCodes(token, "WrongPass999")).status).toBe(403);
    }
    const blocked = await generateCodes(token, PASSWORD);
    expect(blocked.status).toBe(429);
    expect(blocked.body.code).toBe("REAUTH_THROTTLED");
    expect(await prisma.adminRecoveryCode.count({ where: { userId: a.id } })).toBe(0);

    // Another Admin is unaffected.
    expect((await generateCodes(await tokenFor(other))).status).toBe(200);
  });
});

describe.skipIf(!enabled)("passkeys — registration", () => {
  it("registers a passkey end to end; only public data is stored and exposed", async () => {
    const admin = await createUser("ADMIN", "admin@example.com");
    const token = await tokenFor(admin);
    const { options, soft, verify } = await registerPasskey(token, "Shop laptop");

    expect(options.body.options.rp.id).toBe(RP_ID);
    expect(options.body.options.authenticatorSelection.userVerification).toBe("required");
    expect(options.body.options.attestation).toBe("none");

    expect(verify.status).toBe(200);
    expect(verify.body.passkey).toMatchObject({ name: "Shop laptop", deviceType: "singleDevice", backedUp: false });
    const exposed = JSON.stringify(verify.body);
    expect(exposed).not.toContain(soft.credentialId);
    expect(exposed).not.toContain("publicKey");

    const row = await prisma.adminPasskey.findFirstOrThrow({ where: { userId: admin.id } });
    expect(row.credentialId).toBe(soft.credentialId);
    expect(row.publicKey.length).toBeGreaterThan(0);
    expect(Number(row.counter)).toBe(0);

    const status = await call("GET", "/api/admin/security/status", token);
    expect(status.body.passkeys.items).toHaveLength(1);
    expect(JSON.stringify(status.body)).not.toContain(soft.credentialId);
  });

  it("allows multiple passkeys, and excludes existing ones from the next ceremony", async () => {
    const admin = await createUser("ADMIN", "admin@example.com");
    const token = await tokenFor(admin);
    const first = await registerPasskey(token, "One");
    expect(first.verify.status).toBe(200);
    const second = await registerPasskey(token, "Two");
    expect(second.verify.status).toBe(200);
    expect(second.options.body.options.excludeCredentials.map((c: { id: string }) => c.id)).toContain(first.soft.credentialId);
    expect(await prisma.adminPasskey.count({ where: { userId: admin.id } })).toBe(2);
    // One stable user handle per account.
    const handles = await prisma.adminPasskey.findMany({ where: { userId: admin.id }, select: { userHandle: true } });
    expect(new Set(handles.map((h) => h.userHandle)).size).toBe(1);
  });

  it("requires the current password to start registration (wrong → 403, no challenge issued)", async () => {
    const admin = await createUser("ADMIN", "admin@example.com");
    const res = await call("POST", "/api/admin/security/passkeys/register/options", await tokenFor(admin), { currentPassword: "WrongPass999" });
    expect(res.status).toBe(403);
    expect(await prisma.adminPasskeyChallenge.count({ where: { userId: admin.id } })).toBe(0);
  });

  it("rejects a response bound to a different challenge, and burns the issued challenge", async () => {
    const admin = await createUser("ADMIN", "admin@example.com");
    const token = await tokenFor(admin);
    const options = await call("POST", "/api/admin/security/passkeys/register/options", token, { currentPassword: PASSWORD });
    const bad = createSoftRegistration({ rpID: RP_ID, origin: ORIGIN, challenge: randomBytes(32).toString("base64url") });

    const res = await call("POST", "/api/admin/security/passkeys/register/verify", token, {
      challengeId: options.body.challengeId,
      response: bad.response,
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("PASSKEY_VERIFICATION_FAILED");
    expect(await prisma.adminPasskey.count({ where: { userId: admin.id } })).toBe(0);

    // The challenge is spent: even the CORRECT response can no longer use it.
    const good = createSoftRegistration({ rpID: RP_ID, origin: ORIGIN, challenge: options.body.options.challenge });
    const retry = await call("POST", "/api/admin/security/passkeys/register/verify", token, {
      challengeId: options.body.challengeId,
      response: good.response,
    });
    expect(retry.status).toBe(400);
    expect(retry.body.code).toBe("PASSKEY_CHALLENGE_INVALID");
  });

  it("a challenge is single-use: replaying a successful registration fails", async () => {
    const admin = await createUser("ADMIN", "admin@example.com");
    const token = await tokenFor(admin);
    const options = await call("POST", "/api/admin/security/passkeys/register/options", token, { currentPassword: PASSWORD });
    const soft = createSoftRegistration({ rpID: RP_ID, origin: ORIGIN, challenge: options.body.options.challenge });
    const body = { challengeId: options.body.challengeId, response: soft.response };

    expect((await call("POST", "/api/admin/security/passkeys/register/verify", token, body)).status).toBe(200);
    const replay = await call("POST", "/api/admin/security/passkeys/register/verify", token, body);
    expect(replay.status).toBe(400);
    expect(await prisma.adminPasskey.count({ where: { userId: admin.id } })).toBe(1);
  });

  it("concurrent verification of one challenge registers at most once", async () => {
    const admin = await createUser("ADMIN", "admin@example.com");
    const token = await tokenFor(admin);
    const options = await call("POST", "/api/admin/security/passkeys/register/options", token, { currentPassword: PASSWORD });
    const soft = createSoftRegistration({ rpID: RP_ID, origin: ORIGIN, challenge: options.body.options.challenge });
    const body = { challengeId: options.body.challengeId, response: soft.response };
    const results = await Promise.all(Array.from({ length: 6 }, () => call("POST", "/api/admin/security/passkeys/register/verify", token, body)));
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(await prisma.adminPasskey.count({ where: { userId: admin.id } })).toBe(1);
  });

  it("rejects a challenge issued to a DIFFERENT Admin (no cross-account registration)", async () => {
    const a = await createUser("ADMIN", "a@example.com");
    const b = await createUser("ADMIN", "b@example.com");
    const ta = await tokenFor(a);
    const tb = await tokenFor(b);
    const options = await call("POST", "/api/admin/security/passkeys/register/options", ta, { currentPassword: PASSWORD });
    const soft = createSoftRegistration({ rpID: RP_ID, origin: ORIGIN, challenge: options.body.options.challenge });

    const res = await call("POST", "/api/admin/security/passkeys/register/verify", tb, {
      challengeId: options.body.challengeId,
      response: soft.response,
    });
    expect(res.status).toBe(400);
    expect(await prisma.adminPasskey.count()).toBe(0);
    // And it did not burn A's challenge.
    expect((await call("POST", "/api/admin/security/passkeys/register/verify", ta, { challengeId: options.body.challengeId, response: soft.response })).status).toBe(200);
  });

  it("rejects an expired challenge", async () => {
    const admin = await createUser("ADMIN", "admin@example.com");
    const token = await tokenFor(admin);
    const options = await call("POST", "/api/admin/security/passkeys/register/options", token, { currentPassword: PASSWORD });
    await prisma.adminPasskeyChallenge.update({ where: { id: options.body.challengeId }, data: { createdAt: new Date(Date.now() - 60_000), expiresAt: new Date(Date.now() - 1000) } });
    const soft = createSoftRegistration({ rpID: RP_ID, origin: ORIGIN, challenge: options.body.options.challenge });
    const res = await call("POST", "/api/admin/security/passkeys/register/verify", token, { challengeId: options.body.challengeId, response: soft.response });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("PASSKEY_CHALLENGE_INVALID");
  });

  it("starting a new ceremony retires the earlier unfinished one", async () => {
    const admin = await createUser("ADMIN", "admin@example.com");
    const token = await tokenFor(admin);
    const first = await call("POST", "/api/admin/security/passkeys/register/options", token, { currentPassword: PASSWORD });
    await call("POST", "/api/admin/security/passkeys/register/options", token, { currentPassword: PASSWORD });
    const soft = createSoftRegistration({ rpID: RP_ID, origin: ORIGIN, challenge: first.body.options.challenge });
    const res = await call("POST", "/api/admin/security/passkeys/register/verify", token, { challengeId: first.body.challengeId, response: soft.response });
    expect(res.status).toBe(400);
  });

  it("the same authenticator credential cannot be registered twice, nor under another account", async () => {
    const a = await createUser("ADMIN", "a@example.com");
    const b = await createUser("ADMIN", "b@example.com");
    const credentialId = randomBytes(32);
    expect((await registerPasskey(await tokenFor(a), "A", { credentialId })).verify.status).toBe(200);
    const dupe = await registerPasskey(await tokenFor(b), "B", { credentialId });
    expect(dupe.verify.status).toBe(409);
    expect(dupe.verify.body.code).toBe("PASSKEY_ALREADY_REGISTERED");
    expect(await prisma.adminPasskey.count({ where: { userId: b.id } })).toBe(0);
  });

  it("enforces the per-account passkey limit", async () => {
    const admin = await createUser("ADMIN", "admin@example.com");
    const token = await tokenFor(admin);
    for (let i = 0; i < 10; i++) expect((await registerPasskey(token, `Key ${i}`)).verify.status).toBe(200);
    const over = await call("POST", "/api/admin/security/passkeys/register/options", token, { currentPassword: PASSWORD });
    expect(over.status).toBe(409);
    expect(over.body.code).toBe("PASSKEY_LIMIT_REACHED");
  });

  it("fails closed with 503 when passkeys are not configured", async () => {
    const admin = await createUser("ADMIN", "admin@example.com");
    const token = await tokenFor(admin);
    const saved = env.WEBAUTHN_RP_ID;
    env.WEBAUTHN_RP_ID = undefined;
    try {
      const res = await call("POST", "/api/admin/security/passkeys/register/options", token, { currentPassword: PASSWORD });
      expect(res.status).toBe(503);
      expect(res.body.code).toBe("PASSKEYS_NOT_CONFIGURED");
      expect((await call("GET", "/api/admin/security/status", token)).body.passkeys.available).toBe(false);
    } finally {
      env.WEBAUTHN_RP_ID = saved;
    }
  });
});

describe.skipIf(!enabled)("passkeys — removal", () => {
  it("requires the current password; then removes only that passkey", async () => {
    const admin = await createUser("ADMIN", "admin@example.com");
    const token = await tokenFor(admin);
    const one = await registerPasskey(token, "One");
    await registerPasskey(token, "Two");
    const id = one.verify.body.passkey.id;

    const wrong = await call("POST", `/api/admin/security/passkeys/${id}/remove`, token, { currentPassword: "WrongPass999" });
    expect(wrong.status).toBe(403);
    expect(await prisma.adminPasskey.count({ where: { userId: admin.id } })).toBe(2);

    const ok = await call("POST", `/api/admin/security/passkeys/${id}/remove`, token, { currentPassword: PASSWORD });
    expect(ok.status).toBe(200);
    const left = await prisma.adminPasskey.findMany({ where: { userId: admin.id } });
    expect(left).toHaveLength(1);
    expect(left[0].name).toBe("Two");
  });

  it("cannot remove another Admin's passkey (404, and it survives)", async () => {
    const a = await createUser("ADMIN", "a@example.com");
    const b = await createUser("ADMIN", "b@example.com");
    const theirs = await registerPasskey(await tokenFor(a), "A's key");
    const res = await call("POST", `/api/admin/security/passkeys/${theirs.verify.body.passkey.id}/remove`, await tokenFor(b), { currentPassword: PASSWORD });
    expect(res.status).toBe(404);
    expect(await prisma.adminPasskey.count({ where: { userId: a.id } })).toBe(1);
  });

  it("removing a nonexistent passkey is a 404; a malformed id is a validation error", async () => {
    const admin = await createUser("ADMIN", "admin@example.com");
    const token = await tokenFor(admin);
    expect((await call("POST", "/api/admin/security/passkeys/00000000-0000-4000-8000-000000000000/remove", token, { currentPassword: PASSWORD })).status).toBe(404);
    expect((await call("POST", "/api/admin/security/passkeys/not-a-uuid/remove", token, { currentPassword: PASSWORD })).status).toBe(422);
  });
});

describe.skipIf(!enabled)("recovery audit logging", () => {
  it("records generate, regenerate, register, remove and failed re-auth — with no secrets", async () => {
    const admin = await createUser("ADMIN", "admin@example.com");
    const token = await tokenFor(admin);

    const first = await generateCodes(token);
    await generateCodes(token);
    await generateCodes(token, "WrongPass999");
    const pk = await registerPasskey(token, "Key");
    await call("POST", `/api/admin/security/passkeys/${pk.verify.body.passkey.id}/remove`, token, { currentPassword: PASSWORD });

    const rows = await prisma.adminRecoveryAudit.findMany({ where: { userId: admin.id }, orderBy: { createdAt: "asc" } });
    const events = rows.map((r) => r.event);
    expect(events).toEqual(
      expect.arrayContaining(["CODES_GENERATED", "CODES_REGENERATED", "REAUTH_FAILED", "PASSKEY_REGISTERED", "PASSKEY_REMOVED"])
    );
    const dump = JSON.stringify(rows);
    expect(dump).not.toContain(PASSWORD);
    expect(dump).not.toContain("WrongPass999");
    for (const code of first.body.codes) expect(dump).not.toContain(code);
    expect(dump).not.toContain(pk.soft.credentialId);
  });
});
