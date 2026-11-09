import { isIP } from "node:net";

/**
 * Parses the TRUST_PROXY env var into a value Fastify's `trustProxy` accepts.
 *
 * WHY: `request.ip` feeds the per-IP recovery throttle, the route rate
 * limiter, the recovery audit trail and the "your password was reset"
 * e-mail. With `trustProxy: true` Fastify believes the LEFT-most
 * X-Forwarded-For entry, which is whatever the client typed — so anyone can
 * mint a fresh "IP" per request, defeat every IP-based limit, forge the
 * audit trail, or frame another IP. Trusting a fixed number of hops (the
 * proxies you actually run) makes Fastify read the entry those proxies
 * appended, which a client cannot influence.
 *
 *   unset / ""        → production: 1 hop (one reverse proxy: Railway, Render,
 *                       Nginx…); development/test: trust nothing
 *   "0" / "false"     → trust nothing (no proxy in front; use the socket IP)
 *   "2"               → trust that many hops (e.g. CDN + platform load balancer)
 *   "10.0.0.0/8,loopback" → trust these proxy addresses / CIDRs / keywords
 *                       (strongest: also validates the immediate peer)
 *   "true"            → REFUSED (it is the spoofable setting)
 *
 * Hop counts are returned as a FUNCTION, not a number, on purpose: Fastify 5
 * treats a numeric `trustProxy` as "cannot validate the peer" and fails
 * closed, ignoring X-Forwarded-For completely — request.ip would then be the
 * proxy's address for every visitor, so one shared IP would exhaust the
 * per-IP recovery limit for everybody. A hop count is only safe when ALL
 * traffic reaches the app through that many proxies (true on managed
 * platforms; use the IP/CIDR list if the app can be reached directly).
 */
export type TrustProxySetting = false | ((addr: string, hop: number) => boolean) | string[];

const KEYWORDS = new Set(["loopback", "linklocal", "uniquelocal"]);
const MAX_HOPS = 10;

function isValidEntry(entry: string): boolean {
  if (KEYWORDS.has(entry)) return true;
  const [addr, prefix, ...rest] = entry.split("/");
  if (rest.length > 0) return false;
  const family = isIP(addr);
  if (!family) return false;
  if (prefix === undefined) return true;
  if (!/^\d{1,3}$/.test(prefix)) return false;
  return Number(prefix) <= (family === 4 ? 32 : 128);
}

/** Trusts the first `hops` hops starting at the socket peer (hop 0). */
export function trustHops(hops: number): (addr: string, hop: number) => boolean {
  return (_addr, hop) => hop < hops;
}

export function parseTrustProxy(
  raw: string | undefined | null,
  opts: { production?: boolean } = {}
): TrustProxySetting {
  const value = (raw ?? "").trim().toLowerCase();
  if (value === "") return opts.production ? trustHops(1) : false;
  if (value === "false") return false;
  if (value === "true") {
    throw new Error(
      "TRUST_PROXY=true is not allowed: it lets clients spoof their IP via X-Forwarded-For. " +
        "Set a hop count (e.g. 1) or a comma-separated list of proxy IPs/CIDRs."
    );
  }
  if (/^\d+$/.test(value)) {
    const hops = Number(value);
    if (hops > MAX_HOPS) throw new Error(`TRUST_PROXY hop count must be between 0 and ${MAX_HOPS}.`);
    return hops === 0 ? false : trustHops(hops);
  }
  const entries = value.split(",").map((e) => e.trim()).filter(Boolean);
  if (entries.length === 0 || !entries.every(isValidEntry)) {
    throw new Error(
      "TRUST_PROXY must be a hop count, 'false', or a comma-separated list of IPs/CIDRs/loopback/linklocal/uniquelocal."
    );
  }
  return entries;
}
