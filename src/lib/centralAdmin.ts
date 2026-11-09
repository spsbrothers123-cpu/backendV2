import { env } from "../config/env.js";
import { AppError } from "./errors.js";
import type { AuthenticatedUser } from "../plugins/auth.js";

/**
 * Central Admin authorization for Cashier password recovery.
 *
 * Egg Mart has ONE central Admin who manages every Cashier at every shop.
 * That Admin is identified by a stable user id supplied through the
 * CENTRAL_ADMIN_USER_ID environment variable — never by role alone (other
 * ADMIN rows may exist, e.g. one per historic shop owner), never by email,
 * and never by "whichever admin signed up first".
 *
 * Fails CLOSED: with no configured id nobody — not even an ADMIN — can
 * manage recovery requests, so a missing setting can never widen access.
 *
 * Deliberately independent of AdminShopLink / the currently selected shop:
 * the Central Admin sees recovery requests from every shop.
 */
export function isConfiguredCentralAdminId(userId: string): boolean {
  const configured = env.CENTRAL_ADMIN_USER_ID;
  return !!configured && configured.toLowerCase() === userId.toLowerCase();
}

export function assertCentralAdmin(user: AuthenticatedUser | undefined): asserts user is AuthenticatedUser {
  if (!env.CENTRAL_ADMIN_USER_ID) {
    throw new AppError(
      503,
      "CENTRAL_ADMIN_NOT_CONFIGURED",
      "Cashier recovery management is not available on this server yet."
    );
  }
  if (!user || user.role !== "ADMIN" || user.status !== "ACTIVE" || !isConfiguredCentralAdminId(user.id)) {
    throw new AppError(
      403,
      "CENTRAL_ADMIN_REQUIRED",
      "Only the central administrator can manage cashier recovery requests."
    );
  }
}

/**
 * Phase 2 Stage 2.4 — Central Admin authorization for CATALOG / STOCK / PRICE
 * writes (product create/edit/delete, stock adjustments, purchases, branch
 * assignment, branch creation). Same identity rule and same fail-closed
 * behaviour as assertCentralAdmin; only the messages differ so the caller
 * learns which action was refused. Other ADMIN accounts keep read access to
 * their own shops but never receive these write permissions.
 */
export function assertCentralAdminFor(user: AuthenticatedUser | undefined, action: string): asserts user is AuthenticatedUser {
  if (!env.CENTRAL_ADMIN_USER_ID) {
    throw new AppError(
      503,
      "CENTRAL_ADMIN_NOT_CONFIGURED",
      "This action isn't available on this server yet — the central administrator has not been configured."
    );
  }
  if (!user || user.role !== "ADMIN" || user.status !== "ACTIVE" || !isConfiguredCentralAdminId(user.id)) {
    throw new AppError(403, "CENTRAL_ADMIN_REQUIRED", `Only the central administrator can ${action}.`);
  }
}

/** Fastify route-level preHandler: `{ preHandler: centralAdminOnly("edit the product catalog") }`. */
export function centralAdminOnly(action: string) {
  return async (request: { authUser?: AuthenticatedUser }) => {
    assertCentralAdminFor(request.authUser, action);
  };
}
