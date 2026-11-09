import { describe, expect, it } from "vitest";
import {
  normalizeShopLocation,
  shopDisplayName,
  InvalidShopLocationError,
  SHOP_BRAND_NAME,
} from "../src/lib/shopLocation.js";

describe("normalizeShopLocation", () => {
  it("trims and collapses internal whitespace for the display location", () => {
    expect(normalizeShopLocation("  Veerapandi  ").location).toBe("Veerapandi");
    expect(normalizeShopLocation("Veera   Pandi").location).toBe("Veera Pandi");
  });

  it("produces the same dedup code regardless of case or surrounding whitespace", () => {
    const a = normalizeShopLocation("Veerapandi");
    const b = normalizeShopLocation("  veerapandi ");
    const c = normalizeShopLocation("VEERAPANDI");
    expect(a.code).toBe(b.code);
    expect(b.code).toBe(c.code);
    expect(a.code).toBe("VEERAPANDI");
  });

  it("maps different locations to different codes", () => {
    const a = normalizeShopLocation("Veerapandi");
    const b = normalizeShopLocation("Gandhipuram");
    expect(a.code).not.toBe(b.code);
  });

  it("converts non-alphanumeric separators to underscores in the code", () => {
    expect(normalizeShopLocation("R.S. Puram").code).toBe("R_S_PURAM");
  });

  it("rejects an empty or whitespace-only location", () => {
    expect(() => normalizeShopLocation("")).toThrow(InvalidShopLocationError);
    expect(() => normalizeShopLocation("   ")).toThrow(InvalidShopLocationError);
  });

  it("rejects a location longer than 120 characters", () => {
    expect(() => normalizeShopLocation("a".repeat(121))).toThrow(InvalidShopLocationError);
  });

  it("rejects a location with no letters or numbers", () => {
    expect(() => normalizeShopLocation("---")).toThrow(InvalidShopLocationError);
  });
});

describe("shopDisplayName", () => {
  it("prefixes the location with the brand name", () => {
    expect(shopDisplayName("Veerapandi")).toBe(`${SHOP_BRAND_NAME} - Veerapandi`);
    expect(shopDisplayName("Veerapandi")).toBe("RBR Egg Mart - Veerapandi");
  });
});
