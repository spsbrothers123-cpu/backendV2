import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword, isPasswordStrongEnough } from "../src/lib/password.js";

describe("isPasswordStrongEnough", () => {
  it("rejects passwords under 8 characters", () => {
    expect(isPasswordStrongEnough("ab1")).toBe(false);
  });

  it("rejects passwords with no letter", () => {
    expect(isPasswordStrongEnough("12345678")).toBe(false);
  });

  it("rejects passwords with no number", () => {
    expect(isPasswordStrongEnough("abcdefgh")).toBe(false);
  });

  it("accepts a password with 8+ chars, a letter, and a number", () => {
    expect(isPasswordStrongEnough("password123")).toBe(true);
  });
});

describe("hashPassword / verifyPassword", () => {
  it("hashes a password and verifies it round-trips", async () => {
    const hash = await hashPassword("password123");
    expect(hash).not.toBe("password123");
    expect(await verifyPassword("password123", hash)).toBe(true);
    expect(await verifyPassword("wrongpassword", hash)).toBe(false);
  });
});
