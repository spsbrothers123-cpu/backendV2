import type { Role, User, Shop } from "@prisma/client";

/**
 * Shapes here are dictated by the two frontends' own type definitions
 * (Admin2_0/src/types/index.ts `AdminUser`, Cashier2_0/src/types/index.js
 * `@typedef Cashier`) — NOT by this backend's internal Prisma models.
 * Never leak passwordHash or any signup-verification data through these.
 */

export function toPublicRole(role: Role): "admin" | "cashier" {
  return role === "ADMIN" ? "admin" : "cashier";
}

export interface PublicAdminUser {
  id: string;
  name: string;
  email: string;
  role: "admin" | "cashier";
}

export function toPublicAdminUser(user: User): PublicAdminUser {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: toPublicRole(user.role),
  };
}

export interface PublicCashier {
  id: string;
  name: string;
  email: string;
  phone?: string;
  branchName?: string;
  role: "admin" | "cashier";
  active: boolean;
  shop: { id: string; name: string; location?: string } | null;
}

export function toPublicCashier(user: User & { shop: Shop | null }): PublicCashier {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    phone: user.phone ?? undefined,
    branchName: user.branchName ?? undefined,
    role: toPublicRole(user.role),
    active: user.status === "ACTIVE",
    shop: user.shop ? { id: user.shop.id, name: user.shop.name, location: user.shop.location ?? undefined } : null,
  };
}
