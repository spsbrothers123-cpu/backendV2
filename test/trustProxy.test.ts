import { describe, expect, it } from "vitest";
import Fastify from "fastify";
import { parseTrustProxy } from "../src/lib/trustProxy.js";

/** Minimal Fastify app that just reports what it believes the client IP is. */
async function ipSeenBy(trustProxy: unknown, remoteAddress: string, xff?: string) {
  const app = Fastify({ trustProxy: trustProxy as never });
  app.get("/ip", async (request) => ({ ip: request.ip }));
  const res = await app.inject({
    method: "GET",
    url: "/ip",
    remoteAddress,
    headers: xff ? { "x-forwarded-for": xff } : {},
  });
  await app.close();
  return res.json().ip as string;
}

describe("parseTrustProxy", () => {
  const hopsTrusted = (setting: unknown) => {
    const fn = setting as (a: string, i: number) => boolean;
    return [0, 1, 2, 3].filter((i) => fn("x", i)).length;
  };

  it("defaults to exactly one trusted hop in production and to trusting nothing elsewhere", () => {
    expect(hopsTrusted(parseTrustProxy(undefined, { production: true }))).toBe(1);
    expect(hopsTrusted(parseTrustProxy("  ", { production: true }))).toBe(1);
    expect(parseTrustProxy(undefined)).toBe(false);
    expect(parseTrustProxy("", { production: false })).toBe(false);
  });

  it("accepts a hop count, 0/false (no proxy), and proxy lists", () => {
    expect(hopsTrusted(parseTrustProxy("2"))).toBe(2);
    expect(parseTrustProxy("0")).toBe(false);
    expect(parseTrustProxy("FALSE")).toBe(false);
    expect(parseTrustProxy("10.0.0.0/8, loopback ,fd00::/8")).toEqual(["10.0.0.0/8", "loopback", "fd00::/8"]);
  });

  it("refuses the spoofable `true` and malformed values", () => {
    expect(() => parseTrustProxy("true")).toThrow(/spoof/i);
    expect(() => parseTrustProxy("11")).toThrow();
    expect(() => parseTrustProxy("-1")).toThrow();
    expect(() => parseTrustProxy("10.0.0.0/33")).toThrow();
    expect(() => parseTrustProxy("not-an-ip")).toThrow();
    expect(() => parseTrustProxy("1.2.3.4/8/8")).toThrow();
  });
});

describe("request.ip cannot be spoofed through X-Forwarded-For", () => {
  const PROXY = "10.1.1.1"; // the one reverse proxy we run
  const REAL_CLIENT = "203.0.113.50"; // what that proxy appended
  const FORGED = "1.2.3.4"; // what the attacker typed

  it("demonstrates the old behaviour: trustProxy:true believes the forged value", async () => {
    expect(await ipSeenBy(true, PROXY, `${FORGED}, ${REAL_CLIENT}`)).toBe(FORGED);
  });

  it("with the default (1 hop) the attacker-supplied entry is ignored", async () => {
    expect(await ipSeenBy(parseTrustProxy(undefined, { production: true }), PROXY, `${FORGED}, ${REAL_CLIENT}`)).toBe(REAL_CLIENT);
  });

  it("rotating the forged header never changes the IP the throttle sees", async () => {
    const seen = new Set<string>();
    for (let i = 0; i < 20; i++) {
      seen.add(await ipSeenBy(parseTrustProxy("1"), PROXY, `9.9.9.${i}, ${REAL_CLIENT}`));
    }
    expect([...seen]).toEqual([REAL_CLIENT]);
  });

  it("with no proxy configured, the header is ignored entirely", async () => {
    expect(await ipSeenBy(parseTrustProxy("0"), "198.51.100.7", `${FORGED}`)).toBe("198.51.100.7");
  });

  it("a header from a peer that is NOT a trusted proxy is ignored (CIDR list)", async () => {
    const trust = parseTrustProxy("10.0.0.0/8");
    expect(await ipSeenBy(trust, "198.51.100.7", FORGED)).toBe("198.51.100.7");
    expect(await ipSeenBy(trust, PROXY, REAL_CLIENT)).toBe(REAL_CLIENT);
  });
});
