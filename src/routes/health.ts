import type { FastifyInstance } from "fastify";
import { prisma } from "../lib/prisma.js";

export default async function healthRoutes(fastify: FastifyInstance) {
  fastify.get("/health", async (_request, reply) => {
    try {
      await prisma.$queryRaw`SELECT 1`;
    } catch {
      return reply.code(503).send({ success: false, data: null, message: "Database unreachable." });
    }
    return { success: true, data: null, message: "Backend is healthy" };
  });
}
