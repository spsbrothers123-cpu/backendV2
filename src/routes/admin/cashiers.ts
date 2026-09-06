import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../../lib/prisma.js";
import { Errors } from "../../lib/errors.js";
import { parseBody } from "../../lib/validate.js";
import { recordAudit } from "../../lib/audit.js";
import { toPublicCashier } from "../../lib/serializers.js";

const emailSchema = z.string().trim().min(1, "Email is required.").email("Enter a valid email address.");
// Loose on purpose (digits, spaces, +, -, parens) — this isn't an OTP/SMS
// field, just a contact number an admin can jot down and edit later.
const phoneRegex = /^[0-9+\-\s()]{7,20}$/;

const updateSchema = z.object({
  name: z.string().trim().min(1, "Name is required.").max(120).optional(),
  // "" clears the stored phone number; anything else must look like a phone number.
  phone: z.union([z.string().trim().regex(phoneRegex, "Enter a valid phone number."), z.literal("")]).optional(),
  email: emailSchema.optional(),
  // "" clears the stored branch name; anything else must be non-empty.
  branchName: z.union([z.string().trim().min(1, "Enter a valid branch name.").max(120), z.literal("")]).optional(),
});

const statusSchema = z.object({
  status: z.enum(["ACTIVE", "SUSPENDED"]),
});

export default async function cashiersRoutes(fastify: FastifyInstance) {
  fastify.addHook("preHandler", fastify.requireRole("ADMIN"));

  // ── GET /api/admin/cashiers ──────────────────────────────────────────
  fastify.get("/", async (request) => {
    const admin = request.authUser!;
    const cashiers = await prisma.user.findMany({
      where: { role: "CASHIER", status: "ACTIVE", shopId: admin.shopId ?? undefined },
      include: { shop: true },
      orderBy: { name: "asc" },
    });
    return { success: true, data: cashiers.map(toPublicCashier), message: "Success" };
  });

  // ── GET /api/admin/cashiers/:id ───────────────────────────────────────
  fastify.get<{ Params: { id: string } }>("/:id", async (request) => {
    const admin = request.authUser!;
    const cashier = await prisma.user.findUnique({ where: { id: request.params.id }, include: { shop: true } });
    if (!cashier || cashier.role !== "CASHIER" || cashier.shopId !== admin.shopId) {
      throw Errors.notFound("Cashier not found.", "CASHIER_NOT_FOUND");
    }
    return { success: true, data: toPublicCashier(cashier), message: "Success" };
  });

  // ── PATCH /api/admin/cashiers/:id ─────────────────────────────────────
  fastify.patch<{ Params: { id: string } }>("/:id", async (request) => {
    const admin = request.authUser!;
    const body = parseBody(updateSchema, request.body);

    const existing = await prisma.user.findUnique({ where: { id: request.params.id } });
    if (!existing || existing.role !== "CASHIER" || existing.shopId !== admin.shopId) {
      throw Errors.notFound("Cashier not found.", "CASHIER_NOT_FOUND");
    }

    // User.email is globally unique — check ahead of the update so a
    // collision comes back as a clear 409 instead of a raw DB error.
    if (body.email) {
      const emailOwner = await prisma.user.findUnique({ where: { email: body.email } });
      if (emailOwner && emailOwner.id !== existing.id) {
        throw Errors.conflict("An account with this email already exists.", "EMAIL_ALREADY_EXISTS");
      }
    }

    const updated = await prisma.user.update({
      where: { id: existing.id },
      data: {
        name: body.name,
        phone: body.phone === "" ? null : body.phone,
        email: body.email,
        branchName: body.branchName === "" ? null : body.branchName,
      },
      include: { shop: true },
    });

    await recordAudit({
      action: "CASHIER_UPDATED",
      actorId: admin.id,
      actorRole: "ADMIN",
      shopId: admin.shopId,
      entityType: "User",
      entityId: existing.id,
    });

    return { success: true, data: toPublicCashier(updated), message: "Cashier updated." };
  });

  // ── PATCH /api/admin/cashiers/:id/status ──────────────────────────────
  fastify.patch<{ Params: { id: string } }>("/:id/status", async (request) => {
    const admin = request.authUser!;
    const body = parseBody(statusSchema, request.body);

    const existing = await prisma.user.findUnique({ where: { id: request.params.id } });
    if (!existing || existing.role !== "CASHIER" || existing.shopId !== admin.shopId) {
      throw Errors.notFound("Cashier not found.", "CASHIER_NOT_FOUND");
    }
    if (existing.status !== "ACTIVE" && existing.status !== "SUSPENDED") {
      throw Errors.conflict("Only active or suspended cashiers can have their status changed here.", "INVALID_STATE");
    }

    const updated = await prisma.user.update({
      where: { id: existing.id },
      data: { status: body.status },
      include: { shop: true },
    });

    // Suspending a cashier should also kill any live sessions immediately —
    // otherwise a still-valid JWT would keep working until it expires.
    if (body.status === "SUSPENDED") {
      await prisma.session.updateMany({
        where: { userId: existing.id, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    }

    await recordAudit({
      action: "CASHIER_STATUS_CHANGED",
      actorId: admin.id,
      actorRole: "ADMIN",
      shopId: admin.shopId,
      entityType: "User",
      entityId: existing.id,
      metadata: { status: body.status },
    });

    return { success: true, data: toPublicCashier(updated), message: "Cashier status updated." };
  });
}
