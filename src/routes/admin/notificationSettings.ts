import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { parseBody } from "../../lib/validate.js";
import { centralAdminOnly } from "../../lib/centralAdmin.js";
import { applyPreferenceChanges, getPreferenceViews } from "../../notifications/preferences.js";

const putBody = z.object({
  categories: z
    .array(z.object({ category: z.string().trim().min(1).max(40), enabled: z.boolean() }))
    .min(1)
    .max(20),
});

const LIMIT = { rateLimit: { max: 60, timeWindow: "1 minute" } };

/** D-27: GET/PUT /api/admin/notification-settings. Security stays permanently ON. */
export default async function adminNotificationSettingsRoutes(fastify: FastifyInstance) {
  fastify.addHook("preHandler", fastify.requireRole("ADMIN"));
  fastify.addHook("preHandler", centralAdminOnly("manage notification settings"));

  const view = async (userId: string) => ({
    // Admin contract shape: { category, enabled } — `mutable` is additive and ignored by the client.
    categories: (await getPreferenceViews(userId, "ADMIN")).map((c) => ({ category: c.category, enabled: c.enabled, mutable: c.mutable })),
  });

  fastify.get("/", { config: LIMIT }, async (request) => view(request.authUser!.id));

  fastify.put("/", { config: LIMIT }, async (request) => {
    const userId = request.authUser!.id;
    const body = parseBody(putBody, request.body);
    await applyPreferenceChanges(
      userId,
      "ADMIN",
      body.categories.map((c) => ({ slug: c.category, enabled: c.enabled })),
      "ignore" // contract: "ignore or reject" a `false` for Security — we keep it ON
    );
    return view(userId);
  });
}
