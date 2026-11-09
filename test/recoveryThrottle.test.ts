import { describe, expect, it, vi } from "vitest";
import {
  RECOVERY_THROTTLE,
  accountThrottleDecision,
  combineThrottleDecisions,
  ipThrottleDecision,
} from "../src/lib/recoveryThrottle.js";
import { assertSafeAuditMetadata } from "../src/lib/recoveryAudit.js";

// These tests only exercise the pure policy functions; keep the Prisma client
// out of the picture entirely (the DB-backed paths are covered by
// test/adminRecovery.integration.test.ts).
vi.mock("../src/lib/prisma.js", () => ({ prisma: {} }));

const NOW = new Date("2026-10-20T12:00:00.000Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const SEC = 1000;
const MIN = 60 * SEC;

describe("accountThrottleDecision", () => {
  it("allows the first 4 failures (below the free allowance)", () => {
    for (const n of [0, 1, 2, 3, 4]) {
      expect(accountThrottleDecision(n, ago(0), NOW).blocked).toBe(false);
    }
  });

  it("never reports more than the configured delay, even if the failure is timestamped slightly in the future", () => {
  const future = new Date(NOW.getTime() + 400);
  expect(accountThrottleDecision(5, future, NOW).retryAfterSeconds).toBe(30);
  expect(accountThrottleDecision(6, future, NOW).retryAfterSeconds).toBe(60);
});

  it("blocks for 30s after the 5th failure, counted from the latest failure", () => {
    const d = accountThrottleDecision(5, ago(0), NOW);
    expect(d).toEqual({ blocked: true, retryAfterSeconds: 30, scope: "ACCOUNT" });
    expect(accountThrottleDecision(5, ago(10 * SEC), NOW).retryAfterSeconds).toBe(20);
  });

  it("releases once the delay has elapsed (no permanent lockout)", () => {
    expect(accountThrottleDecision(5, ago(30 * SEC), NOW).blocked).toBe(false);
    expect(accountThrottleDecision(5, ago(31 * SEC), NOW).blocked).toBe(false);
  });

  it("escalates exponentially: 30s, 60s, 120s, 240s …", () => {
    expect(accountThrottleDecision(5, ago(0), NOW).retryAfterSeconds).toBe(30);
    expect(accountThrottleDecision(6, ago(0), NOW).retryAfterSeconds).toBe(60);
    expect(accountThrottleDecision(7, ago(0), NOW).retryAfterSeconds).toBe(120);
    expect(accountThrottleDecision(8, ago(0), NOW).retryAfterSeconds).toBe(240);
  });

  it("caps the delay at 15 minutes, even for absurd failure counts (no overflow)", () => {
    const cap = RECOVERY_THROTTLE.account.maxDelayMs / 1000;
    expect(accountThrottleDecision(12, ago(0), NOW).retryAfterSeconds).toBe(cap);
    expect(accountThrottleDecision(10_000, ago(0), NOW).retryAfterSeconds).toBe(cap);
    expect(Number.isFinite(accountThrottleDecision(10_000, ago(0), NOW).retryAfterSeconds)).toBe(true);
  });

  it("does not block when there is no recorded failure time", () => {
    expect(accountThrottleDecision(50, null, NOW).blocked).toBe(false);
  });
});

describe("ipThrottleDecision", () => {
  const max = RECOVERY_THROTTLE.ip.maxFailures;
  const windowMs = RECOVERY_THROTTLE.ip.windowMs;

  it("allows up to max-1 failures in the window", () => {
    expect(ipThrottleDecision(max - 1, ago(1 * MIN), NOW).blocked).toBe(false);
  });

  it("blocks at max failures until the releasing failure ages out of the window", () => {
    const d = ipThrottleDecision(max, ago(10 * MIN), NOW);
    expect(d.blocked).toBe(true);
    expect(d.scope).toBe("IP");
    expect(d.retryAfterSeconds).toBe((windowMs - 10 * MIN) / 1000);
  });
 
  it("never reports more than the window, even if the releasing failure is timestamped slightly in the future", () => {
  const future = new Date(NOW.getTime() + 400);
  expect(ipThrottleDecision(max, future, NOW).retryAfterSeconds).toBe(windowMs / 1000);
});
  it("is released once that failure is older than the window", () => {
    expect(ipThrottleDecision(max, ago(windowMs + SEC), NOW).blocked).toBe(false);
  });
});

describe("combineThrottleDecisions", () => {
  const allow = { blocked: false, retryAfterSeconds: 0, scope: null } as const;
  const acct = { blocked: true, retryAfterSeconds: 30, scope: "ACCOUNT" } as const;
  const ip = { blocked: true, retryAfterSeconds: 600, scope: "IP" } as const;

  it("allows only when both scopes allow", () => {
    expect(combineThrottleDecisions(allow, allow).blocked).toBe(false);
  });
  it("blocks when either scope blocks", () => {
    expect(combineThrottleDecisions(acct, allow)).toEqual(acct);
    expect(combineThrottleDecisions(allow, ip)).toEqual(ip);
  });
  it("reports the longer wait when both block", () => {
    expect(combineThrottleDecisions(acct, ip)).toEqual(ip);
    expect(combineThrottleDecisions(ip, acct)).toEqual(ip);
  });
});

describe("assertSafeAuditMetadata (secrets must never reach the audit table)", () => {
  it("accepts harmless primitive metadata", () => {
    expect(() => assertSafeAuditMetadata({ setId: "abc", count: 8, scope: null, ok: true })).not.toThrow();
    expect(() => assertSafeAuditMetadata(undefined)).not.toThrow();
  });

  it("refuses keys that could carry a secret", () => {
    for (const key of ["code", "password", "newPassword", "token", "grantToken", "codeHash", "secret", "pepper", "rawCode"]) {
      expect(() => assertSafeAuditMetadata({ [key]: "x" })).toThrow(/Refusing/);
    }
  });

  it("refuses non-primitive values", () => {
    expect(() => assertSafeAuditMetadata({ nested: { a: 1 } as never })).toThrow(/primitive/);
    expect(() => assertSafeAuditMetadata({ list: [1] as never })).toThrow(/primitive/);
  });
});
