/**
 * Test fixture: provisions an Admin + shop directly in the database, the way an
 * operator (prisma/seed.ts) would. POST /api/auth/admin/signup no longer creates
 * Admin accounts (it is now an authenticated "add a shop to my own account"
 * endpoint), so tests that need an Admin must not use it as a factory.
 */
import type { FastifyInstance } from "fastify";
import { prisma } from "../src/lib/prisma.js";
import { hashPassword } from "../src/lib/password.js";
import { resolveOrCreateShopByLocation, ensureAdminShopLink } from "../src/lib/shopAccess.js";

export async function createAdminFixture(
  app: FastifyInstance,
  opts: { email: string; password?: string; shopLocation: string; name?: string }
) {
  const password = opts.password ?? "Password123";
  const { shop } = await resolveOrCreateShopByLocation(opts.shopLocation);
  let admin = await prisma.user.findUnique({ where: { email: opts.email } });
  if (!admin) {
    admin = await prisma.user.create({
      data: {
        name: opts.name ?? "Admin",
        email: opts.email,
        passwordHash: await hashPassword(password),
        role: "ADMIN",
        status: "ACTIVE",
        shopId: shop.id,
      },
    });
  }
  await ensureAdminShopLink(admin.id, shop.id);
  const res = await app.inject({
    method: "POST",
    url: "/api/auth/admin/login",
    payload: { email: opts.email, password },
  });
  if (res.statusCode >= 400) throw new Error(`fixture admin login failed (${res.statusCode}): ${res.payload}`);
  const { token } = JSON.parse(res.payload) as { token: string };
  return {
    token,
    user: { id: admin.id },
    shop: { id: shop.id, name: shop.name, code: shop.code, location: shop.location },
  };
}
