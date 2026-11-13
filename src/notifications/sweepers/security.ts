
import { prisma } from "../../lib/prisma.js";
import { NOTIFICATION_DEFAULTS } from "../constants.js";
import { failedLoginBursts, maskEmail } from "../thresholds.js";
import { createNotification } from "../service.js";
import { resolveCentralAdminRecipients } from "../recipients.js";
import { afterKey, drain, type Cursor } from "./util.js";
import type { SweepJob, SweepResult } from "./types.js";

/** D-20: 5 failed sign-ins inside 10 minutes → Central Admin only. */
async function failedLoginPart(since: Date): Promise<SweepResult> {
  const { attempts, windowMinutes } = NOTIFICATION_DEFAULTS.failedLogin;
  // Start one window earlier so a burst that straddles the watermark is still seen whole.
  const from = new Date(since.getTime() - windowMinutes * 60_000);
  const rows = await prisma.auditLog.findMany({
    where: { action: "LOGIN_FAILED", createdAt: { gte: from } },
    select: { id: true, createdAt: true, actorRole: true, metadata: true },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: 5000,
  });
  const byAccount = new Map<string, { role: string; email: string; events: { id: string; at: Date }[] }>();
  for (const r of rows) {
    const email = (r.metadata as { email?: unknown } | null)?.email;
    if (typeof email !== "string" || !email) continue;
    const key = `${r.actorRole ?? "?"}:${email.toLowerCase()}`;
    const entry = byAccount.get(key) ?? { role: r.actorRole ?? "account", email: email.toLowerCase(), events: [] };
    entry.events.push({ id: r.id, at: r.createdAt });
    byAccount.set(key, entry);
  }
  const admins = await resolveCentralAdminRecipients(prisma);
  let created = 0;
  let failures = 0;
  for (const acct of byAccount.values()) {
    for (const burst of failedLoginBursts(acct.events, attempts, windowMinutes)) {
      if (burst.windowEnd < since) continue; // already handled by an earlier run
      try {
        const r = await createNotification({
          audience: "ADMIN",
          type: "security.failed_login",
          dedupeKey: `burst:${burst.firstId}`,
          title: "Repeated failed sign-ins",
          message: `${burst.count} failed ${acct.role.toLowerCase()} sign-in attempts for ${maskEmail(acct.email)} within ${windowMinutes} minutes.`,
          target: null,
          recipientUserIds: admins,
          occurredAt: burst.windowEnd,
        });
        if (r.created) created++;
      } catch (err) {
        failures++;
        console.error("failed-login alert failed", { error: (err as Error).message });
      }
    }
  }
  return { examined: rows.length, created, failures };
}

const adminPasswordRecovered = (since: Date) =>
  drain({
    ts: (a) => a.createdAt,
    fetch: (after: Cursor, take: number) =>
      prisma.auditLog.findMany({
        where: { action: "PASSWORD_RESET_COMPLETED", actorRole: "ADMIN", createdAt: { gte: since }, ...afterKey("createdAt", after) },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        take,
      }),
    handle: async (a) =>
      (
        await createNotification({
          audience: "ADMIN",
          type: "security.admin_password_recovered",
          dedupeKey: `audit:${a.id}`,
          title: "Administrator password was reset",
          message: "An administrator account password was reset through account recovery.",
          recipientUserIds: await resolveCentralAdminRecipients(prisma),
          occurredAt: a.createdAt,
        })
      ).created
        ? 1
        : 0,
  });

const cashierRecoveryRequested = (since: Date) =>
  drain({
    ts: (r) => r.createdAt,
    fetch: (after: Cursor, take: number) =>
      prisma.cashierRecoveryRequest.findMany({
        where: { createdAt: { gte: since }, ...afterKey("createdAt", after) },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        take,
        include: { user: { select: { name: true, shopId: true, shop: { select: { name: true } } } } },
      }),
    handle: async (r) =>
      (
        await createNotification({
          audience: "ADMIN",
          type: "security.cashier_recovery_requested",
          dedupeKey: `request:${r.id}`,
          title: "Cashier password recovery requested",
          message: `${r.user.name}${r.user.shop ? ` (${r.user.shop.name})` : ""} asked for a password recovery code.`,
          shopId: r.user.shopId,
          target: { kind: "recovery_request", id: r.id },
          recipientUserIds: await resolveCentralAdminRecipients(prisma),
          occurredAt: r.createdAt,
        })
      ).created
        ? 1
        : 0,
  });

const cashierSignupPending = (since: Date) =>
  drain({
    ts: (u) => u.createdAt,
    fetch: (after: Cursor, take: number) =>
      prisma.user.findMany({
        where: { role: "CASHIER", status: "PENDING_ADMIN_APPROVAL", createdAt: { gte: since }, ...afterKey("createdAt", after) },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        take,
        include: { shop: { select: { name: true } } },
      }),
    handle: async (u) =>
      (
        await createNotification({
          audience: "ADMIN",
          type: "account.cashier_signup_pending",
          dedupeKey: `user:${u.id}`,
          title: "New cashier awaiting approval",
          message: `${u.name}${u.shop ? ` signed up for ${u.shop.name}` : " signed up"} and is waiting for approval.`,
          shopId: u.shopId,
          target: { kind: "cashier", id: u.id },
          recipientUserIds: await resolveCentralAdminRecipients(prisma),
          occurredAt: u.createdAt,
        })
      ).created
        ? 1
        : 0,
  });

const CASHIER_ACCOUNT_ACTIONS = [
  "CASHIER_RECOVERY_APPROVED",
  "CASHIER_RECOVERY_REJECTED",
  "CASHIER_RECOVERY_COMPLETED",
  "CASHIER_UPDATED",
  "CASHIER_STATUS_CHANGED",
] as const;

/**
 * Account notices for the affected Cashier. Texts are fixed strings: no
 * passwords, tokens, recovery codes or other users' data ever reach them.
 */
const cashierAccountEvents = (since: Date) =>
  drain({
    ts: (a) => a.createdAt,
    fetch: (after: Cursor, take: number) =>
      prisma.auditLog.findMany({
        where: { action: { in: [...CASHIER_ACCOUNT_ACTIONS] }, createdAt: { gte: since }, ...afterKey("createdAt", after) },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        take,
      }),
    handle: async (a) => {
      let userId: string | null = null;
      let type: "account.recovery_status" | "account.password_changed" | "account.changed";
      let title: string;
      let message: string;

      if (a.action === "CASHIER_RECOVERY_APPROVED" || a.action === "CASHIER_RECOVERY_REJECTED") {
        const req = a.entityId ? await prisma.cashierRecoveryRequest.findUnique({ where: { id: a.entityId }, select: { userId: true } }) : null;
        userId = req?.userId ?? null;
        type = "account.recovery_status";
        const approved = a.action === "CASHIER_RECOVERY_APPROVED";
        title = approved ? "Password recovery approved" : "Password recovery declined";
        message = approved ? "Your password recovery request was approved." : "Your password recovery request was declined.";
      } else if (a.action === "CASHIER_RECOVERY_COMPLETED") {
        userId = a.actorId;
        type = "account.password_changed";
        title = "Your password was changed";
        message = "Your password was changed through account recovery. If this wasn't you, tell your administrator.";
      } else {
        if (a.action === "CASHIER_STATUS_CHANGED" && (a.metadata as { status?: string } | null)?.status !== "ACTIVE") return 0;
        userId = a.entityId;
        type = "account.changed";
        title = a.action === "CASHIER_UPDATED" ? "Your account details were updated" : "Your account was reactivated";
        message = a.action === "CASHIER_UPDATED" ? "An administrator updated your account details." : "An administrator reactivated your account.";
      }
      if (!userId) return 0;
      const cashier = await prisma.user.findFirst({ where: { id: userId, role: "CASHIER", status: "ACTIVE" }, select: { id: true, shopId: true } });
      if (!cashier) return 0;
      const r = await createNotification({
        audience: "CASHIER",
        type,
        dedupeKey: `audit:${a.id}`,
        title,
        message,
        shopId: cashier.shopId,
        target: { kind: "account" },
        recipientUserIds: [cashier.id],
        occurredAt: a.createdAt,
      });
      return r.created ? 1 : 0;
    },
  });

/** Security + account events (B3.6): all read-only over audit_logs / users / recovery requests. */
export const securitySweep: SweepJob = {
  key: "sweep.security",
  intervalMs: 60_000,
  watermarked: true,
  async run({ since }) {
    const parts = await Promise.allSettled([
      failedLoginPart(since),
      adminPasswordRecovered(since),
      cashierRecoveryRequested(since),
      cashierSignupPending(since),
      cashierAccountEvents(since),
    ]);
    const total: SweepResult = { examined: 0, created: 0, failures: 0 };
    for (const p of parts) {
      if (p.status === "rejected") {
        total.failures = (total.failures ?? 0) + 1;
        total.resumeFrom = since; // retry the whole window next run
        console.error("security sweep part failed", { error: (p.reason as Error).message });
        continue;
      }
      total.examined += p.value.examined;
      total.created += p.value.created;
      total.failures = (total.failures ?? 0) + (p.value.failures ?? 0);
      if (p.value.resumeFrom && (!total.resumeFrom || p.value.resumeFrom < total.resumeFrom)) total.resumeFrom = p.value.resumeFrom;
    }
    return total;
  },
};

