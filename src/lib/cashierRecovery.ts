import { Prisma, type CashierRecoveryStatus } from "@prisma/client";
import { prisma } from "./prisma.js";
import { AppError, Errors } from "./errors.js";
import { env } from "../config/env.js";
import { hashPassword, isPasswordStrongEnough } from "./password.js";
import { recordAudit } from "./audit.js";
import { hashRecoverySubject, requirePepper } from "./recoveryCrypto.js";
import {
  checkRecoveryThrottle,
  recordFailedCodeVerification,
  recordThrottledAttempt,
} from "./recoveryThrottle.js";
import {
  generateCashierRecoveryCode,
  hashCashierRecoveryCode,
  normalizeCashierRecoveryCode,
} from "./cashierRecoveryCrypto.js";

/**
 * Cashier admin-assisted password recovery.
 *
 *   1. request   (public)  — Cashier files a request by email. ALWAYS the same
 *                            generic answer; nothing reveals whether the email exists.
 *   2. approve   (Central Admin only) — after verifying the Cashier IN PERSON and
 *                            re-entering their own password, the Admin gets a one-time
 *                            code (shown once, never stored in plaintext).
 *   3. reset     (public)  — Cashier presents email + code + new password. The code
 *                            consumption, password update and session revocation are ONE
 *                            transaction.
 *
 * No email, OTP or reset link is used anywhere in this flow. No token or grant is
 * issued to the Cashier, so there is nothing that could be presented to an
 * ordinary POS API: the only artefact is a code that works for exactly one
 * endpoint.
 *
 * The 15-minute deadline is fixed when the request is created
 * (expiresAt = createdAt + 15 min, also enforced by a DB CHECK) and approval
 * never changes it.
 */

export const CASHIER_RECOVERY_TTL_MS = 15 * 60_000;
/** Soft abuse limits, counted from the durable cashier_recovery_requests table. */
export const CASHIER_RECOVERY_LIMITS = {
  perAccountPerHour: 5,
  perIpPerHour: 10,
  windowMs: 60 * 60_000,
} as const;

export interface RecoveryContext {
  ip?: string | null;
  userAgent?: string | null;
}

const NIL_UUID = "00000000-0000-0000-0000-000000000000";

/** The ONE error for every failed code redemption — unknown email, wrong/used/expired/rejected code, ineligible account. */
const verificationFailed = () =>
  new AppError(400, "RECOVERY_VERIFICATION_FAILED", "We couldn't verify that. Check your details and try again.");

export const GENERIC_REQUEST_MESSAGE =
  "If this account is eligible, a recovery request has been sent to your administrator. " +
  "Contact your administrator in person to verify your identity. The request expires in 15 minutes.";

/** Fails closed (503) — identical for every caller — when recovery cannot work on this server. */
export function requireCashierRecoveryConfigured(): void {
  try {
    requirePepper(env.RECOVERY_CODE_PEPPER);
  } catch {
    throw new AppError(503, "RECOVERY_NOT_CONFIGURED", "Account recovery is not available on this server yet.");
  }
  if (!env.CENTRAL_ADMIN_USER_ID) {
    throw new AppError(503, "RECOVERY_NOT_CONFIGURED", "Account recovery is not available on this server yet.");
  }
}

/** Marks lapsed PENDING/APPROVED requests EXPIRED and clears any code hash. Idempotent; safe to call anywhere. */
export async function expireStaleRequests(
  db: Prisma.TransactionClient | typeof prisma = prisma,
  userId?: string
): Promise<number> {
  const res = await db.cashierRecoveryRequest.updateMany({
    where: {
      status: { in: ["PENDING", "APPROVED"] },
      expiresAt: { lte: new Date() },
      ...(userId ? { userId } : {}),
    },
    data: { status: "EXPIRED", codeHash: null },
  });
  return res.count;
}

// ── 1. Public: file a request ───────────────────────────────────────────

export async function submitRecoveryRequest(input: { email: string; ctx: RecoveryContext }): Promise<void> {
  requireCashierRecoveryConfigured();
  const { ctx } = input;
  const now = new Date();

  // Per-IP flood control from the durable table (request creation only).
  if (ctx.ip) {
    const ipCount = await prisma.cashierRecoveryRequest.count({
      where: { ip: ctx.ip, createdAt: { gte: new Date(now.getTime() - CASHIER_RECOVERY_LIMITS.windowMs) } },
    });
    if (ipCount >= CASHIER_RECOVERY_LIMITS.perIpPerHour) {
      await recordAudit({
        action: "CASHIER_RECOVERY_THROTTLED",
        actorRole: "CASHIER",
        entityType: "CashierRecoveryRequest",
        metadata: { scope: "IP" },
      });
      throw new AppError(429, "RECOVERY_THROTTLED", "Too many requests. Please try again later.");
    }
  }

  const user = await prisma.user.findUnique({ where: { email: input.email } });
  // Unknown / non-cashier / not-ACTIVE accounts: silently do nothing. The caller
  // gets the same generic response as for a real account.
  if (!user || user.role !== "CASHIER" || user.status !== "ACTIVE") return;

  const created = await prisma
    .$transaction(async (tx) => {
      // A lapsed request must not block a fresh one (the partial unique index
      // counts PENDING/APPROVED rows even after their deadline passed).
      await expireStaleRequests(tx, user.id);

      const recent = await tx.cashierRecoveryRequest.count({
        where: { userId: user.id, createdAt: { gte: new Date(now.getTime() - CASHIER_RECOVERY_LIMITS.windowMs) } },
      });
      if (recent >= CASHIER_RECOVERY_LIMITS.perAccountPerHour) return "THROTTLED" as const;

      await tx.cashierRecoveryRequest.create({
        data: {
          userId: user.id,
          createdAt: now,
          // Fixed here, from the same instant as createdAt. Approval never touches it.
          expiresAt: new Date(now.getTime() + CASHIER_RECOVERY_TTL_MS),
          ip: ctx.ip?.slice(0, 64) ?? null,
          userAgent: ctx.userAgent?.slice(0, 255) ?? null,
        },
      });
      return "CREATED" as const;
    })
    .catch((err) => {
      // The partial unique index: an active request already exists (including a
      // concurrent duplicate). Not an error, and not distinguishable by the caller.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") return "DUPLICATE" as const;
      throw err;
    });

  if (created === "CREATED") {
    await recordAudit({
      action: "CASHIER_RECOVERY_REQUESTED",
      actorId: user.id,
      actorRole: "CASHIER",
      shopId: user.shopId,
      entityType: "User",
      entityId: user.id,
    });
  } else if (created === "THROTTLED") {
    await recordAudit({
      action: "CASHIER_RECOVERY_THROTTLED",
      actorId: user.id,
      actorRole: "CASHIER",
      shopId: user.shopId,
      entityType: "User",
      entityId: user.id,
      metadata: { scope: "ACCOUNT" },
    });
  }
}

// ── 2. Central Admin: list / approve / reject ───────────────────────────

const requestInclude = {
  user: {
    select: {
      id: true,
      name: true,
      email: true,
      phone: true,
      branchName: true,
      shop: { select: { id: true, name: true } },
    },
  },
  decidedBy: { select: { id: true, name: true } },
} satisfies Prisma.CashierRecoveryRequestInclude;

type RequestWithRelations = Prisma.CashierRecoveryRequestGetPayload<{ include: typeof requestInclude }>;

/** Admin-facing shape. NEVER includes codeHash, ip or user agent. */
export function toAdminRecoveryRequest(r: RequestWithRelations) {
  return {
    id: r.id,
    status: r.status,
    cashier: {
      id: r.user.id,
      name: r.user.name,
      email: r.user.email,
      phone: r.user.phone,
      branchName: r.user.branchName,
    },
    shop: r.user.shop,
    createdAt: r.createdAt,
    expiresAt: r.expiresAt,
    approvedAt: r.approvedAt,
    rejectedAt: r.rejectedAt,
    completedAt: r.completedAt,
    decidedBy: r.decidedBy,
  };
}

export async function listRecoveryRequests(filter: "active" | "history" | "all") {
  await expireStaleRequests();
  const active: CashierRecoveryStatus[] = ["PENDING", "APPROVED"];
  const rows = await prisma.cashierRecoveryRequest.findMany({
    where:
      filter === "active"
        ? { status: { in: active } }
        : filter === "history"
          ? { status: { notIn: active } }
          : {},
    include: requestInclude,
    orderBy: { createdAt: "desc" },
    take: 200,
  });
  return rows.map(toAdminRecoveryRequest);
}

async function classifyDecisionFailure(requestId: string, verb: "approve" | "reject"): Promise<AppError> {
  const row = await prisma.cashierRecoveryRequest.findUnique({
    where: { id: requestId },
    include: { user: { select: { role: true, status: true } } },
  });
  if (!row) return Errors.notFound("Recovery request not found.", "RECOVERY_REQUEST_NOT_FOUND");
  if (row.status === "EXPIRED" || row.expiresAt <= new Date()) {
    return Errors.conflict("This request has expired. The cashier must submit a new one.", "RECOVERY_REQUEST_EXPIRED");
  }
  if (verb === "approve" && (row.user.role !== "CASHIER" || row.user.status !== "ACTIVE")) {
    return Errors.conflict("This cashier account is no longer active.", "RECOVERY_ACCOUNT_NOT_ACTIVE");
  }
  return Errors.conflict(
    verb === "approve" ? "This request can no longer be approved." : "This request can no longer be rejected.",
    "RECOVERY_REQUEST_NOT_ACTIONABLE"
  );
}

/**
 * Approves a PENDING, unexpired request and returns the one-time code.
 *
 * The state change is ONE conditional UPDATE (status = PENDING AND not expired
 * AND the cashier is still an ACTIVE cashier), so two simultaneous approvals
 * can never both succeed and an expired request can never be approved. The
 * code is generated before the write and exists server-side only in this
 * function's return value; only its keyed hash is persisted. expiresAt is not
 * touched: approval does not restart or extend the deadline.
 *
 * The caller (route) must have already enforced Central Admin + recent
 * password re-authentication.
 */
export async function approveRecoveryRequest(input: {
  requestId: string;
  adminId: string;
  ctx: RecoveryContext;
}): Promise<{ code: string; expiresAt: Date; request: ReturnType<typeof toAdminRecoveryRequest> }> {
  requireCashierRecoveryConfigured();
  await expireStaleRequests();

  const existing = await prisma.cashierRecoveryRequest.findUnique({ where: { id: input.requestId } });
  if (!existing) throw Errors.notFound("Recovery request not found.", "RECOVERY_REQUEST_NOT_FOUND");

  const code = generateCashierRecoveryCode();
  const codeHash = hashCashierRecoveryCode(existing.id, existing.userId, normalizeCashierRecoveryCode(code)!);
  const now = new Date();

  const claimed = await prisma.cashierRecoveryRequest.updateMany({
    where: {
      id: existing.id,
      status: "PENDING",
      expiresAt: { gt: now },
      user: { role: "CASHIER", status: "ACTIVE" },
    },
    data: { status: "APPROVED", approvedAt: now, decidedById: input.adminId, codeHash },
  });
  if (claimed.count !== 1) throw await classifyDecisionFailure(existing.id, "approve");

  const row = await prisma.cashierRecoveryRequest.findUniqueOrThrow({
    where: { id: existing.id },
    include: requestInclude,
  });

  // metadata deliberately has no code/hash.
  await recordAudit({
    action: "CASHIER_RECOVERY_APPROVED",
    actorId: input.adminId,
    actorRole: "ADMIN",
    shopId: row.user.shop?.id ?? null,
    entityType: "CashierRecoveryRequest",
    entityId: row.id,
    metadata: { cashierId: row.userId },
  });

  return { code, expiresAt: row.expiresAt, request: toAdminRecoveryRequest(row) };
}

/** Rejects a PENDING request, or revokes an APPROVED one (e.g. the code was lost). The code hash is erased. */
export async function rejectRecoveryRequest(input: { requestId: string; adminId: string }) {
  await expireStaleRequests();
  const existing = await prisma.cashierRecoveryRequest.findUnique({ where: { id: input.requestId } });
  if (!existing) throw Errors.notFound("Recovery request not found.", "RECOVERY_REQUEST_NOT_FOUND");

  const now = new Date();
  const res = await prisma.cashierRecoveryRequest.updateMany({
    where: { id: existing.id, status: { in: ["PENDING", "APPROVED"] }, expiresAt: { gt: now } },
    data: { status: "REJECTED", rejectedAt: now, decidedById: input.adminId, codeHash: null },
  });
  if (res.count !== 1) throw await classifyDecisionFailure(existing.id, "reject");

  const row = await prisma.cashierRecoveryRequest.findUniqueOrThrow({
    where: { id: existing.id },
    include: requestInclude,
  });
  await recordAudit({
    action: "CASHIER_RECOVERY_REJECTED",
    actorId: input.adminId,
    actorRole: "ADMIN",
    shopId: row.user.shop?.id ?? null,
    entityType: "CashierRecoveryRequest",
    entityId: row.id,
    metadata: { cashierId: row.userId },
  });
  return toAdminRecoveryRequest(row);
}

// ── 3. Public: redeem the code and set a new password ───────────────────

/**
 * Atomic reset. Order matters:
 *  1. Throttle check BEFORE any verification (same durable ledger and policy as
 *     Admin recovery: 5 free failures / 15 min per account, 20 / hour per IP).
 *  2. Password policy is checked FIRST and independently of the account, so a
 *     weak password never burns the code and reveals nothing about the account.
 *  3. The bcrypt hash is computed for EVERY request (known or not) so response
 *     time does not depend on whether the account exists.
 *  4. One transaction: claim the request (conditional UPDATE that only matches
 *     an APPROVED, unexpired, unconsumed request whose code hash matches), write
 *     the new password hash, revoke every session. All commit or none do.
 *
 * Every failure — unknown email, wrong code, reused code, expired or rejected
 * request, ineligible account — returns the same 400.
 */
export async function resetPasswordWithCode(input: {
  email: string;
  code: unknown;
  newPassword: string;
  ctx: RecoveryContext;
}): Promise<void> {
  requireCashierRecoveryConfigured();
  const { ctx } = input;
  const subjectHash = hashRecoverySubject(input.email);

  const decision = await checkRecoveryThrottle({ subjectHash, ip: ctx.ip });
  if (decision.blocked) {
    await recordThrottledAttempt({ subjectHash, ip: ctx.ip, userAgent: ctx.userAgent }, decision, prisma);
    throw new AppError(
      429,
      "RECOVERY_THROTTLED",
      `Too many attempts. Please try again in ${decision.retryAfterSeconds} seconds.`
    );
  }

  if (!isPasswordStrongEnough(input.newPassword)) {
    throw Errors.validation("Password must be at least 8 characters and include a letter and a number.");
  }
  const passwordHash = await hashPassword(input.newPassword);
  const normalized = normalizeCashierRecoveryCode(input.code);

  const user = await prisma.user.findUnique({ where: { email: input.email } });
  const eligible = !!user && user.role === "CASHIER" && user.status === "ACTIVE";
  const now = new Date();

  const request =
    eligible && user
      ? await prisma.cashierRecoveryRequest.findFirst({
          where: { userId: user.id, status: "APPROVED", expiresAt: { gt: now }, consumedAt: null },
          orderBy: { createdAt: "desc" },
        })
      : null;

  const completed = await prisma.$transaction(async (tx) => {
    const usable = eligible && user && request && normalized;
    // Unusable inputs run the same conditional UPDATE against a nil id, so both
    // paths cost the same database work.
    const claim = await tx.cashierRecoveryRequest.updateMany({
      where: usable
        ? {
            id: request!.id,
            userId: user!.id,
            status: "APPROVED",
            codeHash: hashCashierRecoveryCode(request!.id, user!.id, normalized!),
            consumedAt: null,
            expiresAt: { gt: now },
          }
        : { id: NIL_UUID },
      data: { status: "COMPLETED", consumedAt: now, completedAt: now, codeHash: null },
    });
    if (claim.count !== 1 || !usable) return false;

    await tx.user.update({ where: { id: user!.id }, data: { passwordHash } });
    // Kills every already-issued JWT for this cashier immediately (plugins/auth.ts
    // checks the session row on every request).
    await tx.session.updateMany({
      where: { userId: user!.id, revokedAt: null },
      data: { revokedAt: now },
    });
    return true;
  });

  if (!completed) {
    await recordFailedCodeVerification({
      userId: eligible ? user!.id : null,
      subjectHash,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
    if (request) {
      await prisma.cashierRecoveryRequest.updateMany({
        where: { id: request.id },
        data: { failedAttempts: { increment: 1 } },
      });
    }
    if (eligible && user) {
      await recordAudit({
        action: "CASHIER_RECOVERY_FAILED",
        actorId: user.id,
        actorRole: "CASHIER",
        shopId: user.shopId,
        entityType: "User",
        entityId: user.id,
      });
    }
    throw verificationFailed();
  }

  await recordAudit({
    action: "CASHIER_RECOVERY_COMPLETED",
    actorId: user!.id,
    actorRole: "CASHIER",
    shopId: user!.shopId,
    entityType: "CashierRecoveryRequest",
    entityId: request!.id,
    metadata: { sessionsRevoked: true },
  });
}
