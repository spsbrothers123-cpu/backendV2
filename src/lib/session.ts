import type { FastifyRequest } from "fastify";
import type { Role } from "@prisma/client";
import { prisma } from "./prisma.js";
import { signAccessToken, expiresInToDate } from "./jwt.js";
import { env } from "../config/env.js";

export async function issueSession(userId: string, role: Role, request: FastifyRequest) {
  const { token, jti } = signAccessToken(userId, role);
  await prisma.session.create({
    data: {
      jti,
      userId,
      userAgent: request.headers["user-agent"]?.slice(0, 255),
      ip: request.ip,
      expiresAt: expiresInToDate(env.JWT_EXPIRES_IN),
    },
  });
  return token;
}

export async function revokeSession(jti: string) {
  await prisma.session
    .update({ where: { jti }, data: { revokedAt: new Date() } })
    .catch(() => {
      // Idempotent: logout should never fail the client just because the
      // session row was already gone/revoked.
    });
}
