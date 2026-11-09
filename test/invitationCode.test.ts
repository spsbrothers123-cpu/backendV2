import { describe, expect, it } from "vitest";
import {
  generateInvitationCode,
  hashInvitationCode,
  invitationCodeMatches,
  invitationCodeExpiryDate,
  maskInvitationCode,
} from "../src/lib/invitationCode.js";

describe("generateInvitationCode", () => {
  it("generates a 6-digit numeric string", () => {
    const code = generateInvitationCode();
    expect(code).toMatch(/^\d{6}$/);
  });

  it("zero-pads short values so the length is always exact", () => {
    // Run many times since generation is random — every result must be 6 digits.
    for (let i = 0; i < 200; i++) {
      expect(generateInvitationCode()).toHaveLength(6);
    }
  });

  it("is not trivially predictable (no fixed value across calls)", () => {
    const values = new Set(Array.from({ length: 20 }, () => generateInvitationCode()));
    expect(values.size).toBeGreaterThan(1);
  });
});

describe("hashInvitationCode / invitationCodeMatches", () => {
  it("never stores the code in plaintext form as its own hash", () => {
    const code = "123456";
    expect(hashInvitationCode(code)).not.toBe(code);
  });

  it("matches the correct code and rejects an incorrect one", () => {
    const code = generateInvitationCode();
    const hash = hashInvitationCode(code);
    expect(invitationCodeMatches(code, hash)).toBe(true);
    expect(invitationCodeMatches("000000", hash)).toBe(false);
  });

  it("is deterministic (same code always hashes to the same value)", () => {
    const code = "482731";
    expect(hashInvitationCode(code)).toBe(hashInvitationCode(code));
  });
});

describe("invitationCodeExpiryDate", () => {
  it("returns a timestamp in the future", () => {
    expect(invitationCodeExpiryDate().getTime()).toBeGreaterThan(Date.now());
  });
});

describe("maskInvitationCode", () => {
  it("keeps only the last two digits visible", () => {
    expect(maskInvitationCode("482731")).toBe("••••31");
  });
});
