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
  // Required for every new cashier registration (Backend spec §4). Not
  // enforced as NOT NULL at the DB level (see the branchName migration) —
  // this is where "required for new signups" actually lives.
  branchName: z.string().trim().min(1, "Branch name is required.").max(120),
  verificationToken: z.string().trim().min(1, "verificationToken is required."),
});

const signupStatusQuerySchema = z.object({
  requestId: z.string().trim().min(1, "requestId is required."),
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
const authRateLimit = (max: number, timeWindow: string) =>
  env.NODE_ENV === "test" ? { rateLimit: false as const } : { rateLimit: { max, timeWindow } };

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

      const shop = await prisma.shop.findUnique({ where: { id: invitation.shopId } });
      if (!shop) {
        throw Errors.internal("The shop for this invitation code no longer exists.");
      }

      const verificationToken = signInvitationToken(invitation.id, invitation.shopId);

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

        const invitation = await tx.invitationCode.findUniqueOrThrow({ where: { id: tokenPayload.invitationId } });
        const shop = await tx.shop.findUnique({ where: { id: invitation.shopId } });
        if (!shop) {
          throw Errors.internal("The shop for this invitation code no longer exists.");
        }

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
                branchName: body.branchName,
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
                branchName: body.branchName,
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

  // ── POST /api/auth/admin/signup — create/extend an Admin account ────
  // Body: { name, email, password, shopLocation }. Resolves-or-creates the
  // Shop for shopLocation (dedup by normalized location — Phase 1 spec
  // §2/§3) and links it to the admin.
  //
  // Two cases, both handled here so "a single Admin can manage multiple
  // shops" (Phase 1 spec §objective) doesn't require a second endpoint:
  //   - New email → creates a new ADMIN user, active immediately (matching
  //     this app's existing "admins aren't approval-gated" policy), with
  //     this as their first/active shop.
  //   - Email already belongs to an ACTIVE admin, password matches → adds
  //     this shop to that admin's owned set (AdminShopLink) WITHOUT
  //     creating a second account and WITHOUT changing which shop is
  //     currently their active one (see POST /admin/shops/switch for
  //     that). Password is re-checked here specifically because this
  //     endpoint is unauthenticated — knowing someone's admin email alone
  //     must never be enough to attach a shop to their account.
  // An email belonging to a CASHIER, or a wrong password on an existing
  // admin email, is rejected the same way (no hint as to which).
  fastify.post(
    "/admin/signup",
    { config: authRateLimit(10, "10 minutes") },
    async (request, reply) => {
      const body = parseBody(adminSignupSchema, request.body);

      if (!isPasswordStrongEnough(body.password)) {
        throw Errors.validation("Password must be at least 8 characters and include a letter and a number.");
      }

      const existing = await prisma.user.findUnique({ where: { email: body.email } });

      if (existing && existing.role !== "ADMIN") {
        throw Errors.conflict("An account with this email already exists.", "ACCOUNT_ALREADY_EXISTS");
      }

      if (existing) {
        const passwordOk = await verifyPassword(body.password, existing.passwordHash);
        if (!passwordOk) {
          throw Errors.unauthorized("Invalid email or password.", "INVALID_CREDENTIALS");
        }
        if (existing.status !== "ACTIVE") {
          throw Errors.forbidden("This admin account is not active.", "ACCOUNT_NOT_ACTIVE");
        }
      }

      const passwordHash = existing ? existing.passwordHash : await hashPassword(body.password);

      // Not wrapped in a single DB transaction: resolveOrCreateShopByLocation
      // and ensureAdminShopLink are each independently race-safe (unique
      // constraint + catch-and-refetch — see shopAccess.ts), so sequencing
      // them plainly is both simpler and no less safe than a transaction
      // that couldn't actually span them atomically anyway.
      const { shop, created: shopCreated } = await resolveOrCreateShopByLocation(body.shopLocation);

      const admin = existing
        ? existing
        : await prisma.user
            .create({
              data: {
                name: body.name,
                email: body.email,
                passwordHash,
                role: "ADMIN",
                status: "ACTIVE",
                shopId: shop.id,
              },
            })
            // Two simultaneous signups for the same brand-new email: the
            // loser hits the unique constraint on email rather than a
            // generic 500 (mirrors the "account already exists" message
            // the earlier findUnique check would have given the loser had
            // it run a moment later).
             .catch((err) => {
              if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
                throw Errors.conflict("An account with this email already exists.", "ACCOUNT_ALREADY_EXISTS");
              }
              throw err;
            });

      const { linked } = await ensureAdminShopLink(admin.id, shop.id);

      const result = { admin, shop, shopCreated, linked, isNewAdmin: !existing };

      if (result.isNewAdmin) {
        await recordAudit({
          action: "ADMIN_SIGNUP",
          actorId: result.admin.id,
          actorRole: "ADMIN",
          shopId: result.shop.id,
          entityType: "User",
          entityId: result.admin.id,
        });
      }
      if (result.shopCreated) {
        await recordAudit({
          action: "SHOP_CREATED",
          actorId: result.admin.id,
          actorRole: "ADMIN",
          shopId: result.shop.id,
          entityType: "Shop",
          entityId: result.shop.id,
        });
      }
      if (result.linked && !result.isNewAdmin) {
        await recordAudit({
          action: "SHOP_LINKED",
          actorId: result.admin.id,
          actorRole: "ADMIN",
          shopId: result.shop.id,
          entityType: "Shop",
          entityId: result.shop.id,
        });
      }

      const token = await issueSession(result.admin.id, "ADMIN", request);
      await prisma.user.update({ where: { id: result.admin.id }, data: { lastLoginAt: new Date() } });

      return reply.code(result.isNewAdmin ? 201 : 200).send({
        token,
        user: toPublicAdminUser(result.admin),
        shop: {
          id: result.shop.id,
          name: result.shop.name,
          code: result.shop.code,
          location: result.shop.location,
        },
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