import { describe, expect, it } from "vitest";
import {
  RECOVERY_CODE_BYTES,
  encodeCrockford,
  generateGrantToken,
  generateRecoveryCode,
  hashGrantToken,
  hashRecoveryCode,
  hashRecoverySubject,
  hashUserAgent,
  isWellFormedGrantToken,
  normalizeRecoveryCode,
  requirePepper,
} from "../src/lib/recoveryCrypto.js";

const PEPPER = "unit-test-pepper-0123456789-abcdefghij";
const OTHER_PEPPER = "a-completely-different-pepper-0123456789";
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** Independent decoder (test-only) so the encoder is not validated against itself. */
function decodeCrockford(text: string): Buffer {
  let value = 0;
  let bits = 0;
  const out: number[] = [];
  for (const ch of text) {
    value = (value << 5) | ALPHABET.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
      value &= (1 << bits) - 1;
    }
  }
  return Buffer.from(out);
}

describe("encodeCrockford", () => {
  it("encodes all-zero and all-one bytes to the alphabet's extremes", () => {
    expect(encodeCrockford(new Uint8Array(20))).toBe("0".repeat(32));
    expect(encodeCrockford(new Uint8Array(20).fill(0xff))).toBe("Z".repeat(32));
  });

  it("matches a hand-computed vector for a 5-byte block", () => {
    // 0x00 0x44 0x32 0x14 0xC7 = 00000000 01000100 00110010 00010100 11000111
    //   → 00000 00001 00010 00011 00100 00101 00110 00111 → "01234567"
    expect(encodeCrockford(Uint8Array.from([0x00, 0x44, 0x32, 0x14, 0xc7]))).toBe("01234567");
  });

  it("round-trips arbitrary 20-byte values through an independent decoder", () => {
    for (let i = 0; i < 200; i++) {
      const bytes = Buffer.from(Array.from({ length: 20 }, () => Math.floor(Math.random() * 256)));
      expect(decodeCrockford(encodeCrockford(bytes)).equals(bytes)).toBe(true);
    }
  });
});

describe("generateRecoveryCode", () => {
  it("carries at least 128 bits of entropy (20 bytes = 160 bits → 32 base32 chars)", () => {
    expect(RECOVERY_CODE_BYTES * 8).toBeGreaterThanOrEqual(128);
    const code = generateRecoveryCode();
    expect(code.replace(/-/g, "")).toHaveLength(32);
  });

  it("is displayed as 8 hyphen-separated groups of 4 from the Crockford alphabet", () => {
    expect(generateRecoveryCode()).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){7}$/);
  });

  it("never repeats across a large sample (independent codes)", () => {
    const codes = new Set(Array.from({ length: 5000 }, () => generateRecoveryCode()));
    expect(codes.size).toBe(5000);
  });

  it("uses the whole alphabet roughly uniformly (no obvious bias)", () => {
    const counts = new Map<string, number>();
    const total = 4000 * 32;
    for (let i = 0; i < 4000; i++) {
      for (const ch of generateRecoveryCode().replace(/-/g, "")) counts.set(ch, (counts.get(ch) ?? 0) + 1);
    }
    expect(counts.size).toBe(32);
    const expected = total / 32;
    for (const n of counts.values()) {
      // Very loose bound (~±10%); a biased encoder (e.g. modulo bias) would fall outside it.
      expect(n).toBeGreaterThan(expected * 0.9);
      expect(n).toBeLessThan(expected * 1.1);
    }
  });
});

describe("normalizeRecoveryCode", () => {
  const code = generateRecoveryCode();
  const canonical = code.replace(/-/g, "");

  it("accepts the displayed form and canonicalizes it", () => {
    expect(normalizeRecoveryCode(code)).toBe(canonical);
  });

  it("is case-insensitive and ignores spaces and hyphens", () => {
    expect(normalizeRecoveryCode(code.toLowerCase())).toBe(canonical);
    expect(normalizeRecoveryCode(`  ${code.replace(/-/g, " ")}  `)).toBe(canonical);
    expect(normalizeRecoveryCode(canonical)).toBe(canonical);
  });

  it("applies Crockford look-alike substitutions (O→0, I/L→1)", () => {
    const a = "0".repeat(16) + "1".repeat(16);
    const typed = "O".repeat(16) + "IL".repeat(8);
    expect(normalizeRecoveryCode(typed)).toBe(a);
  });

  it("rejects wrong length, wrong alphabet, non-strings and oversized input", () => {
    expect(normalizeRecoveryCode("")).toBeNull();
    expect(normalizeRecoveryCode(canonical.slice(0, 31))).toBeNull();
    expect(normalizeRecoveryCode(canonical + "0")).toBeNull();
    expect(normalizeRecoveryCode("U".repeat(32))).toBeNull(); // U is not in the alphabet
    expect(normalizeRecoveryCode("!".repeat(32))).toBeNull();
    expect(normalizeRecoveryCode(12345678)).toBeNull();
    expect(normalizeRecoveryCode(null)).toBeNull();
    expect(normalizeRecoveryCode({ toString: () => canonical })).toBeNull();
    expect(normalizeRecoveryCode("A".repeat(10_000))).toBeNull();
  });
});

describe("hashRecoveryCode", () => {
  const code = normalizeRecoveryCode(generateRecoveryCode())!;

  it("produces a 64-char hex digest that does not contain the code", () => {
    const h = hashRecoveryCode("user-1", code, PEPPER);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(h.toUpperCase()).not.toContain(code.slice(0, 8));
  });

  it("is deterministic for the same user, code and pepper", () => {
    expect(hashRecoveryCode("user-1", code, PEPPER)).toBe(hashRecoveryCode("user-1", code, PEPPER));
  });

  it("is bound to the account: the same code hashes differently for another user", () => {
    expect(hashRecoveryCode("user-1", code, PEPPER)).not.toBe(hashRecoveryCode("user-2", code, PEPPER));
  });

  it("is keyed: a different pepper yields a different hash (a DB leak alone cannot verify guesses)", () => {
    expect(hashRecoveryCode("user-1", code, PEPPER)).not.toBe(hashRecoveryCode("user-1", code, OTHER_PEPPER));
  });

  it("differs for different codes", () => {
    const other = normalizeRecoveryCode(generateRecoveryCode())!;
    expect(hashRecoveryCode("user-1", code, PEPPER)).not.toBe(hashRecoveryCode("user-1", other, PEPPER));
  });

  it("uses the test pepper from the environment by default", () => {
    expect(hashRecoveryCode("user-1", code)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("hashRecoverySubject", () => {
  it("is case/whitespace-insensitive so the throttle key cannot be dodged by re-casing an email", () => {
    expect(hashRecoverySubject("Admin@Example.com ", PEPPER)).toBe(hashRecoverySubject("admin@example.com", PEPPER));
  });

  it("is domain-separated from code hashes and never contains the email", () => {
    const h = hashRecoverySubject("admin@example.com", PEPPER);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(h).not.toContain("admin");
  });

  it("differs per email and per pepper", () => {
    expect(hashRecoverySubject("a@x.com", PEPPER)).not.toBe(hashRecoverySubject("b@x.com", PEPPER));
    expect(hashRecoverySubject("a@x.com", PEPPER)).not.toBe(hashRecoverySubject("a@x.com", OTHER_PEPPER));
  });
});

describe("requirePepper (fail closed)", () => {
  it("throws when missing or shorter than 32 characters", () => {
    expect(() => requirePepper(undefined)).toThrow(/RECOVERY_CODE_PEPPER/);
    expect(() => requirePepper("")).toThrow(/RECOVERY_CODE_PEPPER/);
    expect(() => requirePepper("too-short")).toThrow(/RECOVERY_CODE_PEPPER/);
  });

  it("returns a valid pepper unchanged", () => {
    expect(requirePepper(PEPPER)).toBe(PEPPER);
  });
});

describe("recovery grant tokens", () => {
  it("are 256-bit base64url strings and never repeat", () => {
    const tokens = new Set(Array.from({ length: 2000 }, () => generateGrantToken()));
    expect(tokens.size).toBe(2000);
    for (const t of tokens) expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("are validated for shape before any hashing or lookup", () => {
    expect(isWellFormedGrantToken(generateGrantToken())).toBe(true);
    expect(isWellFormedGrantToken("short")).toBe(false);
    expect(isWellFormedGrantToken("x".repeat(44))).toBe(false);
    expect(isWellFormedGrantToken("!".repeat(43))).toBe(false);
    expect(isWellFormedGrantToken(undefined)).toBe(false);
    expect(isWellFormedGrantToken({})).toBe(false);
  });

  it("store only a SHA-256 digest, not the token", () => {
    const token = generateGrantToken();
    const h = hashGrantToken(token);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(h).not.toContain(token.slice(0, 10));
    expect(hashGrantToken(token)).toBe(h);
  });

  it("bind to a User-Agent hash (missing UA hashes as empty, not as the string 'undefined')", () => {
    expect(hashUserAgent("Mozilla/5.0 A")).not.toBe(hashUserAgent("Mozilla/5.0 B"));
    expect(hashUserAgent(undefined)).toBe(hashUserAgent(null));
    expect(hashUserAgent(undefined)).toBe(hashUserAgent(""));
    expect(hashUserAgent(undefined)).not.toBe(hashUserAgent("undefined"));
  });
});
