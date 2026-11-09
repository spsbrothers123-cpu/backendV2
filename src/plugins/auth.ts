import fp from "fastify-plugin";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Role, AccountStatus } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { verifyAccessToken } from "../lib/jwt.js";
import { Errors } from "../lib/errors.js";

export interface AuthenticatedUser {
  id: string;
  name: string;
  email: string;
  role: Role;
  status: AccountStatus;
  shopId: string | null;
}

declare module "fastify" {
  interface FastifyRequest {
    authUser?: AuthenticatedUser;
    authJti?: string;
  }
}

/**
 * Resolves identity from the bearer token ONLY. Role, shopId, userId are
 * never trusted from the request body/query — every protected route reads
 * request.authUser, which this plugin populates from the verified token +
 * a fresh database lookup (so a suspended/revoked user is rejected even
 * with a still-valid, unexpired JWT).
 */
async function authenticate(request: FastifyRequest, reply: FastifyReply) {
  const header = request.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) {
    throw Errors.unauthorized("Authentication required.");
  }
  const token = header.slice("Bearer ".length).trim();

  let payload;
  try {
    payload = verifyAccessToken(token);
  } catch {
    throw Errors.unauthorized("Your session has expired. Please sign in again.", "SESSION_EXPIRED");
  }

  const session = await prisma.session.findUnique({ where: { jti: payload.jti } });
  if (!session || session.revokedAt || session.expiresAt < new Date()) {
    throw Errors.unauthorized("Your session has expired. Please sign in again.", "SESSION_EXPIRED");
  }

  const user = await prisma.user.findUnique({ where: { id: payload.sub } });
  if (!user) {
    throw Errors.unauthorized("Your session has expired. Please sign in again.", "SESSION_EXPIRED");
  }
  if (user.status !== "ACTIVE") {
    throw Errors.forbidden("This account is no longer active.", "ACCOUNT_NOT_ACTIVE");
  }

  request.authUser = {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    status: user.status,
    shopId: user.shopId,
  };
  request.authJti = payload.jti;
  void reply;
}

/** preHandler factory: authenticate, then require one of the given roles. */
function requireRole(...roles: Role[]) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    await authenticate(request, reply);
    if (!request.authUser || !roles.includes(request.authUser.role)) {
      throw Errors.forbidden("You don't have permission to do that.", "ROLE_NOT_ALLOWED");
    }
  };
}

export default fp(async function authPlugin(fastify: FastifyInstance) {
  fastify.decorate("authenticate", authenticate);
  fastify.decorate("requireRole", requireRole);
});

declare module "fastify" {
  interface FastifyInstance {
    authenticate: typeof authenticate;
    requireRole: typeof requireRole;
  }
}
