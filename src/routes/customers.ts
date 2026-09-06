import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { Errors } from "../lib/errors.js";
import { parseBody } from "../lib/validate.js";
import { toCashierCustomer } from "../lib/serializeCashier.js";
import { createCustomerForShop } from "../services/customerService.js";

const createCustomerSchema = z.object({
  name: z.string().trim().min(1, "Customer name is required.").max(120),
  phone: z.string().trim().min(1, "Phone number is required.").max(20),
});

export default async function customersRoutes(fastify: FastifyInstance) {
  fastify.addHook("preHandler", fastify.requireRole("CASHIER"));

  // ── GET /api/customers?query= ─────────────────────────────────────────
  fastify.get<{ Querystring: { query?: string } }>("/", async (request) => {
    const shopId = request.authUser!.shopId!;
    const { query } = request.query;
    const customers = await prisma.customer.findMany({
      where: {
        shopId,
        ...(query
          ? { OR: [{ name: { contains: query, mode: "insensitive" } }, { phone: { contains: query } }] }
          : {}),
      },
      orderBy: { name: "asc" },
      take: 50,
    });
    return customers.map(toCashierCustomer);
  });

  // ── POST /api/customers — cashier "Add Customer" ────────────────────
  // Creates the customer in the exact same `customers` table the Admin
  // Customers page reads from (see services/customerService.ts) — there
  // is one customer record, immediately visible to both Cashier and
  // Admin, scoped to the cashier's own shop (never trusted from the
  // request body — see plugins/auth.ts).
  fastify.post("/", async (request, reply) => {
    const cashier = request.authUser!;
    if (!cashier.shopId) {
      // A cashier not yet associated with a shop has no ownership scope
      // to create a customer under — fail closed rather than guessing.
      throw Errors.forbidden("Your account isn't associated with a shop yet.", "NO_SHOP_ASSIGNED");
    }
    const body = parseBody(createCustomerSchema, request.body);

    const customer = await createCustomerForShop({
      shopId: cashier.shopId,
      name: body.name,
      phone: body.phone,
      actorId: cashier.id,
      actorRole: "CASHIER",
    });

    return reply.code(201).send(toCashierCustomer(customer));
  });
}
