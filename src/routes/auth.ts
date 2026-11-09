import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { Errors } from "../lib/errors.js";
import { parseBody } from "../lib/validate.js";
import { hashPassword, verifyPassword, isPasswordStrongEnough } from "../lib/password.js";
import { hashInvitationCode, invitationCodeMatches, maskInvitationCode } from "../lib/invitationCode.js";
import { signInvitationToken, verifyInvitationToken } from "../lib/invitationToken.js";
import { recordAudit } from "../lib/audit.js";
import { issueSession, revokeSession } from "../lib/session.js";
import { toPublicAdminUser, toPublicCashier } from "../lib/serializers.js";
import { env } from "../config/env.js";
import { resolveOrCreateShopByLocation, ensureAdminShopLink } from "../lib/shopAccess.js";
import { normalizeShopLocation, InvalidShopLocationError } from "../lib/shopLocation.js";
import { requireRecentAuth } from "../lib/recentAuth.js";
import { assertBranchCashierSlotFree, lockBranchCashierSlot } from "../lib/branchCashier.js";

const emailSchema = z.string().trim().min(1, "Email is required.").email("Enter a valid email address.");

const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, "Password is required."),
});

// ── Cashier signup — invitation code gated (no email OTP) ────────────────

const verifyInvitationSchema = z.object({
  code: z
    .string()
    .trim()
    .regex(/^\d{6}$/, "Invitation code must be 6 digits."),
});

const registerSchema = z.object({
  name: z.string().trim().min(1, "Name is required.").max(120),
  email: emailSchema,
  password: z.string().min(1, "Password is required."),
  // Phase 2 Stage 2.4: the Cashier SELECTS an existing branch (id from
  // GET /api/auth/branches). Free-text branch names are no longer accepted
  // and never create a branch — only the Central Admin can (POST /api/admin/shops).
  shopId: z.string().trim().min(1, "Select your branch."),
  verificationToken: z.string().trim().min(1, "verificationToken is required."),
});

const signupStatusQuerySchema = z.object({
  requestId: z.string().trim().min(1, "requestId is required."),
});

// ── Forgot Password (legacy email-link flow — DISABLED, see handlers below) ─
// One shared pair of endpoints for both roles: email is globally unique
// across the User table (see schema.prisma), so there's nothing
// role-specific about "look up this email and email it a reset link" —
// only the reset link's destination (Admin app vs Cashier app) differs,
// and that's resolved server-side from the found user's own role, never
// from a role the caller claims.
const forgotPasswordSchema = z.object({
  email: emailSchema,
});

// ── Admin signup — multi-shop foundation (RBR Egg Mart Phase 1) ─────────
// Unlike cashier signup, there was no admin signup endpoint at all before
// this (admins were only ever created via prisma/seed.ts). See this
// repo's README, "Multi-shop foundation", for why this design was chosen
// over reinterpreting the existing invitation-code cashier signup.
const adminSignupSchema = z.object({
  name: z.string().trim().min(1, "Name is required.").max(120),
  email: emailSchema,
  password: z.string().min(1, "Password is required."),
  shopLocation: z.string().trim().min(1, "Shop location is required.").max(120),
});

// In test runs, dozens of auth calls land in the same file's in-memory
// rate-limit bucket (one Fastify instance per file, one client IP via
// app.inject()), so the per-route limits below — sized for real abuse —
// would otherwise starve the test suite itself. Production behavior is
// untouched: `rateLimit: false` is @fastify/rate-limit's documented
// per-route opt-out, applied only when NODE_ENV === "test".
const authRateLimit = (
  max: number,
  timeWindow: string
): { rateLimit: false | { max: number; timeWindow: string } } =>
  env.NODE_ENV === "test" ? { rateLimit: false } : { rateLimit: { max, timeWindow } };

export default async function authRoutes(fastify: FastifyInstance) {
  // ── POST /api/auth/signup/verify-invitation — cashier signup, step 1 ──
  // Validates an admin-issued 6-digit invitation code and, if valid,
  // issues a short-lived single-purpose token the cashier carries into
  // step 2. The frontend never decides validity itself — this is the sole
  // source of truth (Backend spec §9).
  fastify.post(
    "/signup/verify-invitation",
    { config: authRateLimit(5, "10 minutes") },
    async (request) => {
      const body = parseBody(verifyInvitationSchema, request.body);
      const codeHash = hashInvitationCode(body.code);

      // Direct hash lookup — deterministic SHA-256 means a matching row
      // (if any) is found in one indexed query rather than scanning every
      // ACTIVE code across every shop. invitationCodeMatches() below is a
      // second, constant-time confirmation of that match.
      const invitation = await prisma.invitationCode.findFirst({ where: { codeHash } });

      if (!invitation || !invitationCodeMatches(body.code, invitation.codeHash)) {
        throw Errors.badRequest("Invalid invitation code.", "INVALID_INVITATION_CODE");
      }

      if (invitation.status === "USED") {
        throw Errors.conflict("This invitation code has already been used.", "INVITATION_CODE_USED");
      }
      if (invitation.status === "REVOKED") {
        throw Errors.badRequest("This invitation code is no longer valid.", "INVITATION_CODE_REVOKED");
      }
      if (invitation.status === "EXPIRED" || invitation.expiresAt <= new Date()) {
        if (invitation.status === "ACTIVE") {
          await prisma.invitationCode.update({
            where: { id: invitation.id },
            data: { status: "EXPIRED", codePlain: null },
          });
        }
        throw Errors.badRequest(
          "This invitation code has expired. Please ask your Admin for a new one.",
          "INVITATION_CODE_EXPIRED"
        );
      }

      // RBR Egg Mart V2 Phase 1: the invitation carries no shop — it only
      // authorizes registering as a cashier. The shop is resolved later,
      // in POST /signup, from the Branch Name the cashier enters there.
      const verificationToken = signInvitationToken(invitation.id);

      return {
        verificationToken,
        expiresInSeconds: 60 * env.INVITATION_TOKEN_EXPIRY_MINUTES,
      };
    }
  );

  // ── POST /api/auth/signup — cashier signup, step 2 ───────────────────
  fastify.post(
    "/signup",
    { config: authRateLimit(10, "10 minutes") },
    async (request, reply) => {
      const body = parseBody(registerSchema, request.body);

      if (!isPasswordStrongEnough(body.password)) {
        throw Errors.validation("Password must be at least 8 characters and include a letter and a number.");
      }

      let tokenPayload;
      try {
        tokenPayload = verifyInvitationToken(body.verificationToken);
      } catch (reason) {
        if (reason === "EXPIRED") {
          throw Errors.unauthorized(
            "Your invitation verification has expired. Please start over.",
            "INVITATION_VERIFICATION_EXPIRED"
          );
        }
        throw Errors.unauthorized(
          "Your invitation verification is invalid. Please start over.",
          "INVITATION_VERIFICATION_INVALID"
        );
      }

      const existing = await prisma.user.findUnique({ where: { email: body.email } });

      if (existing && existing.role === "CASHIER") {
        if (existing.status === "ACTIVE") {
          throw Errors.conflict("An account with this email already exists.", "ACCOUNT_ALREADY_EXISTS");
        }
        if (existing.status === "PENDING_ADMIN_APPROVAL") {
          throw Errors.conflict("A signup request is already pending.", "REQUEST_ALREADY_PENDING");
        }
        // REJECTED / SUSPENDED: fall through and let them re-apply below,
        // reusing the same user row rather than creating a duplicate one.
      } else if (existing) {
        // Email belongs to a non-cashier (e.g. an admin) account.
        throw Errors.conflict("An account with this email already exists.", "ACCOUNT_ALREADY_EXISTS");
      }

      const passwordHash = await hashPassword(body.password);

      // RBR Egg Mart V2 Phase 2 (Stage 2.4): the Cashier SELECTS an existing
      // branch. A branch is never created (or looked up by typed text) here —
      // only the Central Admin creates branches (POST /api/admin/shops).
      const shop = await prisma.shop.findUnique({ where: { id: body.shopId } });
      if (!shop) {
        throw Errors.notFound("Please select a valid branch.", "BRANCH_NOT_FOUND");
      }
      const displayBranchName = shop.location ?? shop.name;

      // Everything below is one atomic unit: the invitation code can only
      // ever produce ONE successful cashier signup (Backend spec §12/§13).
      // The conditional updateMany is the concurrency guard — of two
      // simultaneous requests racing on the same invitation, only one can
      // ever match `status: "ACTIVE"` and flip it to USED; the loser sees
      // count === 0 and is rejected, with no user ever created for it.
      const result = await prisma.$transaction(async (tx) => {
        const claim = await tx.invitationCode.updateMany({
          where: { id: tokenPayload.invitationId, status: "ACTIVE", expiresAt: { gt: new Date() } },
          data: { status: "USED", usedAt: new Date() },
        });
        if (claim.count === 0) {
          return null;
        }

        // One Cashier per branch (Stage 2.4). Serialised per branch; if the
        // branch is taken this throws and the transaction rolls back — the
        // invitation code stays ACTIVE so it can be used for another branch.
        await lockBranchCashierSlot(tx, shop.id);
        await assertBranchCashierSlotFree(tx, shop.id, existing?.id);

        const invitation = await tx.invitationCode.findUniqueOrThrow({ where: { id: tokenPayload.invitationId } });

        // Reconstruct the masked form from the plaintext code one last
        // time before it's cleared for good — never store/log the full code.
        const invitationCodeMasked = invitation.codePlain ? maskInvitationCode(invitation.codePlain) : null;

        const user = existing
          ? await tx.user.update({
              where: { id: existing.id },
              data: {
                name: body.name,
                passwordHash,
                status: "PENDING_ADMIN_APPROVAL",
                shopId: shop.id,
                branchName: displayBranchName,
                rejectedAt: null,
                rejectedBy: null,
                rejectionReason: null,
                invitationCodeMasked,
              },
            })
          : await tx.user.create({
              data: {
                name: body.name,
                email: body.email,
                passwordHash,
                role: "CASHIER",
                status: "PENDING_ADMIN_APPROVAL",
                shopId: shop.id,
                branchName: displayBranchName,
                invitationCodeMasked,
              },
            });

        await tx.invitationCode.update({
          where: { id: invitation.id },
          data: { usedByUserId: user.id, codePlain: null },
        });

        return { user, shopId: shop.id };
      });

      if (!result) {
        throw Errors.conflict(
          "This invitation code is no longer valid. Please request a new one from your Admin.",
          "INVITATION_ALREADY_USED"
        );
      }

      await recordAudit({
        action: "CASHIER_SIGNUP_REQUESTED",
        actorId: result.user.id,
        actorRole: "CASHIER",
        shopId: result.shopId,
        entityType: "User",
        entityId: result.user.id,
      });
      await recordAudit({
        action: "INVITATION_CODE_USED",
        actorId: result.user.id,
        actorRole: "CASHIER",
        shopId: result.shopId,
        entityType: "InvitationCode",
        entityId: tokenPayload.invitationId,
      });

      // Flat shape — matches Cashier2_0/src/api/auth.js's
      // `const { requestId, email } = await signup(...)`. requestId is the
      // created user's id: there's no separate "signup request" model —
      // the User row's own status IS the request's status.
      return reply.code(201).send({ requestId: result.user.id, email: result.user.email });
    }
  );

  // ── GET /api/auth/branches — branch picker for Cashier signup ──────
  // Public (the Cashier has no account yet) and deliberately minimal: id,
  // display name, location, and whether the branch can still take a Cashier.
  fastify.get("/branches", { config: authRateLimit(60, "10 minutes") }, async () => {
    const [shops, taken] = await Promise.all([
      prisma.shop.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true, location: true } }),
      prisma.user.groupBy({
        by: ["shopId"],
        where: { role: "CASHIER", status: { in: ["ACTIVE", "PENDING_ADMIN_APPROVAL"] }, shopId: { not: null } },
      }),
    ]);
    const takenIds = new Set(taken.map((t) => t.shopId));
    return shops.map((s) => ({ id: s.id, name: s.name, location: s.location, available: !takenIds.has(s.id) }));
  });

  // ── GET /api/auth/signup/status ─────────────────────────────────────
  fastify.get("/signup/status", async (request) => {
    const query = parseBody(signupStatusQuerySchema, request.query);
    const user = await prisma.user.findUnique({ where: { id: query.requestId } });
    if (!user || user.role !== "CASHIER") {
      throw Errors.notFound("We couldn't find that signup request.", "REQUEST_NOT_FOUND");
    }
    return { status: user.status, name: user.name, email: user.email };
  });

  // ── POST /api/auth/login — cashier login (no OTP, no invitation code) ─
  fastify.post(
    "/login",
    { config: authRateLimit(20, "10 minutes") },
    async (request) => {
      const body = parseBody(loginSchema, request.body);
      const user = await prisma.user.findUnique({ where: { email: body.email }, include: { shop: true } });

      const passwordOk = user ? await verifyPassword(body.password, user.passwordHash) : false;
      if (!user || user.role !== "CASHIER" || !passwordOk) {
        await recordAudit({
          action: "LOGIN_FAILED",
          actorRole: "CASHIER",
          metadata: { email: body.email },
        });
        throw Errors.unauthorized("Invalid email or password.", "INVALID_CREDENTIALS");
      }

      switch (user.status) {
        case "PENDING_ADMIN_APPROVAL":
          throw Errors.forbidden("Your account is waiting for admin approval.", "ACCOUNT_PENDING_APPROVAL");
        case "REJECTED":
          throw Errors.forbidden("Your account request was not approved.", "ACCOUNT_REJECTED");
        case "SUSPENDED":
          throw Errors.forbidden("Your account has been suspended.", "ACCOUNT_SUSPENDED");
      }

      const token = await issueSession(user.id, user.role, request);
      await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
      await recordAudit({
        action: "LOGIN",
        actorId: user.id,
        actorRole: user.role,
        shopId: user.shopId,
        entityType: "User",
        entityId: user.id,
      });

      return { token, cashier: toPublicCashier(user) };
    }
  );

  // ── POST /api/auth/admin/signup — an Admin adds a shop to THEIR OWN account ─
  // SECURITY: this endpoint used to be fully unauthenticated — anyone could
  // POST a new email + an existing shopLocation, receive an ACTIVE ADMIN
  // account and be linked to that existing shop. It is now gated:
  //
  //   - Requires a valid ADMIN bearer token (requireRole), same as every
  //     other /admin route.
  //   - It can no longer CREATE Admin accounts at all. Admins are created by
  //     the operator (prisma/seed.ts / database), never through the API, and
  //     there is no public alternative. `email` must be the caller's own.
  //   - The caller's current password is re-verified on this request
  //     (throttled — see lib/recentAuth.ts), so a stolen token alone is not
  //     enough to change which shops an account owns.
  //   - It can create a NEW shop, or attach a shop nobody administers yet, but
  //     it can never link the caller to a shop another Admin already owns.
  //
  // Existing login (/admin/login) and Cashier signup are untouched.
  fastify.post(
    "/admin/signup",
    { preHandler: fastify.requireRole("ADMIN"), config: authRateLimit(10, "10 minutes") },
    async (request, reply) => {
      const body = parseBody(adminSignupSchema, request.body);
      const caller = request.authUser!;

      if (body.email !== caller.email) {
        throw Errors.forbidden(
          "Admin accounts can't be created through this endpoint.",
          "ADMIN_CREATION_DISABLED"
        );
      }

      await requireRecentAuth(caller.id, body.password, {
        ip: request.ip,
        userAgent: request.headers["user-agent"] ?? null,
      });

      let normalizedCode: string;
      try {
        normalizedCode = normalizeShopLocation(body.shopLocation).code;
      } catch (err) {
        if (err instanceof InvalidShopLocationError) {
          throw Errors.validation(`shopLocation: ${err.message}`);
        }
        throw err;
      }

      const existingShop = await prisma.shop.findUnique({ where: { code: normalizedCode } });
      if (existingShop) {
        const callerLink = await prisma.adminShopLink.findUnique({
          where: { adminId_shopId: { adminId: caller.id, shopId: existingShop.id } },
        });
        const callerIsLegacyOwner = caller.shopId === existingShop.id;
        if (!callerLink && !callerIsLegacyOwner) {
          const otherAdmins =
            (await prisma.adminShopLink.count({
              where: { shopId: existingShop.id, adminId: { not: caller.id } },
            })) +
            (await prisma.user.count({
              where: { role: "ADMIN", shopId: existingShop.id, id: { not: caller.id } },
            }));
          if (otherAdmins > 0) {
            throw Errors.forbidden(
              "That shop is already managed by another administrator.",
              "SHOP_OWNED_BY_ANOTHER_ADMIN"
            );
          }
        }
      }

      const { shop, created: shopCreated } = await resolveOrCreateShopByLocation(body.shopLocation);
      const { linked } = await ensureAdminShopLink(caller.id, shop.id);

      if (shopCreated) {
        await recordAudit({
          action: "SHOP_CREATED",
          actorId: caller.id,
          actorRole: "ADMIN",
          shopId: shop.id,
          entityType: "Shop",
          entityId: shop.id,
        });
      }
      if (linked) {
        await recordAudit({
          action: "SHOP_LINKED",
          actorId: caller.id,
          actorRole: "ADMIN",
          shopId: shop.id,
          entityType: "Shop",
          entityId: shop.id,
        });
      }

      const admin = await prisma.user.findUniqueOrThrow({ where: { id: caller.id } });
      return reply.code(200).send({
        user: toPublicAdminUser(admin),
        shop: { id: shop.id, name: shop.name, code: shop.code, location: shop.location },
      });
    }
  );

  // ── POST /api/auth/admin/login ──────────────────────────────────────
  fastify.post(
    "/admin/login",
    { config: authRateLimit(20, "10 minutes") },
    async (request) => {
      const body = parseBody(loginSchema, request.body);
      const user = await prisma.user.findUnique({ where: { email: body.email } });

      const passwordOk = user ? await verifyPassword(body.password, user.passwordHash) : false;
      if (!user || user.role !== "ADMIN" || !passwordOk) {
        await recordAudit({
          action: "LOGIN_FAILED",
          actorRole: "ADMIN",
          metadata: { email: body.email },
        });
        throw Errors.unauthorized("Invalid email or password.", "INVALID_CREDENTIALS");
      }

      if (user.status !== "ACTIVE") {
        throw Errors.forbidden("This admin account is not active.", "ACCOUNT_NOT_ACTIVE");
      }

      const token = await issueSession(user.id, user.role, request);
      await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
      await recordAudit({
        action: "LOGIN",
        actorId: user.id,
        actorRole: user.role,
        shopId: user.shopId,
        entityType: "User",
        entityId: user.id,
      });

      return { token, user: toPublicAdminUser(user) };
    }
  );

  // ── POST /api/auth/forgot-password — DISABLED (all roles) ─────────────
  // The emailed reset link is gone for Cashiers: Cashier recovery is now
  // admin-assisted and in person (routes/cashierRecovery.ts), and Admins use a
  // passkey or recovery code (routes/adminRecovery.ts). This endpoint remains
  // ONLY so old clients get a harmless answer: it sends nothing, issues
  // nothing, and returns the same generic body for every email (no
  // enumeration). There is no fallback and no token path behind it.
  fastify.post(
    "/forgot-password",
    { config: authRateLimit(5, "10 minutes") },
    async (request) => {
      parseBody(forgotPasswordSchema, request.body);
      return {
        success: true,
        data: null,
        message:
          "Password reset by email is no longer available. Cashiers: ask your administrator to verify you in person. Admins: use the Admin recovery page.",
      };
    }
  );

  // ── POST /api/auth/reset-password — DISABLED (all roles) ──────────────
  // Reset-by-token no longer exists. Always refused; no token is inspected, so
  // previously issued emailed links are dead too.
  fastify.post(
    "/reset-password",
    { config: authRateLimit(10, "10 minutes") },
    async () => {
      throw Errors.forbidden(
        "Password reset links are no longer supported. Please use the new account recovery flow.",
        "PASSWORD_RESET_DISABLED"
      );
    }
  );

  // ── GET /api/auth/me — shared by both frontends ─────────────────────
  fastify.get("/me", { preHandler: fastify.authenticate }, async (request) => {
    const user = await prisma.user.findUniqueOrThrow({
      where: { id: request.authUser!.id },
      include: { shop: true },
    });
    return user.role === "ADMIN" ? toPublicAdminUser(user) : toPublicCashier(user);
  });

  // ── POST /api/auth/logout — shared by both frontends ────────────────
  fastify.post("/logout", { preHandler: fastify.authenticate }, async (request, reply) => {
    await revokeSession(request.authJti!);
    await recordAudit({
      action: "LOGOUT",
      actorId: request.authUser!.id,
      actorRole: request.authUser!.role,
      shopId: request.authUser!.shopId,
      entityType: "User",
      entityId: request.authUser!.id,
    });
    return reply.code(200).send({ success: true, data: null, message: "Logged out." });
  });
}