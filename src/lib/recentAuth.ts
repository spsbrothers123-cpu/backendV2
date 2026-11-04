import { prisma } from "./prisma.js";
import { AppError } from "./errors.js";
import { verifyPassword } from "./password.js";
import { recordRecoveryAudit } from "./recoveryAudit.js";
import { RECOVERY_THROTTLE, accountThrottleDecision } from "./recoveryThrottle.js";

/**
 * "Recent authentication" for Admin Security Settings.
 *
 * Every sensitive action (generate/regenerate recovery codes, register or
 * remove a passkey) must be accompanied by the Admin's CURRENT password,
 * which is verified server-side on THAT request. This is deliberately
 * stronger than checking "was the session created recently": a stolen but
 * still-valid access token is not enough to change recovery credentials —
 * the attacker would also need the password. It needs no new table and no
 * extra token that could itself be stolen or replayed.
 *
 * Wrong-password attempts are throttled per account using the durable
 * admin_recovery_audit ledger (REAUTH_FAILED rows) with the same escalating
 * policy as recovery-code verification: 5 free failures per rolling 15
 * minutes, then 30s, 60s, 120s … capped at 15 minutes. There is no
 * permanent lockout.
 *
 * NOTE: the failure is returned as HTTP 403 (not 401) on purpose — the Admin
 * app signs the user out on any 401, and a mistyped password here must not
 * log them out.
 */
export async function requireRecentAuth(
  userId: string,
  currentPassword: unknown,
  ctx: { ip?: string | null; userAgent?: string | null } = {}
): Promise<void> {
  const now = new Date();
  const since = new Date(now.getTime() - RECOVERY_THROTTLE.account.windowMs);

  const agg = await prisma.adminRecoveryAudit.aggregate({
    where: { userId, event: "REAUTH_FAILED", createdAt: { gte: since } },
    _count: { _all: true },
    _max: { createdAt: true },
  });
  const decision = accountThrottleDecision(agg._count._all, agg._max.createdAt, now);
  if (decision.blocked) {
    throw new AppError(
      429,
      "REAUTH_THROTTLED",
      `Too many incorrect password attempts. Try again in ${decision.retryAfterSeconds} seconds.`
    );
  }

  const user = await prisma.user.findUnique({ where: { id: userId }, select: { passwordHash: true } });
  const ok =
    !!user &&
    typeof currentPassword === "string" &&
    currentPassword.length > 0 &&
    (await verifyPassword(currentPassword, user.passwordHash));

  if (!ok) {
    await recordRecoveryAudit({
      userId,
      event: "REAUTH_FAILED",
      outcome: "FAILURE",
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
    throw new AppError(403, "INVALID_CURRENT_PASSWORD", "Your current password is incorrect.");
  }
}
