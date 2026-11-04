/**
 * Integration tests for Admin Forgot Password (Phase 3): recovery-code and
 * passkey verification, recovery grants, the password update, session
 * revocation, throttling, anti-enumeration, replay/concurrency protection,
 * role isolation and audit logging — through the real HTTP layer and a real
 * Postgres.
 *
 * NOT run as part of the default build. To run locally:
 *   1. Point DATABASE_URL (in .env.test) at a disposable LOCAL Postgres
 *      database whose name contains "test" (test/setup.ts refuses anything else).
 *   2. npx prisma migrate deploy   (applies 20261022000000_admin_recovery_flow)
 *   3. RUN_INTEGRATION_TESTS=1 npx vitest run test/adminRecoveryFlow.integration.test.ts
 *
 * Without RUN_INTEGRATION_TESTS this whole file is skipped.
 *
 * Passkey ceremonies use the software authenticator in test/helpers, which
 * produces real WebAuthn attestation/assertion data, so the server-side
 * verification exercised here is the production code path.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash, generateKeyPairSync } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { prisma } from "../src/lib/prisma.js";
import { hashPassword, verifyPassword } from "../src/lib/password.js";
import { signAccessToken, expiresInToDate } from "../src/lib/jwt.js";
import { env } from "../src/config/env.js";
import { generateRecoveryCodeSet } from "../src/lib/recoveryCodes.js";
import { hashRecoveryCode, normalizeRecoveryCode, hashRecoverySubject } from "../src/lib/recoveryCrypto.js";
import { RECOVERY_THROTTLE } from "../src/lib/recoveryThrottle.js";
import { resetDb } from "./dbReset.js";
import { createSoftAssertion, createSoftRegistration } from "./helpers/softAuthenticator.js";

const enabled = !!process.env.RUN_INTEGRATION_TESTS;
const PASSWORD = "AdminPass123";
const NEW_PASSWORD = "BrandNew456";
const API = "/api/auth/admin/recovery";
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

// ── helpers ─────────────────────────────────────────────────────────────

async function createUser(
  role: "ADMIN" | "CASHIER",
  email: string,
  status: "ACTIVE" | "SUSPENDED" = "ACTIVE"
) {
  return prisma.user.create({
    data: { name: role === "ADMIN" ? "Admin" : "Cashier", email, passwordHash: await hashPassword(PASSWORD), role, status, shopId },
  });
}

async function tokenFor(user: { id: string; role: "ADMIN" | "CASHIER" }) {
  const { token, jti } = signAccessToken(user.id, user.role);
  await prisma.session.create({ data: { jti, userId: user.id, expiresAt: expiresInToDate(env.JWT_EXPIRES_IN) } });
  return token;
}

async function post(url: string, payload: unknown, headers: Record<string, string> = {}) {
  const res = await app.inject({ method: "POST", url, payload: payload as never, headers });
  return { status: res.statusCode, body: res.payload ? JSON.parse(res.payload) : null, headers: res.headers };
}

const verifyCode = (email: string, code: string, headers?: Record<string, string>) =>
  post(`${API}/code/verify`, { email, code }, headers);
const reset = (grantToken: string, newPassword = NEW_PASSWORD, headers?: Record<string, string>, extra: object = {}) =>
  post(`${API}/reset-password`, { grantToken, newPassword, ...extra }, headers);

async function adminWithCodes(email: string) {
  const admin = await createUser("ADMIN", email);
  const { codes } = await generateRecoveryCodeSet(admin.id);
  return { admin, codes };
}

/** Recovery-code verification that must succeed → the grant token. */
async function grantViaCode(email: string, code: string, headers?: Record<string, string>) {
  const res = await verifyCode(email, code, headers);
  expect(res.status).toBe(200);
  return res.body.grantToken as string;
}

async function canLogin(email: string, password: string) {
  const res = await post("/api/auth/admin/login", { email, password });
  return res.status === 200;
}

/** Registers a passkey through the real Phase 2 routes. Returns what the "authenticator" holds. */
async function enrolPasskey(admin: { id: string; role: "ADMIN" | "CASHIER" }) {
  const token = await tokenFor(admin);
  const headers = { authorization: `Bearer ${token}` };
  const options = await post("/api/admin/security/passkeys/register/options", { currentPassword: PASSWORD }, headers);
  expect(options.status).toBe(200);
  const soft = createSoftRegistration({ rpID: RP_ID, origin: ORIGIN, challenge: options.body.options.challenge });
  const verify = await post(
    "/api/admin/security/passkeys/register/verify",
    { challengeId: options.body.challengeId, response: soft.response },
    headers
  );
  expect(verify.status).toBe(200);
  const row = await prisma.adminPasskey.findFirstOrThrow({ where: { credentialId: soft.credentialId } });
  return { soft, userHandle: row.userHandle, passkeyId: row.id };
}

type Enrolled = Awaited<ReturnType<typeof enrolPasskey>>;

async function passkeyOptions(email: string, headers?: Record<string, string>) {
  return post(`${API}/passkey/options`, { email }, headers);
}

function assertionFor(enrolled: Enrolled, challenge: string, over: Record<string, unknown> = {}) {
  return createSoftAssertion({
    rpID: RP_ID,
    origin: ORIGIN,
    challenge,
    credentialId: enrolled.soft.credentialId,
    privateKey: enrolled.soft.privateKey,
    userHandle: enrolled.userHandle,
    ...over,
  } as never);
}

/** Full passkey recovery attempt. `over` tweaks the assertion; `verifyEmail`/`headers` tweak the verify call. */
async function passkeyRecover(
  email: string,
  enrolled: Enrolled,
  opts: { over?: Record<string, unknown>; verifyEmail?: string; headers?: Record<string, string> } = {}
) {
  const options = await passkeyOptions(email, opts.headers);
  expect(options.status).toBe(200);
  const response = assertionFor(enrolled, options.body.options.challenge, opts.over);
  return post(
    `${API}/passkey/verify`,
    { email: opts.verifyEmail ?? email, challengeId: options.body.challengeId, response },
    opts.headers
  );
}

const GENERIC_FAILURE = { status: 400, code: "RECOVERY_VERIFICATION_FAILED" };

// ═════════════════════════════════════════════════════════════════════════

describe.skipIf(!enabled)("recovery code → grant → new password (happy path)", () => {
  it("verifies a code, issues a grant, resets the password, and the new password logs in", async () => {
    const { admin, codes } = await adminWithCodes("admin@example.com");

    const verified = await verifyCode("admin@example.com", codes[0]);
    expect(verified.status).toBe(200);
    expect(typeof verified.body.grantToken).toBe("string");
    expect(verified.body.grantToken).toHaveLength(43);
    expect(new Date(verified.body.expiresAt).getTime()).toBeGreaterThan(Date.now());
    expect(verified.headers["cache-control"]).toBe("no-store");

    // The grant is stored hashed only.
    const stored = await prisma.adminRecoveryGrant.findFirstOrThrow({ where: { userId: admin.id } });
    expect(stored.tokenHash).toBe(createHash("sha256").update(verified.body.grantToken).digest("hex"));
    expect(JSON.stringify(stored)).not.toContain(verified.body.grantToken);

    const done = await reset(verified.body.grantToken);
    expect(done.status).toBe(200);
    expect(done.body.success).toBe(true);

    expect(await canLogin("admin@example.com", NEW_PASSWORD)).toBe(true);
    expect(await canLogin("admin@example.com", PASSWORD)).toBe(false);
  });

  it("accepts a recovery code typed loosely (lower-case, spaces)", async () => {
    const { codes } = await adminWithCodes("admin@example.com");
    const sloppy = codes[2].toLowerCase().replace(/-/g, " ");
    expect((await verifyCode("admin@example.com", sloppy)).status).toBe(200);
  });

  it("consumes the code on verification: it cannot be used again, and the other 7 still work", async () => {
    const { admin, codes } = await adminWithCodes("admin@example.com");
    await grantViaCode("admin@example.com", codes[0]);

    const replay = await verifyCode("admin@example.com", codes[0]);
    expect({ status: replay.status, code: replay.body.code }).toEqual(GENERIC_FAILURE);

    const remaining = await prisma.adminRecoveryCode.count({ where: { userId: admin.id, usedAt: null, revokedAt: null } });
    expect(remaining).toBe(7);
    expect((await verifyCode("admin@example.com", codes[1])).status).toBe(200);
  });

  it("regenerating the codes invalidates the old set and the new set works", async () => {
    const { admin, codes: oldCodes } = await adminWithCodes("admin@example.com");
    const { codes: newCodes } = await generateRecoveryCodeSet(admin.id);

    const old = await verifyCode("admin@example.com", oldCodes[0]);
    expect({ status: old.status, code: old.body.code }).toEqual(GENERIC_FAILURE);
    expect((await verifyCode("admin@example.com", newCodes[0])).status).toBe(200);
  });

  it("never stores or exposes the raw code, grant token or new password in any audit row", async () => {
    const { codes } = await adminWithCodes("admin@example.com");
    const grant = await grantViaCode("admin@example.com", codes[0]);
    await reset(grant);

    const everything = JSON.stringify([
      await prisma.adminRecoveryAudit.findMany(),
      await prisma.auditLog.findMany(),
      await prisma.adminRecoveryCode.findMany(),
    ]);
    expect(everything).not.toContain(codes[0]);
    expect(everything).not.toContain(normalizeRecoveryCode(codes[0])!);
    expect(everything).not.toContain(grant);
    expect(everything).not.toContain(NEW_PASSWORD);
    expect(everything).not.toContain("admin@example.com"); // only the keyed subject hash is kept in the recovery ledger
  });
});

describe.skipIf(!enabled)("anti-enumeration and 'no recovery method configured'", () => {
  it("answers identically for a wrong code, unknown email, Cashier email, suspended Admin and Admin with no methods", async () => {
    const { codes } = await adminWithCodes("real@example.com");
    await createUser("CASHIER", "cashier@example.com");
    await createUser("ADMIN", "suspended@example.com", "SUSPENDED");
    await createUser("ADMIN", "nomethods@example.com");

    const attempts = [
      await verifyCode("real@example.com", "AAAA-AAAA-AAAA-AAAA-AAAA-AAAA-AAAA-AAAA"), // wrong code, real admin
      await verifyCode("nobody@example.com", codes[0]), // unknown email, valid-looking code
      await verifyCode("cashier@example.com", codes[0]), // cashier email
      await verifyCode("suspended@example.com", codes[0]), // suspended admin
      await verifyCode("nomethods@example.com", codes[0]), // admin with nothing configured
      await verifyCode("real@example.com", "not-a-code"), // malformed
    ];
    for (const a of attempts) {
      expect({ status: a.status, code: a.body.code, message: a.body.message }).toEqual({
        ...GENERIC_FAILURE,
        message: attempts[0].body.message,
      });
    }
  });

  it("an Admin with NO recovery method cannot be reset by any route, and no grant is ever issued", async () => {
    const admin = await createUser("ADMIN", "nomethods@example.com");

    expect((await verifyCode("nomethods@example.com", "7K3M-7K3M-7K3M-7K3M-7K3M-7K3M-7K3M-7K3M")).status).toBe(400);
    const options = await passkeyOptions("nomethods@example.com");
    expect(options.status).toBe(200); // same as any email — nothing to learn from it
    const stranger = createSoftRegistration({ rpID: RP_ID, origin: ORIGIN, challenge: options.body.options.challenge });
    const res = await post(`${API}/passkey/verify`, {
      email: "nomethods@example.com",
      challengeId: options.body.challengeId,
      response: createSoftAssertion({
        rpID: RP_ID, origin: ORIGIN, challenge: options.body.options.challenge,
        credentialId: stranger.credentialId, privateKey: stranger.privateKey,
      }),
    });
    expect({ status: res.status, code: res.body.code }).toEqual(GENERIC_FAILURE);

    // The old emailed-link route can't be used as a back door either.
    const forgot = await post("/api/auth/forgot-password", { email: "nomethods@example.com" });
    expect(forgot.status).toBe(200);
    expect(await prisma.adminRecoveryGrant.count({ where: { userId: admin.id } })).toBe(0);
    expect(await canLogin("nomethods@example.com", PASSWORD)).toBe(true);
  });

  it("passkey options are identical in shape for a real Admin with a passkey and for an unknown email", async () => {
    const admin = await createUser("ADMIN", "admin@example.com");
    await enrolPasskey(admin);

    const real = await passkeyOptions("admin@example.com");
    const unknown = await passkeyOptions("nobody@example.com");
    expect(real.status).toBe(200);
    expect(unknown.status).toBe(200);
    const shape = (o: { body: { options: Record<string, unknown> } & Record<string, unknown> }) => ({
      keys: Object.keys(o.body).sort(),
      optionKeys: Object.keys(o.body.options).sort(),
      rpId: o.body.options.rpId,
      uv: o.body.options.userVerification,
      allow: (o.body.options.allowCredentials as unknown) ?? null,
    });
    expect(shape(real)).toEqual(shape(unknown));
    expect(shape(real).allow).toBeNull(); // no credential IDs are ever listed
    expect(shape(real).uv).toBe("required");
  });

  it("the challenge table never holds the raw email", async () => {
    await passkeyOptions("nobody@example.com");
    const rows = await prisma.adminRecoveryChallenge.findMany();
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain("nobody@example.com");
    expect(rows[0].subjectHash).toBe(hashRecoverySubject("nobody@example.com"));
  });
});

describe.skipIf(!enabled)("recovery codes — replay, concurrency, cross-account, role isolation", () => {
  // 5 parallel attempts => at most 4 failures, so the throttle (free allowance: 5) can never block the winner.
  it("concurrent redemption of ONE code yields exactly one grant", async () => {
    const { admin, codes } = await adminWithCodes("admin@example.com");
    const results = await Promise.all(Array.from({ length: 5 }, () => verifyCode("admin@example.com", codes[0])));
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status !== 200).every((r) => r.body.code === "RECOVERY_VERIFICATION_FAILED" || r.body.code === "RECOVERY_THROTTLED")).toBe(true);
    expect(await prisma.adminRecoveryGrant.count({ where: { userId: admin.id } })).toBe(1);
  });

  it("another Admin's valid code never works for this Admin's email (cross-account), and stays unused", async () => {
    await adminWithCodes("alice@example.com");
    const bob = await adminWithCodes("bob@example.com");

    const res = await verifyCode("alice@example.com", bob.codes[0]);
    expect({ status: res.status, code: res.body.code }).toEqual(GENERIC_FAILURE);
    expect((await verifyCode("bob@example.com", bob.codes[0])).status).toBe(200); // still Bob's
  });

  it("a Cashier can never be recovered, even if a code row somehow exists for them", async () => {
    const cashier = await createUser("CASHIER", "cashier@example.com");
    const raw = "7K3M-7K3M-7K3M-7K3M-7K3M-7K3M-7K3M-7K3M";
    await prisma.adminRecoveryCode.create({
      data: { userId: cashier.id, setId: "s1", codeHash: hashRecoveryCode(cashier.id, normalizeRecoveryCode(raw)!) },
    });

    const res = await verifyCode("cashier@example.com", raw);
    expect({ status: res.status, code: res.body.code }).toEqual(GENERIC_FAILURE);
    expect(await prisma.adminRecoveryGrant.count({ where: { userId: cashier.id } })).toBe(0);
    const unchanged = await prisma.user.findUniqueOrThrow({ where: { id: cashier.id } });
    expect(await verifyPassword(PASSWORD, unchanged.passwordHash)).toBe(true);
  });

  it("a grant is refused at redemption if the Admin was suspended after it was issued", async () => {
    const { admin, codes } = await adminWithCodes("admin@example.com");
    const grant = await grantViaCode("admin@example.com", codes[0]);
    await prisma.user.update({ where: { id: admin.id }, data: { status: "SUSPENDED" } });

    const res = await reset(grant);
    expect({ status: res.status, code: res.body.code }).toEqual({ status: 400, code: "RECOVERY_GRANT_INVALID" });
    const unchanged = await prisma.user.findUniqueOrThrow({ where: { id: admin.id } });
    expect(await verifyPassword(PASSWORD, unchanged.passwordHash)).toBe(true);
  });
});

describe.skipIf(!enabled)("throttling", () => {
  it("blocks an account after repeated wrong codes — even for the CORRECT code — with 429", async () => {
    const { codes } = await adminWithCodes("admin@example.com");
    for (let i = 0; i < RECOVERY_THROTTLE.account.freeFailures; i++) {
      expect((await verifyCode("admin@example.com", "AAAA-AAAA-AAAA-AAAA-AAAA-AAAA-AAAA-AAAA")).status).toBe(400);
    }
    const blocked = await verifyCode("admin@example.com", codes[0]);
    expect(blocked.status).toBe(429);
    expect(blocked.body.code).toBe("RECOVERY_THROTTLED");

    const logged = await prisma.adminRecoveryAudit.count({ where: { event: "ATTEMPT_THROTTLED" } });
    expect(logged).toBe(1);
  });

  it("throttles an UNKNOWN email exactly like a real one (no enumeration signal)", async () => {
    const outcomes: number[] = [];
    for (let i = 0; i < RECOVERY_THROTTLE.account.freeFailures + 1; i++) {
      outcomes.push((await verifyCode("nobody@example.com", "AAAA-AAAA-AAAA-AAAA-AAAA-AAAA-AAAA-AAAA")).status);
    }
    expect(outcomes).toEqual([400, 400, 400, 400, 400, 429]);
  });

  it("passkey and code failures share ONE per-account budget", async () => {
    const admin = await createUser("ADMIN", "admin@example.com");
    await generateRecoveryCodeSet(admin.id);
    const enrolled = await enrolPasskey(admin);

    for (let i = 0; i < 3; i++) await verifyCode("admin@example.com", "AAAA-AAAA-AAAA-AAAA-AAAA-AAAA-AAAA-AAAA");
    const forged = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey;
    for (let i = 0; i < 2; i++) await passkeyRecover("admin@example.com", enrolled, { over: { signWith: forged } });

    // 3 code + 2 passkey failures = the 5 free attempts. Options are unthrottled
    // by design (they reveal nothing); the VERIFY is what must be refused.
    const next = await passkeyRecover("admin@example.com", enrolled);
    expect({ status: next.status, code: next.body.code }).toEqual({ status: 429, code: "RECOVERY_THROTTLED" });
  });

  it("a different account is unaffected by another account's throttle", async () => {
    await adminWithCodes("alice@example.com");
    const bob = await adminWithCodes("bob@example.com");
    for (let i = 0; i < RECOVERY_THROTTLE.account.freeFailures; i++) {
      await verifyCode("alice@example.com", "AAAA-AAAA-AAAA-AAAA-AAAA-AAAA-AAAA-AAAA");
    }
    expect((await verifyCode("bob@example.com", bob.codes[0])).status).toBe(200);
  });
});

describe.skipIf(!enabled)("password update — grant rules", () => {
  it("a grant is single-use: a replay fails and the first password stands", async () => {
    const { admin, codes } = await adminWithCodes("admin@example.com");
    const grant = await grantViaCode("admin@example.com", codes[0]);

    expect((await reset(grant, NEW_PASSWORD)).status).toBe(200);
    const replay = await reset(grant, "Hacked999");
    expect({ status: replay.status, code: replay.body.code }).toEqual({ status: 400, code: "RECOVERY_GRANT_INVALID" });

    const row = await prisma.user.findUniqueOrThrow({ where: { id: admin.id } });
    expect(await verifyPassword(NEW_PASSWORD, row.passwordHash)).toBe(true);
    expect(await verifyPassword("Hacked999", row.passwordHash)).toBe(false);
  });

  it("concurrent redemption of ONE grant changes the password exactly once", async () => {
    const { admin, codes } = await adminWithCodes("admin@example.com");
    const grant = await grantViaCode("admin@example.com", codes[0]);

    const attempts = ["Winner111a", "Winner222b", "Winner333c", "Winner444d", "Winner555e", "Winner666f"];
    const results = await Promise.all(attempts.map((p) => reset(grant, p)));
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);

    const row = await prisma.user.findUniqueOrThrow({ where: { id: admin.id } });
    const winners = [];
    for (const p of attempts) if (await verifyPassword(p, row.passwordHash)) winners.push(p);
    expect(winners).toHaveLength(1);
    expect(await prisma.adminRecoveryAudit.count({ where: { event: "PASSWORD_RECOVERED" } })).toBe(1);
  });

  it("enforces the existing password policy WITHOUT burning the grant", async () => {
    const { codes } = await adminWithCodes("admin@example.com");
    const grant = await grantViaCode("admin@example.com", codes[0]);

    for (const weak of ["short1", "alllettersnodigit", "12345678901"]) {
      const res = await reset(grant, weak);
      expect(res.status).toBe(422);
    }
    expect((await reset(grant, NEW_PASSWORD)).status).toBe(200); // same grant still good
  });

  it("rejects an expired grant", async () => {
    const { codes } = await adminWithCodes("admin@example.com");
    const grant = await grantViaCode("admin@example.com", codes[0]);
    await prisma.adminRecoveryGrant.updateMany({ data: { createdAt: new Date(Date.now() - 60_000), expiresAt: new Date(Date.now() - 1000) } });

    const res = await reset(grant);
    expect({ status: res.status, code: res.body.code }).toEqual({ status: 400, code: "RECOVERY_GRANT_INVALID" });
    expect(await canLogin("admin@example.com", PASSWORD)).toBe(true);
  });

  it("rejects a grant presented by a different client (User-Agent) WITHOUT burning it — recovery-session hijack", async () => {
    const { codes } = await adminWithCodes("admin@example.com");
    const grant = await grantViaCode("admin@example.com", codes[0], { "user-agent": "Admin-Browser/1.0" });

    const thief = await reset(grant, "Stolen999x", { "user-agent": "Attacker/9.9" });
    expect({ status: thief.status, code: thief.body.code }).toEqual({ status: 400, code: "RECOVERY_GRANT_INVALID" });
    expect(await canLogin("admin@example.com", "Stolen999x")).toBe(false);

    expect((await reset(grant, NEW_PASSWORD, { "user-agent": "Admin-Browser/1.0" })).status).toBe(200);
  });

  it("rejects malformed, random and missing grants", async () => {
    await adminWithCodes("admin@example.com");
    for (const bad of ["x", "A".repeat(43), "not a token", "../../etc/passwd"]) {
      const res = await reset(bad);
      expect({ status: res.status, code: res.body.code }).toEqual({ status: 400, code: "RECOVERY_GRANT_INVALID" });
    }
    expect((await post(`${API}/reset-password`, { newPassword: NEW_PASSWORD })).status).toBe(422);
  });

  it("the account is ALWAYS the grant's: an email/userId in the body can't redirect the reset (cross-account)", async () => {
    const alice = await adminWithCodes("alice@example.com");
    const bob = await createUser("ADMIN", "bob@example.com");
    const grant = await grantViaCode("alice@example.com", alice.codes[0]);

    const res = await reset(grant, NEW_PASSWORD, {}, { email: "bob@example.com", userId: bob.id });
    expect(res.status).toBe(200);

    expect(await canLogin("alice@example.com", NEW_PASSWORD)).toBe(true);
    const bobRow = await prisma.user.findUniqueOrThrow({ where: { id: bob.id } });
    expect(await verifyPassword(PASSWORD, bobRow.passwordHash)).toBe(true);
  });

  it("a successful reset invalidates every OTHER outstanding grant for the account", async () => {
    const { codes } = await adminWithCodes("admin@example.com");
    const first = await grantViaCode("admin@example.com", codes[0]);
    const second = await grantViaCode("admin@example.com", codes[1]);

    expect((await reset(first)).status).toBe(200);
    const res = await reset(second, "Another789z");
    expect({ status: res.status, code: res.body.code }).toEqual({ status: 400, code: "RECOVERY_GRANT_INVALID" });
  });
});

describe.skipIf(!enabled)("sessions after recovery", () => {
  it("revokes the Admin's existing sessions — an already-issued token dies immediately — and nobody else's", async () => {
    const { admin, codes } = await adminWithCodes("admin@example.com");
    const other = await createUser("ADMIN", "other@example.com");
    const oldToken = await tokenFor(admin);
    const otherToken = await tokenFor(other);
    const me = (t: string) => app.inject({ method: "GET", url: "/api/auth/me", headers: { authorization: `Bearer ${t}` } });

    expect((await me(oldToken)).statusCode).toBe(200);
    const grant = await grantViaCode("admin@example.com", codes[0]);
    expect((await me(oldToken)).statusCode).toBe(200); // verifying alone changes nothing yet
    expect((await reset(grant)).status).toBe(200);

    expect((await me(oldToken)).statusCode).toBe(401); // JWT is still unexpired, but its session is revoked
    expect((await me(otherToken)).statusCode).toBe(200);
    expect(await prisma.session.count({ where: { userId: admin.id, revokedAt: null } })).toBe(0);
  });

  it("also kills old protected-route access (security settings), not just /auth/me", async () => {
    const { admin, codes } = await adminWithCodes("admin@example.com");
    const oldToken = await tokenFor(admin);
    const grant = await grantViaCode("admin@example.com", codes[0]);
    await reset(grant);

    const res = await app.inject({ method: "GET", url: "/api/admin/security/status", headers: { authorization: `Bearer ${oldToken}` } });
    expect(res.statusCode).toBe(401);
  });

  it("an emailed reset token (old flow) can no longer be used against an Admin", async () => {
    const admin = await createUser("ADMIN", "admin@example.com");
    // The token lib was removed with the cashier email-reset flow; mint an equivalent
    // legacy token inline (same secret/shape) to prove such links are now dead for everyone.
    const jwt = (await import("jsonwebtoken")).default;
    const { env } = await import("../src/config/env.js");
    const token = jwt.sign({ userId: admin.id, purpose: "PASSWORD_RESET", pwFingerprint: "x" }, env.JWT_SECRET, { expiresIn: "5m" });
    const res = await post("/api/auth/reset-password", { token, password: NEW_PASSWORD });
    expect(res.status).toBe(403);
    expect(await canLogin("admin@example.com", PASSWORD)).toBe(true);
  });
});

describe.skipIf(!enabled)("audit trail and notification", () => {
  it("records verification, grant issue, grant consumption and password recovery — keyed by account, no secrets", async () => {
    const { admin, codes } = await adminWithCodes("admin@example.com");
    await verifyCode("admin@example.com", "AAAA-AAAA-AAAA-AAAA-AAAA-AAAA-AAAA-AAAA"); // one failure first
    const grant = await grantViaCode("admin@example.com", codes[0]);
    expect((await reset(grant)).status).toBe(200);

    const rows = await prisma.adminRecoveryAudit.findMany({ where: { userId: admin.id }, orderBy: { createdAt: "asc" } });
    const events = rows.map((r) => `${r.event}:${r.outcome}`);
    expect(events).toEqual(
      expect.arrayContaining([
        "CODES_GENERATED:SUCCESS",
        "CODE_VERIFICATION:FAILURE",
        "CODE_VERIFICATION:SUCCESS",
        "GRANT_ISSUED:SUCCESS",
        "GRANT_CONSUMED:SUCCESS",
        "PASSWORD_RECOVERED:SUCCESS",
      ])
    );
    const recovered = rows.find((r) => r.event === "PASSWORD_RECOVERED")!;
    expect(recovered.method).toBe("RECOVERY_CODE");
    expect(recovered.metadata).toMatchObject({ sessionsRevoked: 0 });

    const general = await prisma.auditLog.findFirst({ where: { action: "PASSWORD_RESET_COMPLETED", actorId: admin.id } });
    expect(general?.metadata).toMatchObject({ via: "ADMIN_RECOVERY_RECOVERY_CODE" });
  });

  it("sends a security notification to the Admin containing no link, code, token or password", async () => {
    const { codes } = await adminWithCodes("admin@example.com");
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const grant = await grantViaCode("admin@example.com", codes[0]);
      expect((await reset(grant)).status).toBe(200);
      const mail = log.mock.calls.map((c) => String(c[0])).find((l) => l.includes("admin@example.com") && l.includes("password was changed"));
      expect(mail).toBeDefined();
      expect(mail).not.toContain(grant);
      expect(mail).not.toContain(codes[0]);
      expect(mail).not.toContain(NEW_PASSWORD);
      expect(mail).not.toMatch(/https?:\/\//);
    } finally {
      log.mockRestore();
    }
  });

  it("a notification failure never fails or undoes the reset", async () => {
    const { codes } = await adminWithCodes("admin@example.com");
    const grant = await grantViaCode("admin@example.com", codes[0]);
    // EMAIL_PROVIDER=console in tests: make the transport itself blow up.
    const log = vi.spyOn(console, "log").mockImplementation(() => {
      throw new Error("mail down");
    });
    try {
      expect((await reset(grant)).status).toBe(200);
    } finally {
      log.mockRestore();
    }
    expect(await canLogin("admin@example.com", NEW_PASSWORD)).toBe(true);
  });
});

// ═════════════════════════════════════════════════════════════════════════

describe.skipIf(!enabled)("passkey → grant → new password", () => {
  it("full passkey recovery: options → assertion → grant → reset → login; counter and lastUsedAt advance", async () => {
    const admin = await createUser("ADMIN", "admin@example.com");
    const enrolled = await enrolPasskey(admin);

    const verified = await passkeyRecover("admin@example.com", enrolled, { over: { signCount: 5 } });
    expect(verified.status).toBe(200);
    expect(verified.headers["cache-control"]).toBe("no-store");

    const row = await prisma.adminPasskey.findUniqueOrThrow({ where: { id: enrolled.passkeyId } });
    expect(Number(row.counter)).toBe(5);
    expect(row.lastUsedAt).not.toBeNull();

    expect((await reset(verified.body.grantToken)).status).toBe(200);
    expect(await canLogin("admin@example.com", NEW_PASSWORD)).toBe(true);

    const events = (await prisma.adminRecoveryAudit.findMany({ where: { userId: admin.id } })).map((r) => `${r.event}:${r.method}`);
    expect(events).toEqual(expect.arrayContaining(["PASSKEY_VERIFICATION:PASSKEY", "GRANT_ISSUED:PASSKEY", "PASSWORD_RECOVERED:PASSKEY"]));
  });

  it("works for the second of several registered passkeys, and leaves recovery codes untouched", async () => {
    const admin = await createUser("ADMIN", "admin@example.com");
    const { codes } = await generateRecoveryCodeSet(admin.id);
    await enrolPasskey(admin);
    const second = await enrolPasskey(admin);

    expect((await passkeyRecover("admin@example.com", second)).status).toBe(200);
    expect(await prisma.adminRecoveryCode.count({ where: { userId: admin.id, usedAt: null, revokedAt: null } })).toBe(codes.length);
  });

  it("rejects an assertion for a wrong challenge, and the issued challenge is burned", async () => {
    const admin = await createUser("ADMIN", "admin@example.com");
    const enrolled = await enrolPasskey(admin);

    const options = await passkeyOptions("admin@example.com");
    const wrongChallenge = assertionFor(enrolled, "d3JvbmctY2hhbGxlbmdl"); // signed over a different challenge
    const bad = await post(`${API}/passkey/verify`, { email: "admin@example.com", challengeId: options.body.challengeId, response: wrongChallenge });
    expect({ status: bad.status, code: bad.body.code }).toEqual(GENERIC_FAILURE);

    // Even the genuine assertion for that challenge is now refused: it was consumed.
    const good = await post(`${API}/passkey/verify`, {
      email: "admin@example.com",
      challengeId: options.body.challengeId,
      response: assertionFor(enrolled, options.body.options.challenge),
    });
    expect({ status: good.status, code: good.body.code }).toEqual(GENERIC_FAILURE);
  });

  it("a challenge is single-use: replaying a successful assertion fails", async () => {
    const admin = await createUser("ADMIN", "admin@example.com");
    const enrolled = await enrolPasskey(admin);
    const options = await passkeyOptions("admin@example.com");
    const body = {
      email: "admin@example.com",
      challengeId: options.body.challengeId,
      response: assertionFor(enrolled, options.body.options.challenge, { signCount: 2 }),
    };
    expect((await post(`${API}/passkey/verify`, body)).status).toBe(200);
    const replay = await post(`${API}/passkey/verify`, body);
    expect({ status: replay.status, code: replay.body.code }).toEqual(GENERIC_FAILURE);
  });

  it("concurrent verification of one challenge issues at most one grant", async () => {
    const admin = await createUser("ADMIN", "admin@example.com");
    const enrolled = await enrolPasskey(admin);
    const options = await passkeyOptions("admin@example.com");
    const body = {
      email: "admin@example.com",
      challengeId: options.body.challengeId,
      response: assertionFor(enrolled, options.body.options.challenge, { signCount: 2 }),
    };
    const results = await Promise.all(Array.from({ length: 5 }, () => post(`${API}/passkey/verify`, body)));
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(await prisma.adminRecoveryGrant.count({ where: { userId: admin.id } })).toBe(1);
  });

  it("rejects a forged signature and an assertion without user verification", async () => {
    const admin = await createUser("ADMIN", "admin@example.com");
    const enrolled = await enrolPasskey(admin);

    const forged = await passkeyRecover("admin@example.com", enrolled, {
      over: { signWith: generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey },
    });
    expect({ status: forged.status, code: forged.body.code }).toEqual(GENERIC_FAILURE);

    const noUv = await passkeyRecover("admin@example.com", enrolled, { over: { userVerified: false } });
    expect({ status: noUv.status, code: noUv.body.code }).toEqual(GENERIC_FAILURE);
    expect(await prisma.adminRecoveryGrant.count()).toBe(0);
  });

  it("a challenge issued for one email cannot be redeemed for another (binding)", async () => {
    const alice = await createUser("ADMIN", "alice@example.com");
    const bob = await createUser("ADMIN", "bob@example.com");
    const aliceKey = await enrolPasskey(alice);
    await enrolPasskey(bob);

    const res = await passkeyRecover("bob@example.com", aliceKey, { verifyEmail: "alice@example.com" });
    expect({ status: res.status, code: res.body.code }).toEqual(GENERIC_FAILURE);
  });

  it("another Admin's passkey cannot recover this Admin's account (cross-account)", async () => {
    const alice = await createUser("ADMIN", "alice@example.com");
    const bob = await createUser("ADMIN", "bob@example.com");
    await enrolPasskey(alice);
    const bobKey = await enrolPasskey(bob);

    // Bob's genuine passkey, Alice's email.
    const res = await passkeyRecover("alice@example.com", bobKey);
    expect({ status: res.status, code: res.body.code }).toEqual(GENERIC_FAILURE);
    expect(await prisma.adminRecoveryGrant.count({ where: { userId: alice.id } })).toBe(0);
    expect(await canLogin("alice@example.com", PASSWORD)).toBe(true);
  });

  it("rejects a mismatched user handle", async () => {
    const admin = await createUser("ADMIN", "admin@example.com");
    const enrolled = await enrolPasskey(admin);
    const res = await passkeyRecover("admin@example.com", enrolled, { over: { userHandle: "b3RoZXItaGFuZGxl" } });
    expect({ status: res.status, code: res.body.code }).toEqual(GENERIC_FAILURE);
  });

  it("rejects an expired challenge", async () => {
    const admin = await createUser("ADMIN", "admin@example.com");
    const enrolled = await enrolPasskey(admin);
    const options = await passkeyOptions("admin@example.com");
    await prisma.adminRecoveryChallenge.updateMany({ data: { createdAt: new Date(Date.now() - 60_000), expiresAt: new Date(Date.now() - 1000) } });

    const res = await post(`${API}/passkey/verify`, {
      email: "admin@example.com",
      challengeId: options.body.challengeId,
      response: assertionFor(enrolled, options.body.options.challenge),
    });
    expect({ status: res.status, code: res.body.code }).toEqual(GENERIC_FAILURE);
  });

  it("a challenge is bound to the requesting client (User-Agent)", async () => {
    const admin = await createUser("ADMIN", "admin@example.com");
    const enrolled = await enrolPasskey(admin);
    const options = await passkeyOptions("admin@example.com", { "user-agent": "Admin-Browser/1.0" });

    const res = await post(
      `${API}/passkey/verify`,
      {
        email: "admin@example.com",
        challengeId: options.body.challengeId,
        response: assertionFor(enrolled, options.body.options.challenge),
      },
      { "user-agent": "Attacker/9.9" }
    );
    expect({ status: res.status, code: res.body.code }).toEqual(GENERIC_FAILURE);
  });

  it("a removed passkey can no longer recover the account", async () => {
    const admin = await createUser("ADMIN", "admin@example.com");
    const enrolled = await enrolPasskey(admin);
    await prisma.adminPasskey.delete({ where: { id: enrolled.passkeyId } });

    const res = await passkeyRecover("admin@example.com", enrolled);
    expect({ status: res.status, code: res.body.code }).toEqual(GENERIC_FAILURE);
  });

  it("fails closed with 503 when passkeys are not configured, while recovery codes keep working", async () => {
    const { codes } = await adminWithCodes("admin@example.com");
    const saved = { id: env.WEBAUTHN_RP_ID, list: env.WEBAUTHN_ORIGINS_LIST };
    env.WEBAUTHN_RP_ID = undefined;
    env.WEBAUTHN_ORIGINS_LIST = [];
    try {
      const res = await passkeyOptions("admin@example.com");
      expect(res.status).toBe(503);
      expect(res.body.code).toBe("PASSKEYS_NOT_CONFIGURED");
      expect((await verifyCode("admin@example.com", codes[0])).status).toBe(200);
    } finally {
      env.WEBAUTHN_RP_ID = saved.id;
      env.WEBAUTHN_ORIGINS_LIST = saved.list;
    }
  });

  it("new passkeys are registered as discoverable (resident) credentials, which the recovery ceremony relies on", async () => {
    const admin = await createUser("ADMIN", "admin@example.com");
    const token = await tokenFor(admin);
    const res = await post("/api/admin/security/passkeys/register/options", { currentPassword: PASSWORD }, { authorization: `Bearer ${token}` });
    expect(res.body.options.authenticatorSelection.residentKey).toBe("required");
  });
});

describe.skipIf(!enabled)("unauthenticated surface hardening", () => {
  it("the recovery routes ignore Authorization headers and never accept role/userId from the client", async () => {
    const cashier = await createUser("CASHIER", "cashier@example.com");
    const cashierToken = await tokenFor(cashier);
    const res = await post(`${API}/code/verify`, { email: "cashier@example.com", code: "x", role: "ADMIN", userId: cashier.id }, { authorization: `Bearer ${cashierToken}` });
    expect({ status: res.status, code: res.body.code }).toEqual(GENERIC_FAILURE);
  });

  it("validates request envelopes (bad email, missing fields, oversized input) without touching the database", async () => {
    expect((await post(`${API}/code/verify`, { email: "not-an-email", code: "x" })).status).toBe(422);
    expect((await post(`${API}/code/verify`, { email: "a@b.co" })).status).toBe(422);
    expect((await post(`${API}/code/verify`, { email: "a@b.co", code: "A".repeat(500) })).status).toBe(422);
    expect((await post(`${API}/passkey/verify`, { email: "a@b.co", challengeId: "nope", response: {} })).status).toBe(422);
    expect(await prisma.adminRecoveryAudit.count()).toBe(0);
  });

  it("existing Admin login still works alongside the new routes", async () => {
    await createUser("ADMIN", "admin@example.com");
    expect(await canLogin("admin@example.com", PASSWORD)).toBe(true);
  });
});
