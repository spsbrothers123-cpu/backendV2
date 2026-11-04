import { prisma } from "./prisma.js";

/**
 * Housekeeping for the short-lived recovery artefacts.
 *
 * Grants and challenges are single-use and expire in minutes, but nothing
 * else removes them once consumed/expired. This deletes rows that have been
 * dead for longer than `graceMs` (default 24 h, so recent rows stay
 * available for forensics). It deliberately does NOT touch
 * admin_recovery_audit (append-only history + throttle ledger) or
 * admin_recovery_codes (used/revoked rows are the proof a code was spent).
 */
export async function purgeExpiredRecoveryArtifacts(
  graceMs = 24 * 60 * 60_000,
  now = new Date()
): Promise<{ grants: number; passkeyChallenges: number; recoveryChallenges: number }> {
  const cutoff = new Date(now.getTime() - graceMs);
  const [grants, passkeyChallenges, recoveryChallenges] = await prisma.$transaction([
    prisma.adminRecoveryGrant.deleteMany({ where: { expiresAt: { lt: cutoff } } }),
    prisma.adminPasskeyChallenge.deleteMany({ where: { expiresAt: { lt: cutoff } } }),
    prisma.adminRecoveryChallenge.deleteMany({ where: { expiresAt: { lt: cutoff } } }),
  ]);
  return {
    grants: grants.count,
    passkeyChallenges: passkeyChallenges.count,
    recoveryChallenges: recoveryChallenges.count,
  };
}
