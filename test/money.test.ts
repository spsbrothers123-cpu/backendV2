import { describe, expect, it } from "vitest";
import { toDecimal, add, sub, mul, round2, equalsMoney, toNumber, ZERO } from "../src/lib/money.js";

describe("money helpers", () => {
  it("adds decimals without floating point drift", () => {
    // 0.1 + 0.2 famously != 0.3 in JS floats — Decimal must not have that problem.
    const sum = add(toDecimal(0.1), toDecimal(0.2));
    expect(toNumber(round2(sum))).toBe(0.3);
  });

  it("rounds half-up to 2 decimal places", () => {
    expect(toNumber(round2(toDecimal(10.005)))).toBe(10.01);
    expect(toNumber(round2(toDecimal(10.004)))).toBe(10.0);
  });

  it("multiplies price by integer quantity precisely", () => {
    const lineTotal = mul(toDecimal(19.99), 3);
    expect(toNumber(round2(lineTotal))).toBe(59.97);
  });

  it("equalsMoney compares at 2dp regardless of trailing precision", () => {
    expect(equalsMoney(toDecimal(400), add(toDecimal(399.999), toDecimal(0.001)))).toBe(true);
    expect(equalsMoney(toDecimal(400), toDecimal(400.02))).toBe(false);
  });

  it("subtracts and floors at zero correctly", () => {
    expect(toNumber(sub(toDecimal(50), toDecimal(50)))).toBe(0);
    expect(toNumber(ZERO)).toBe(0);
  });
});
