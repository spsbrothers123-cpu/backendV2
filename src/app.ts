import Fastify, { type FastifyInstance, type FastifyError } from "fastify";
import cors from "@fastify/cors";
import sensible from "@fastify/sensible";
import rateLimit from "@fastify/rate-limit";
import { ZodError } from "zod";
import { env } from "./config/env.js";
import { AppError } from "./lib/errors.js";
import authPlugin from "./plugins/auth.js";
import healthRoutes from "./routes/health.js";
import authRoutes from "./routes/auth.js";
import cashierRequestsRoutes from "./routes/admin/cashierRequests.js";
import cashiersRoutes from "./routes/admin/cashiers.js";
import adminInvitationCodesRoutes from "./routes/admin/invitationCodes.js";
import adminShopsRoutes from "./routes/admin/shops.js";

// Cashier-facing (bare paths — matches the Cashier app's stub API contract)
import productsRoutes from "./routes/products.js";
import customersRoutes from "./routes/customers.js";
import sessionsRoutes from "./routes/sessions.js";
import billsRoutes from "./routes/bills.js";
import reportsRoutes from "./routes/reports.js";

// Admin-facing (/admin/* — matches the Admin app's stub API contract)
import adminProductsRoutes from "./routes/admin/products.js";
import adminCustomersRoutes from "./routes/admin/customers.js";
import adminInventoryRoutes from "./routes/admin/inventory.js";
import adminPurchasesRoutes from "./routes/admin/purchases.js";
import adminExpensesRoutes from "./routes/admin/expenses.js";
import adminCreditsRoutes from "./routes/admin/credits.js";
import adminSessionsRoutes from "./routes/admin/sessions.js";
import adminReportsRoutes from "./routes/admin/reports.js";
import adminHistoryRoutes from "./routes/admin/history.js";
import adminDashboardRoutes from "./routes/admin/dashboard.js";
import adminNotificationsRoutes from "./routes/admin/notifications.js";
import adminProfileRoutes from "./routes/admin/profile.js";
import adminSearchRoutes from "./routes/admin/search.js";
import adminSettingsRoutes from "./routes/admin/settings.js";

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger:
      env.NODE_ENV === "development"
        ? { transport: { target: "pino-pretty", options: { translateTime: "HH:MM:ss", ignore: "pid,hostname" } } }
        : true,
    trustProxy: true,
  });

  // ── CORS ────────────────────────────────────────────────────────────
  // Never "*" for authenticated production APIs — origins come from env,
  // and dev defaults cover both the Admin (5173) and Cashier (5174) apps.
  await app.register(cors, {
    origin: env.CORS_ORIGINS_LIST,
    credentials: true,
    // Export downloads read their filename off this header — without
    // exposing it, browsers hide it from the frontend's response object.
    exposedHeaders: ["Content-Disposition"],
  });

  await app.register(sensible);

  // ── Global rate limiting; auth routes tighten this further per-route ──
  await app.register(rateLimit, {
    max: 100,
    timeWindow: "1 minute",
  });

  await app.register(authPlugin);

  // ── Routes ──────────────────────────────────────────────────────────
  await app.register(healthRoutes);
  await app.register(authRoutes, { prefix: "/api/auth" });
  await app.register(cashierRequestsRoutes, { prefix: "/api/admin/cashier-requests" });
  await app.register(cashiersRoutes, { prefix: "/api/admin/cashiers" });
  await app.register(adminInvitationCodesRoutes, { prefix: "/api/admin/invitation-codes" });
  await app.register(adminShopsRoutes, { prefix: "/api/admin/shops" });

  // Phase 2 — Cashier app
  await app.register(productsRoutes, { prefix: "/api/products" });
  await app.register(customersRoutes, { prefix: "/api/customers" });
  await app.register(sessionsRoutes, { prefix: "/api/sessions" });
  await app.register(billsRoutes, { prefix: "/api/bills" });
  await app.register(reportsRoutes, { prefix: "/api/reports" });

  // Phase 2 — Admin app
  await app.register(adminProductsRoutes, { prefix: "/api/admin/products" });
  await app.register(adminCustomersRoutes, { prefix: "/api/admin/customers" });
  await app.register(adminInventoryRoutes, { prefix: "/api/admin/inventory" });
  await app.register(adminPurchasesRoutes, { prefix: "/api/admin/purchases" });
  await app.register(adminExpensesRoutes, { prefix: "/api/admin/expenses" });
  await app.register(adminCreditsRoutes, { prefix: "/api/admin/credits" });
  await app.register(adminSessionsRoutes, { prefix: "/api/admin/sessions" });
  await app.register(adminReportsRoutes, { prefix: "/api/admin/reports" });
  await app.register(adminHistoryRoutes, { prefix: "/api/admin/history" });
  await app.register(adminDashboardRoutes, { prefix: "/api/admin/dashboard" });
  await app.register(adminNotificationsRoutes, { prefix: "/api/admin/notifications" });
  await app.register(adminProfileRoutes, { prefix: "/api/admin/profile" });
  await app.register(adminSearchRoutes, { prefix: "/api/admin/search" });
  await app.register(adminSettingsRoutes, { prefix: "/api/admin/settings" });

  // ── Centralized error handling — every route throws, nothing formats
  // its own error response, so the JSON body shape is consistent everywhere.
  app.setErrorHandler((error: FastifyError | AppError, request, reply) => {
    if (error instanceof AppError) {
      return reply.code(error.statusCode).send({ success: false, message: error.message, code: error.code });
    }
    if (error instanceof ZodError) {
      return reply.code(422).send({ success: false, message: "Validation failed.", code: "VALIDATION_ERROR" });
    }
    if (error.statusCode === 429) {
      return reply
        .code(429)
        .send({ success: false, message: "Too many requests. Please try again later.", code: "RATE_LIMITED" });
    }
    // fastify-sensible / built-in HTTP errors (400s from schema validation, etc.)
    if (error.statusCode && error.statusCode < 500) {
      return reply
        .code(error.statusCode)
        .send({ success: false, message: error.message, code: "REQUEST_ERROR" });
    }

    request.log.error(error);
    return reply
      .code(500)
      .send({ success: false, message: "Something went wrong on our end. Please try again.", code: "INTERNAL_ERROR" });
  });

  app.setNotFoundHandler((_request, reply) => {
    reply.code(404).send({ success: false, message: "Not found.", code: "NOT_FOUND" });
  });

  return app;
}
