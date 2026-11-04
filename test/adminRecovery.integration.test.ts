/**
 * Integration tests for the Admin password-recovery FOUNDATION (Phase 1):
 * recovery-code generation/regeneration, atomic single-use consumption,
 * recovery grants, and the DB-backed throttle + audit ledger. No HTTP
 * routes exist yet (Phase 2/3), so these exercise the lib/ functions
 * directly against a real Postgres.
 *
 * NOT run as part of the default build. To run locally:
 *   1. Point DATABASE_URL (in .env.test) at a disposable LOCAL Postgres
 *      database whose name contains "test" (test/setup.ts refuses anything else).
 *   2. npx prisma migrate deploy   (applies 20261020000000_admin_recovery_foundation)
 *   3. RUN_INTEGRATION_TESTS=1 npx vitest run test/adminRecovery.integration.test.ts
 *
 * Without RUN_INTEGRATION_TESTS this whole file is skipped, so a plain
 * `npm test` stays green on a machine with no database.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../src/lib/prisma.js";
import { hashPassword } from "../src/lib/password.js";
import { AppError } from "../src/lib/errors.js";
import { resetDb } from "./dbReset.js";
import {
  RECOVERY_CODE_COUNT,
  consumeRecoveryCode,
  countActiveRecoveryCodes,
  generateRecoveryCodeSet,
} from "../src/lib/recoveryCodes.js";
import {
  consumeRecoveryGrant,
  invalidateOutstandingGrants,
  issueRecoveryGrant,
} from "../src/lib/recoveryGrant.js";
import {
  RECOVERY_THROTTLE,
  checkRecoveryThrottle,
  recordFailedCodeVerification,
  recordThrottledAttempt,
} from "../src/lib/recoveryThrottle.js";
import { recordRecoveryAudit } from "../src/lib/recoveryAudit.js";
import { hashRecoverySubject } from "../src/lib/recoveryCrypto.js";

const enabled = !!process.env.RUN_INTEGRATION_TESTS;

let shopId: string;

async function createUser(
  role: "ADMIN" | "CASHIER",
  email: string,
  status: "ACTIVE" | "SUSPENDED" = "ACTIVE"
) {
  return prisma.user.create({
    data: {
      name: role === "ADMIN" ? "Admin" : "Cashier",
      email,
      passwordHash: await hashPassword("Password1"),
      role,
      status,
      shopId,
    },
  });
}

afterAll(async () => {
  if (enabled) await prisma.$disconnect();
});

describe.skipIf(!enabled)("admin recovery codes", () => {
  beforeEach(async () => {
    await resetDb();
    const shop = await prisma.shop.create({ data: { name: "Test Shop", code: "TEST" } });
    shopId = shop.id;
  });

  it("generates exactly 8 independent codes and stores only keyed hashes", async () => {
    const admin = await createUser("ADMIN", "admin@example.com");
    const { codes, setId, regenerated } = await generateRecoveryCodeSet(admin.id);

    expect(regenerated).toBe(false);
    expect(codes).toHaveLength(RECOVERY_CODE_COUNT);
    expect(new Set(codes).size).toBe(RECOVERY_CODE_COUNT);

    const rows = await prisma.adminRecoveryCode.findMany({ where: { userId: admin.id } });
    expect(rows).toHaveLength(RECOVERY_CODE_COUNT);
    expect(rows.every((r) => r.setId === setId && r.usedAt === null && r.revokedAt === null)).toBe(true);
    expect(new Set(rows.map((r) => r.codeHash)).size).toBe(RECOVERY_CODE_COUNT);

    // No raw code (in display OR canonical form) appears anywhere in the stored rows or the audit trail.
    const stored = JSON.stringify(rows) + JSON.stringify(await prisma.adminRecoveryAudit.findMany());
    for (const code of codes) {
      expect(stored).not.toContain(code);
      expect(stored).not.toContain(code.replace(/-/g, ""));
    }
    expect(await countActiveRecoveryCodes(admin.id)).toBe(RECOVERY_CODE_COUNT);
  });

  it("records a CODES_GENERATED audit event without any secret", async () => {
    const admin = await createUser("ADMIN", "admin@example.com");
    await generateRecoveryCodeSet(admin.id, { ip: "198.51.100.7", userAgent: "UnitTest/1.0" });
    const audit = await prisma.adminRecoveryAudit.findMany({ where: { userId: admin.id } });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      event: "CODES_GENERATED",
      outcome: "SUCCESS",
      method: "RECOVERY_CODE",
      ip: "198.51.100.7",
      userAgent: "UnitTest/1.0",
    });
  });

  it("lets a code be used exactly once", async () => {
    const admin = await createUser("ADMIN", "admin@example.com");
    const { codes } = await generateRecoveryCodeSet(admin.id);

    expect(await consumeRecoveryCode(admin.id, codes[0])).toBe(true);
    expect(await consumeRecoveryCode(admin.id, codes[0])).toBe(false); // reuse rejected
    expect(await countActiveRecoveryCodes(admin.id)).toBe(RECOVERY_CODE_COUNT - 1);
    // Other codes are unaffected.
    expect(await consumeRecoveryCode(admin.id, codes[1])).toBe(true);
  });

  it("accepts a code typed in a forgiving form (lower-case, spaces)", async () => {
    const admin = await createUser("ADMIN", "admin@example.com");
    const { codes } = await generateRecoveryCodeSet(admin.id);
    expect(await consumeRecoveryCode(admin.id, `  ${codes[0].toLowerCase().replace(/-/g, " ")} `)).toBe(true);
  });

  it("rejects wrong, malformed and non-string codes without consuming anything", async () => {
    const admin = await createUser("ADMIN", "admin@example.com");
    await generateRecoveryCodeSet(admin.id);

    expect(await consumeRecoveryCode(admin.id, "0000-0000-0000-0000-0000-0000-0000-0000")).toBe(false);
    expect(await consumeRecoveryCode(admin.id, "nope")).toBe(false);
    expect(await consumeRecoveryCode(admin.id, "")).toBe(false);
    expect(await consumeRecoveryCode(admin.id, undefined)).toBe(false);
    expect(await consumeRecoveryCode(admin.id, { code: "x" })).toBe(false);
    expect(await countActiveRecoveryCodes(admin.id)).toBe(RECOVERY_CODE_COUNT);
  });

  it("is account-bound: one admin's code cannot be redeemed against another admin", async () => {
    const a = await createUser("ADMIN", "a@example.com");
    const b = await createUser("ADMIN", "b@example.com");
    const { codes: aCodes } = await generateRecoveryCodeSet(a.id);
    await generateRecoveryCodeSet(b.id);

    expect(await consumeRecoveryCode(b.id, aCodes[0])).toBe(false);
    // …and A's code is still perfectly usable by A.
    expect(await consumeRecoveryCode(a.id, aCodes[0])).toBe(true);
  });

  it("consumes atomically: 15 concurrent redemptions of one code → exactly one winner", async () => {
    const admin = await createUser("ADMIN", "admin@example.com");
    const { codes } = await generateRecoveryCodeSet(admin.id);

    const results = await Promise.all(Array.from({ length: 15 }, () => consumeRecoveryCode(admin.id, codes[0])));
    expect(results.filter(Boolean)).toHaveLength(1);

    const row = (await prisma.adminRecoveryCode.findMany({ where: { userId: admin.id, usedAt: { not: null } } }));
    expect(row).toHaveLength(1);
  });

  it("lets all 8 different codes be consumed concurrently, each exactly once", async () => {
    const admin = await createUser("ADMIN", "admin@example.com");
    const { codes } = await generateRecoveryCodeSet(admin.id);
    // Each code raced twice at the same time.
    const results = await Promise.all([...codes, ...codes].map((c) => consumeRecoveryCode(admin.id, c)));
    expect(results.filter(Boolean)).toHaveLength(RECOVERY_CODE_COUNT);
    expect(await countActiveRecoveryCodes(admin.id)).toBe(0);
  });

  it("regeneration invalidates the previous set and issues a new set of 8", async () => {
    const admin = await createUser("ADMIN", "admin@example.com");
    const first = await generateRecoveryCodeSet(admin.id);
    await consumeRecoveryCode(admin.id, first.codes[0]); // one already used

    const second = await generateRecoveryCodeSet(admin.id);
    expect(second.regenerated).toBe(true);
    expect(second.setId).not.toBe(first.setId);

    for (const old of first.codes) expect(await consumeRecoveryCode(admin.id, old)).toBe(false);
    expect(await countActiveRecoveryCodes(admin.id)).toBe(RECOVERY_CODE_COUNT);
    expect(await consumeRecoveryCode(admin.id, second.codes[0])).toBe(true);

    const events = await prisma.adminRecoveryAudit.findMany({ where: { userId: admin.id }, orderBy: { createdAt: "asc" } });
    expect(events.map((e) => e.event)).toEqual(["CODES_GENERATED", "CODES_REGENERATED"]);
  });

  it("never leaves two active sets, even when regeneration is requested concurrently", async () => {
    const admin = await createUser("ADMIN", "admin@example.com");
    await generateRecoveryCodeSet(admin.id);

    const sets = await Promise.all(Array.from({ length: 6 }, () => generateRecoveryCodeSet(admin.id)));

    expect(await countActiveRecoveryCodes(admin.id)).toBe(RECOVERY_CODE_COUNT);
    // Exactly one returned set is the live one; every other returned set was superseded.
    const activeBySet = await Promise.all(
      sets.map((s) => prisma.adminRecoveryCode.count({ where: { userId: admin.id, setId: s.setId, usedAt: null, revokedAt: null } }))
    );
    expect(activeBySet.filter((n) => n === RECOVERY_CODE_COUNT)).toHaveLength(1);
    expect(activeBySet.filter((n) => n === 0)).toHaveLength(sets.length - 1);
  });

  it("only ever issues codes to an ACTIVE ADMIN (cashier, suspended admin, unknown id all refused)", async () => {
    const cashier = await createUser("CASHIER", "cashier@example.com");
    const suspended = await createUser("ADMIN", "suspended@example.com", "SUSPENDED");

    for (const id of [cashier.id, suspended.id, "no-such-user"]) {
      await expect(generateRecoveryCodeSet(id)).rejects.toMatchObject({
        constructor: AppError,
        statusCode: 403,
        code: "ROLE_NOT_ALLOWED",
      });
    }
    expect(await prisma.adminRecoveryCode.count()).toBe(0);
    expect(await prisma.adminRecoveryAudit.count()).toBe(0);
  });

  it("can consume inside a caller's transaction and rolls back with it", async () => {
    const admin = await createUser("ADMIN", "admin@example.com");
    const { codes } = await generateRecoveryCodeSet(admin.id);

    await expect(
      prisma.$transaction(async (tx) => {
        expect(await consumeRecoveryCode(admin.id, codes[0], tx)).toBe(true);
        throw new Error("simulate failure later in the reset transaction");
      })
    ).rejects.toThrow("simulate failure");

    // The consume was rolled back, so the code is still good.
    expect(await consumeRecoveryCode(admin.id, codes[0])).toBe(true);
  });

  it("deleting the user cascades codes and grants but keeps the audit trail (userId nulled)", async () => {
    const admin = await createUser("ADMIN", "admin@example.com");
    await generateRecoveryCodeSet(admin.id);
    await issueRecoveryGrant({ userId: admin.id, method: "RECOVERY_CODE", userAgent: "UA" });

    await prisma.user.delete({ where: { id: admin.id } });

    expect(await prisma.adminRecoveryCode.count()).toBe(0);
    expect(await prisma.adminRecoveryGrant.count()).toBe(0);
    const audit = await prisma.adminRecoveryAudit.findMany();
    expect(audit.length).toBeGreaterThan(0);
    expect(audit.every((a) => a.userId === null)).toBe(true);
  });
});

describe.skipIf(!enabled)("admin recovery grants", () => {
  beforeEach(async () => {
    await resetDb();
    const shop = await prisma.shop.create({ data: { name: "Test Shop", code: "TEST" } });
    shopId = shop.id;
  });

  it("issues an opaque token, storing only its hash, and redeems it once", async () => {
    const admin = await createUser("ADMIN", "admin@example.com");
    const { token, expiresAt } = await issueRecoveryGrant({ userId: admin.id, method: "RECOVERY_CODE", userAgent: "UA-1" });

    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(expiresAt.getTime()).toBeGreaterThan(Date.now());
    const rows = await prisma.adminRecoveryGrant.findMany();
    expect(JSON.stringify(rows)).not.toContain(token);

    expect(await consumeRecoveryGrant({ token, userAgent: "UA-1" })).toEqual({ userId: admin.id, method: "RECOVERY_CODE" });
    expect(await consumeRecoveryGrant({ token, userAgent: "UA-1" })).toBeNull(); // replay rejected
  });

  it("is single-use under concurrency: 12 simultaneous redemptions → exactly one winner", async () => {
    const admin = await createUser("ADMIN", "admin@example.com");
    const { token } = await issueRecoveryGrant({ userId: admin.id, method: "RECOVERY_CODE", userAgent: "UA" });
    const results = await Promise.all(Array.from({ length: 12 }, () => consumeRecoveryGrant({ token, userAgent: "UA" })));
    expect(results.filter((r) => r !== null)).toHaveLength(1);
  });

  it("rejects an expired grant", async () => {
    const admin = await createUser("ADMIN", "admin@example.com");
    const { token } = await issueRecoveryGrant({ userId: admin.id, method: "RECOVERY_CODE", userAgent: "UA" });
    await prisma.adminRecoveryGrant.updateMany({ data: { createdAt: new Date(Date.now() - 60_000), expiresAt: new Date(Date.now() - 1000) } });
    expect(await consumeRecoveryGrant({ token, userAgent: "UA" })).toBeNull();
  });

  it("rejects a different User-Agent WITHOUT burning the grant", async () => {
    const admin = await createUser("ADMIN", "admin@example.com");
    const { token } = await issueRecoveryGrant({ userId: admin.id, method: "RECOVERY_CODE", userAgent: "Legit-Browser" });

    expect(await consumeRecoveryGrant({ token, userAgent: "Attacker-Client" })).toBeNull();
    expect(await consumeRecoveryGrant({ token, userAgent: undefined })).toBeNull();
    // The legitimate holder can still redeem it afterwards.
    expect(await consumeRecoveryGrant({ token, userAgent: "Legit-Browser" })).toMatchObject({ userId: admin.id });
  });

  it("rejects malformed and unknown tokens", async () => {
    const admin = await createUser("ADMIN", "admin@example.com");
    await issueRecoveryGrant({ userId: admin.id, method: "RECOVERY_CODE", userAgent: "UA" });
    expect(await consumeRecoveryGrant({ token: "short", userAgent: "UA" })).toBeNull();
    expect(await consumeRecoveryGrant({ token: undefined, userAgent: "UA" })).toBeNull();
    expect(await consumeRecoveryGrant({ token: "A".repeat(43), userAgent: "UA" })).toBeNull();
  });

  it("each grant is bound to its own account", async () => {
    const a = await createUser("ADMIN", "a@example.com");
    const b = await createUser("ADMIN", "b@example.com");
    const ga = await issueRecoveryGrant({ userId: a.id, method: "RECOVERY_CODE", userAgent: "UA" });
    const gb = await issueRecoveryGrant({ userId: b.id, method: "RECOVERY_CODE", userAgent: "UA" });
    expect((await consumeRecoveryGrant({ token: ga.token, userAgent: "UA" }))?.userId).toBe(a.id);
    expect((await consumeRecoveryGrant({ token: gb.token, userAgent: "UA" }))?.userId).toBe(b.id);
  });

  it("consumes inside a caller's transaction and rolls back with it", async () => {
    const admin = await createUser("ADMIN", "admin@example.com");
    const { token } = await issueRecoveryGrant({ userId: admin.id, method: "RECOVERY_CODE", userAgent: "UA" });

    await expect(
      prisma.$transaction(async (tx) => {
        expect(await consumeRecoveryGrant({ token, userAgent: "UA" }, tx)).not.toBeNull();
        throw new Error("password update failed");
      })
    ).rejects.toThrow("password update failed");

    expect(await consumeRecoveryGrant({ token, userAgent: "UA" })).not.toBeNull();
  });

  it("invalidateOutstandingGrants kills every unconsumed grant for the account only", async () => {
    const a = await createUser("ADMIN", "a@example.com");
    const b = await createUser("ADMIN", "b@example.com");
    const g1 = await issueRecoveryGrant({ userId: a.id, method: "RECOVERY_CODE", userAgent: "UA" });
    const g2 = await issueRecoveryGrant({ userId: a.id, method: "RECOVERY_CODE", userAgent: "UA" });
    const gb = await issueRecoveryGrant({ userId: b.id, method: "RECOVERY_CODE", userAgent: "UA" });

    expect(await invalidateOutstandingGrants(a.id)).toBe(2);
    expect(await consumeRecoveryGrant({ token: g1.token, userAgent: "UA" })).toBeNull();
    expect(await consumeRecoveryGrant({ token: g2.token, userAgent: "UA" })).toBeNull();
    expect(await consumeRecoveryGrant({ token: gb.token, userAgent: "UA" })).not.toBeNull();
  });
});

describe.skipIf(!enabled)("recovery throttling + audit ledger", () => {
  const IP = "203.0.113.9";
  const subject = (email: string) => hashRecoverySubject(email);

  beforeEach(async () => {
    await resetDb();
    const shop = await prisma.shop.create({ data: { name: "Test Shop", code: "TEST" } });
    shopId = shop.id;
  });

  async function fail(email: string, ip = IP) {
    await recordFailedCodeVerification({ subjectHash: subject(email), ip });
  }

  it("allows attempts with no history and below the free allowance", async () => {
    expect((await checkRecoveryThrottle({ subjectHash: subject("a@x.com"), ip: IP })).blocked).toBe(false);
    for (let i = 0; i < 4; i++) await fail("a@x.com");
    expect((await checkRecoveryThrottle({ subjectHash: subject("a@x.com"), ip: IP })).blocked).toBe(false);
  });

  it("blocks an account after 5 failures with an escalating delay, then releases it (no permanent lockout)", async () => {
    for (let i = 0; i < 5; i++) await fail("a@x.com");
    const blocked = await checkRecoveryThrottle({ subjectHash: subject("a@x.com"), ip: "198.51.100.1" });
    expect(blocked.blocked).toBe(true);
    expect(blocked.scope).toBe("ACCOUNT");
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
    expect(blocked.retryAfterSeconds).toBeLessThanOrEqual(30);

    // 6th failure escalates to 60s.
    await fail("a@x.com");
    const worse = await checkRecoveryThrottle({ subjectHash: subject("a@x.com") });
    expect(worse.retryAfterSeconds).toBeGreaterThan(30);
    expect(worse.retryAfterSeconds).toBeLessThanOrEqual(60);

    // Once the delay has passed it is open again…
    expect((await checkRecoveryThrottle({ subjectHash: subject("a@x.com") }, new Date(Date.now() + 61_000))).blocked).toBe(false);
    // …and failures age out of the 15-minute window entirely.
    const later = new Date(Date.now() + RECOVERY_THROTTLE.account.windowMs + 5_000);
    expect((await checkRecoveryThrottle({ subjectHash: subject("a@x.com") }, later)).blocked).toBe(false);
  });

  it("throttles an UNKNOWN email exactly like a known one (no enumeration signal)", async () => {
    await createUser("ADMIN", "real@example.com");
    for (let i = 0; i < 5; i++) {
      await fail("real@example.com");
      await fail("ghost@example.com");
    }
    const real = await checkRecoveryThrottle({ subjectHash: subject("real@example.com") });
    const ghost = await checkRecoveryThrottle({ subjectHash: subject("ghost@example.com") });
    expect({ ...real, retryAfterSeconds: 0 }).toEqual({ ...ghost, retryAfterSeconds: 0 });
    expect(real.blocked).toBe(true);
    expect(ghost.blocked).toBe(true);
  });

  it("treats the email key case-insensitively and keeps accounts independent", async () => {
    for (let i = 0; i < 5; i++) await fail("Mixed@Case.com");
    expect((await checkRecoveryThrottle({ subjectHash: subject("mixed@case.com") })).blocked).toBe(true);
    expect((await checkRecoveryThrottle({ subjectHash: subject("someone-else@x.com") })).blocked).toBe(false);
  });

  it("throttled attempts are logged but do NOT extend the block", async () => {
    for (let i = 0; i < 5; i++) await fail("a@x.com");
    const decision = await checkRecoveryThrottle({ subjectHash: subject("a@x.com") });
    for (let i = 0; i < 10; i++) {
      await recordThrottledAttempt({ subjectHash: subject("a@x.com"), ip: IP }, decision);
    }
    const after = await checkRecoveryThrottle({ subjectHash: subject("a@x.com") });
    expect(after.retryAfterSeconds).toBeLessThanOrEqual(30); // still the 5-failure delay, not escalated
    expect(await prisma.adminRecoveryAudit.count({ where: { event: "ATTEMPT_THROTTLED" } })).toBe(10);
  });

  it("blocks a noisy IP across many different accounts, and releases it after the window", async () => {
    for (let i = 0; i < RECOVERY_THROTTLE.ip.maxFailures; i++) await fail(`victim${i}@x.com`, IP);

    const blocked = await checkRecoveryThrottle({ subjectHash: subject("fresh@x.com"), ip: IP });
    expect(blocked).toMatchObject({ blocked: true, scope: "IP" });
    // Another IP is unaffected.
    expect((await checkRecoveryThrottle({ subjectHash: subject("fresh@x.com"), ip: "192.0.2.55" })).blocked).toBe(false);
    // Released once the failures leave the rolling hour.
    const later = new Date(Date.now() + RECOVERY_THROTTLE.ip.windowMs + 5_000);
    expect((await checkRecoveryThrottle({ subjectHash: subject("fresh@x.com"), ip: IP }, later)).blocked).toBe(false);
  });

  it("ignores old failures and ignores successes/other events", async () => {
    const old = new Date(Date.now() - 2 * 60 * 60_000);
    await prisma.adminRecoveryAudit.createMany({
      data: Array.from({ length: 10 }, () => ({
        subjectHash: subject("a@x.com"),
        ip: IP,
        event: "CODE_VERIFICATION" as const,
        outcome: "FAILURE" as const,
        createdAt: old,
      })),
    });
    await prisma.adminRecoveryAudit.createMany({
      data: Array.from({ length: 10 }, () => ({
        subjectHash: subject("a@x.com"),
        ip: IP,
        event: "CODE_VERIFICATION" as const,
        outcome: "SUCCESS" as const,
      })),
    });
    expect((await checkRecoveryThrottle({ subjectHash: subject("a@x.com"), ip: IP })).blocked).toBe(false);
  });

  it("never stores the raw email in the recovery audit table", async () => {
    await fail("private.person@example.com");
    const dump = JSON.stringify(await prisma.adminRecoveryAudit.findMany());
    expect(dump).not.toContain("private.person");
    expect(dump).toContain(subject("private.person@example.com"));
  });

  it("refuses to write secret-looking metadata to the audit table", async () => {
    await expect(
      recordRecoveryAudit({
        event: "CODE_VERIFICATION",
        outcome: "FAILURE",
        metadata: { code: "AAAA-BBBB" },
      })
    ).rejects.toThrow(/Refusing/);
    expect(await prisma.adminRecoveryAudit.count()).toBe(0);
  });
});
