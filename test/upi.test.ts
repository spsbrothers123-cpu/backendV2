import { describe, expect, it } from "vitest";
import {
  maskUpiId,
  normalizeUpiId,
  resolveEffectiveReceiver,
  validatePayeeName,
  validateUpiId,
} from "../src/lib/upi.js";

const common = { upiId: "shop@okbank", payeeName: "RBR Egg Mart", enabled: true };
const custom = (over: Partial<Parameters<typeof resolveEffectiveReceiver>[1] & object> = {}) => ({
  mode: "CUSTOM" as const,
  customUpiId: "veera@oksbi",
  customPayeeName: "Veerapandi Branch",
  customEnabled: true,
  ...over,
});

describe("validateUpiId / validatePayeeName", () => {
  it("accepts well-formed UPI IDs and rejects malformed ones", () => {
    for (const ok of ["name@okbank", "a.b-c_d@ybl", " Name@OkBank ", "98765@paytm"]) {
      expect(validateUpiId(ok)).toBeNull();
    }
    for (const bad of ["", "   ", "noatsign", "@bank", "a@", "a@b", "a b@bank", "a@@bank", "a@bank1", "x@ba nk"]) {
      expect(validateUpiId(bad), bad).not.toBeNull();
    }
  });

  it("enforces payee name length and rejects control characters", () => {
    expect(validatePayeeName("RBR")).toBeNull();
    expect(validatePayeeName("A")).not.toBeNull();
    expect(validatePayeeName("   ")).not.toBeNull();
    expect(validatePayeeName("x".repeat(50))).toBeNull();
    expect(validatePayeeName("x".repeat(51))).not.toBeNull();
    expect(validatePayeeName("Bad\u0000Name")).not.toBeNull();
    expect(validatePayeeName("Bad\nName")).not.toBeNull();
  });

  it("normalizes UPI IDs to trimmed lower-case and masks them for audit", () => {
    expect(normalizeUpiId("  Name@OkBank ")).toBe("name@okbank");
    expect(maskUpiId("name@okbank")).toBe("na***@okbank");
    expect(maskUpiId("garbage")).toBe("***");
  });
});

describe("resolveEffectiveReceiver", () => {
  it("prefers an enabled custom shop account over the common account", () => {
    const r = resolveEffectiveReceiver(common, custom());
    expect(r).toEqual({ source: "SHOP", upiId: "veera@oksbi", payeeName: "Veerapandi Branch", reason: null });
  });

  it("uses the common account when the shop has no row or is in COMMON mode", () => {
    expect(resolveEffectiveReceiver(common, null).source).toBe("COMMON");
    expect(resolveEffectiveReceiver(common, null).reason).toBeNull();
    expect(resolveEffectiveReceiver(common, { mode: "COMMON", customUpiId: null, customPayeeName: null, customEnabled: false }).source).toBe("COMMON");
  });

  it("never uses dormant custom details while mode is COMMON", () => {
    const r = resolveEffectiveReceiver(common, custom({ mode: "COMMON" }));
    expect(r.source).toBe("COMMON");
    expect(r.upiId).toBe("shop@okbank");
  });

  it("falls back to common (with a reason) when custom is selected but disabled or incomplete", () => {
    const disabled = resolveEffectiveReceiver(common, custom({ customEnabled: false }));
    expect(disabled.source).toBe("COMMON");
    expect(disabled.reason).toMatch(/disabled/);
    const incomplete = resolveEffectiveReceiver(common, custom({ customPayeeName: null }));
    expect(incomplete.source).toBe("COMMON");
    expect(incomplete.reason).toMatch(/incomplete/);
  });

  it("returns NONE (never a guess) when nothing usable is configured", () => {
    for (const [c, s] of [
      [null, null],
      [{ ...common, enabled: false }, null],
      [null, custom({ customEnabled: false })],
      [{ ...common, enabled: false }, custom({ customEnabled: false })],
      [{ ...common, upiId: "broken" }, null],
    ] as const) {
      const r = resolveEffectiveReceiver(c, s);
      expect(r.source).toBe("NONE");
      expect(r.upiId).toBeNull();
      expect(r.payeeName).toBeNull();
      expect(r.reason).toBeTruthy();
    }
  });

  it("disabled common with a working custom account still resolves to the custom account", () => {
    expect(resolveEffectiveReceiver({ ...common, enabled: false }, custom()).source).toBe("SHOP");
  });
});
