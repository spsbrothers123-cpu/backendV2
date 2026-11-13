import type { NtfCategory } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { AppError, Errors } from "../lib/errors.js";
import { AUDIENCE_CATEGORIES, LOCKED_CATEGORIES, categoryFromSlug, categorySlug, type Audience } from "./constants.js";

export interface PreferenceView {
  category: string;
  enabled: boolean;
  mutable: boolean;
  mandatoryReason?: string;
}

const SECURITY_REASON = "Security notifications cannot be turned off.";

/** D-27: one settings model for both frontends. Security is permanently ON. */
export async function getPreferenceViews(userId: string, audience: Audience): Promise<PreferenceView[]> {
  const rows = await prisma.notificationPreference.findMany({ where: { userId } });
  const byCat = new Map(rows.map((r) => [r.category, r.enabled]));
  return AUDIENCE_CATEGORIES[audience].map((cat) => {
    const locked = LOCKED_CATEGORIES.has(cat);
    return {
      category: categorySlug(audience, cat)!,
      enabled: locked ? true : (byCat.get(cat) ?? true),
      mutable: !locked,
      ...(locked ? { mandatoryReason: SECURITY_REASON } : {}),
    };
  });
}

/**
 * Applies `changes` (slug → enabled).
 *   mode "reject": turning off a locked category is a 403 SETTING_NOT_MUTABLE (Cashier contract).
 *   mode "ignore": a locked category is silently kept ON (Admin contract allows ignore-or-reject).
 * Unknown categories are a 422. Writes happen in one transaction.
 */
export async function applyPreferenceChanges(
  userId: string,
  audience: Audience,
  changes: { slug: string; enabled: boolean }[],
  mode: "reject" | "ignore"
): Promise<void> {
  const resolved: { category: NtfCategory; enabled: boolean }[] = [];
  for (const c of changes) {
    const category = categoryFromSlug(audience, c.slug);
    if (!category || !AUDIENCE_CATEGORIES[audience].includes(category)) {
      throw Errors.validation(`Unknown notification category "${c.slug}".`);
    }
    if (LOCKED_CATEGORIES.has(category)) {
      if (c.enabled === false && mode === "reject") {
        throw new AppError(403, "SETTING_NOT_MUTABLE", SECURITY_REASON);
      }
      continue; // locked: nothing to store, always ON
    }
    resolved.push({ category, enabled: c.enabled });
  }
  if (resolved.length === 0) return;
  await prisma.$transaction(
    resolved.map((r) =>
      prisma.notificationPreference.upsert({
        where: { userId_category: { userId, category: r.category } },
        create: { userId, category: r.category, enabled: r.enabled },
        update: { enabled: r.enabled },
      })
    )
  );
}
