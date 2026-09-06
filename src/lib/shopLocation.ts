/**
 * Multi-shop foundation (RBR Egg Mart Phase 1) — pure location-normalization
 * logic, deliberately kept free of any prisma import (see lib/shopAccess.ts,
 * which does the actual database work) so it can be unit-tested without a
 * database, the same way lib/invitationCode.ts is.
 */

// The task spec names the brand "RBR Egg Mart" explicitly ("Shop Location:
// Veerapandi → RBR Egg Mart - Veerapandi"), which is a different display
// name than the existing seeded shop ("Egg Mart — Main Branch" — see
// prisma/seed.ts). Kept as one named constant, deliberately not touching
// the legacy seeded shop's name, so it's a one-line change if the brand
// text ever needs to move.
export const SHOP_BRAND_NAME = "RBR Egg Mart";

export interface NormalizedShopLocation {
  /** Raw, human-readable form stored on Shop.location and used in the display name, e.g. "Veerapandi". */
  location: string;
  /** Deterministic dedup key stored on Shop.code (unique), e.g. "VEERAPANDI". */
  code: string;
}

export class InvalidShopLocationError extends Error {}

/**
 * Normalizes a free-text "Shop Location" string so that trivial formatting
 * differences ("Veerapandi", " veerapandi ", "VEERAPANDI") all resolve to
 * the same shop, per Phase 1 spec §3 (Prevent Duplicate Shops).
 *
 * Trade-off, by design: this also means two genuinely different locations
 * that happen to normalize to the same code (e.g. differing only in
 * punctuation) will collide into one shop. That's the same trade-off the
 * spec's own dedup requirement implies — there's no way to distinguish
 * "same place, typed differently" from "different place, similarly named"
 * from the string alone.
 *
 * Throws InvalidShopLocationError (not the shared Errors.validation) so
 * this module never needs to import anything outside itself — callers with
 * access to the HTTP error helpers translate it at the boundary.
 */
export function normalizeShopLocation(raw: string): NormalizedShopLocation {
  const location = raw.trim().replace(/\s+/g, " ");
  if (!location) {
    throw new InvalidShopLocationError("Shop location is required.");
  }
  if (location.length > 120) {
    throw new InvalidShopLocationError("Shop location must be 120 characters or fewer.");
  }

  const code = location
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");

  if (!code) {
    throw new InvalidShopLocationError("Shop location must contain at least one letter or number.");
  }

  return { location, code };
}

export function shopDisplayName(location: string): string {
  return `${SHOP_BRAND_NAME} - ${location}`;
}
