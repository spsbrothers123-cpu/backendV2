/**
 * Phase 4 — database-level guarantees of the admin recovery tables.
 * Real PostgreSQL only (same gating as the other *.integration.test.ts files).
 * Covers: the credentialId / counter / expiry CHECKs fixed in
 * 20261023000000_admin_recovery_db_hardening, atomic one-time code
 * consumption under real concurrency, retention purge, and that the tables
 * are locked down (RLS on, no policies).
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { prisma } from "../src/lib/prisma.js";
import { resetDb } from "./dbReset.js";
import { purgeExpiredRecoveryArtifacts } from "../src/lib/recoveryRetention.js";

const enabled = !!process.env.RUN_INTEGRATION_TESTS;
const d = enabled ? describe : describe.skip;
const hex = () => randomBytes(32).toString("hex");

let userId: string;
beforeEach(async () => {
  if (!enabled) return;
  await resetDb();
  const u = await prisma.user.create({
    data: { name: "Admin", email: "admin@test.local", passwordHash: "x", role: "ADMIN", status: "ACTIVE" },
  });
  userId = u.id;
});
afterAll(async () => {
  if (enabled) await prisma.$disconnect();
});

const passkey = (over: Record<string, unknown> = {}) => ({
  userId,
  credentialId: randomBytes(32).toString("base64url"),
  publicKey: Buffer.from([1, 2, 3]),
  deviceType: "singleDevice",
  backedUp: false,
  userHandle: "h",
  name: "Laptop",
  ...over,
});

d("admin recovery tables — database guarantees", () => {
  it("stores a passkey with a long base64url credentialId and a counter above 2^31", async () => {
    const row = await prisma.adminPasskey.create({
      data: passkey({ credentialId: randomBytes(300).toString("base64url"), counter: 4_000_000_000 }),
    });
    expect(Number(row.counter)).toBe(4_000_000_000);
  });

  it("rejects a malformed credentialId and an out-of-range counter at the database", async () => {
    await expect(prisma.adminPasskey.create({ data: passkey({ credentialId: "not valid!" }) })).rejects.toThrow();
    await expect(prisma.adminPasskey.create({ data: passkey({ counter: 4_294_967_296 }) })).rejects.toThrow();
  });

  it("rejects a raw (non-HMAC) recovery code hash and a grant that expires before it is created", async () => {
    await expect(
      prisma.adminRecoveryCode.create({ data: { userId, setId: "s", codeHash: "ABCD-1234" } })
    ).rejects.toThrow();
    await expect(
      prisma.adminRecoveryGrant.create({
        data: { userId, method: "RECOVERY_CODE", tokenHash: hex(), userAgentHash: hex(), expiresAt: new Date(Date.now() - 60_000) },
      })
    ).rejects.toThrow();
  });

  it("lets exactly one of 20 concurrent redemptions consume a recovery code", async () => {
    const codeHash = hex();
    await prisma.adminRecoveryCode.create({ data: { userId, setId: "s", codeHash } });
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        prisma.adminRecoveryCode.updateMany({
          where: { userId, codeHash, usedAt: null, revokedAt: null },
          data: { usedAt: new Date() },
        })
      )
    );
    expect(results.filter((r) => r.count === 1)).toHaveLength(1);
  });

  it("purges long-expired grants and challenges but keeps recent ones, codes and audit rows", async () => {
    const old = new Date(Date.now() - 3 * 24 * 60 * 60_000);
    const fresh = new Date(Date.now() + 5 * 60_000);
    const mk = (expiresAt: Date, createdAt: Date) => ({ expiresAt, createdAt });
    await prisma.adminRecoveryGrant.createMany({
      data: [
        { userId, method: "RECOVERY_CODE", tokenHash: hex(), userAgentHash: hex(), ...mk(old, new Date(old.getTime() - 60_000)) },
        { userId, method: "RECOVERY_CODE", tokenHash: hex(), userAgentHash: hex(), ...mk(fresh, new Date()) },
      ],
    });
    await prisma.adminRecoveryChallenge.create({
      data: { subjectHash: hex(), userAgentHash: hex(), challenge: "c", ...mk(old, new Date(old.getTime() - 60_000)) },
    });
    await prisma.adminRecoveryCode.create({ data: { userId, setId: "s", codeHash: hex(), usedAt: old } });
    await prisma.adminRecoveryAudit.create({ data: { userId, event: "GRANT_ISSUED", outcome: "SUCCESS" } });

    const r = await purgeExpiredRecoveryArtifacts();
    expect(r).toEqual({ grants: 1, passkeyChallenges: 0, recoveryChallenges: 1 });
    expect(await prisma.adminRecoveryGrant.count()).toBe(1);
    expect(await prisma.adminRecoveryCode.count()).toBe(1);
    expect(await prisma.adminRecoveryAudit.count()).toBe(1);
  });

  it("keeps every recovery table behind RLS with no policies", async () => {
    const rows = await prisma.$queryRaw<Array<{ relname: string; rls: boolean }>>`
      SELECT relname::text AS relname, relrowsecurity AS rls FROM pg_class
      WHERE relname IN ('admin_passkeys','admin_passkey_challenges','admin_recovery_codes',
                        'admin_recovery_grants','admin_recovery_audit','admin_recovery_challenges')`;
    expect(rows).toHaveLength(6);
    expect(rows.every((r) => r.rls)).toBe(true);
    const policies = await prisma.$queryRaw<Array<{ n: bigint }>>`
      SELECT count(*) AS n FROM pg_policies WHERE tablename LIKE 'admin\_%'`;
    expect(Number(policies[0].n)).toBe(0);
  });
});
