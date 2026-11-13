import dotenv from "dotenv";

const envFile = process.env.NODE_ENV === "test" ? ".env.test" : ".env";
dotenv.config({ path: envFile });
// optional fallback so shared vars in .env still apply
dotenv.config({ path: ".env" });

import { z } from "zod";

// Optional string env vars: a blank value in .env (e.g. `RECOVERY_CODE_PEPPER=`)
// is treated as "not set" rather than failing validation.
const optionalString = (min = 1) =>
  z.preprocess((v) => (typeof v === "string" && v.trim() === "" ? undefined : v), z.string().min(min).optional());

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().default(5000),

  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),

  JWT_SECRET: z.string().min(16, "JWT_SECRET must be at least 16 characters"),
    JWT_EXPIRES_IN: z.string().default("12h"),
  PASSWORD_RESET_TOKEN_EXPIRY_MINUTES: z.coerce.number().int().positive().default(30),

  CORS_ORIGINS: z.string().default("http://localhost:5173,http://localhost:5174"),

  EMAIL_PROVIDER: z.enum(["console", "resend"]).default("console"),
  RESEND_API_KEY: z.string().optional().default(""),
  EMAIL_FROM: z.string().default("Egg Mart <no-reply@eggmart.example>"),

  // Cashier signup invitation codes (replaces the old email-OTP config —
  // see Backend spec "REMOVE OTP + IMPLEMENT 6-DIGIT INVITATION CODE").
  INVITATION_CODE_EXPIRY_MINUTES: z.coerce.number().default(30),
  // How long a verifyInvitationCode() token is valid for while the cashier
  // fills out the registration form.
  INVITATION_TOKEN_EXPIRY_MINUTES: z.coerce.number().default(15),

  // Frontend origins (the two apps run on different ports/domains — see CORS_ORIGINS).
  // The emailed password-reset link (and its token-expiry setting) was removed:
  // Cashier recovery is admin-assisted, Admin recovery uses passkeys/codes.
  ADMIN_APP_URL: z.string().default("http://localhost:5173"),
  CASHIER_APP_URL: z.string().default("http://localhost:5174"),

  // ── Admin password recovery (Phase 1 foundation) ────────────────────
  // Secret "pepper" used to key the HMAC that protects recovery codes at
  // rest (and to key the account-throttle subject hash). It must be
  // separate from JWT_SECRET. Deliberately OPTIONAL at boot so existing
  // deployments keep starting; lib/recoveryCodes.ts fails closed (throws)
  // if a recovery operation is attempted without it. Generate with:
  //   node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
  // Rotating it invalidates every stored recovery code (admins must
  // regenerate), so treat it like a long-lived secret.
  RECOVERY_CODE_PEPPER: optionalString(32),
  // How long a recovery grant (issued after a recovery credential is
  // verified) stays redeemable.
  RECOVERY_GRANT_EXPIRY_MINUTES: z.coerce.number().int().min(1).max(60).default(10),

  // ── Central Admin (Cashier password recovery) ──────────────────────
  // The stable users.id (UUID) of THE one Admin who may view, approve and
  // reject Cashier recovery requests, across every shop. Deliberately an id,
  // not an email (emails are editable). It is NEVER defaulted or inferred
  // from "the first admin": when unset, Cashier recovery management fails
  // closed (503) and no recovery code can be issued. Find the id with:
  //   SELECT id, email FROM users WHERE role = 'ADMIN' AND status = 'ACTIVE';
  CENTRAL_ADMIN_USER_ID: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? undefined : typeof v === "string" ? v.trim() : v),
    z.string().uuid("CENTRAL_ADMIN_USER_ID must be a user id (UUID).").optional()
  ),

  // ── WebAuthn relying-party config (declared now, NOT used yet) ──────
  // No defaults on purpose: the rpId is permanent once passkeys exist, so
  // it must be an explicit decision, never a guess. Passkey support is not
  // implemented until the production domain is confirmed.
  WEBAUTHN_RP_ID: optionalString(),
  WEBAUTHN_RP_NAME: optionalString(),
  // Comma-separated list of allowed origins, e.g. https://admin.example.com
  WEBAUTHN_ORIGINS: optionalString(),

  // ── Reverse proxy trust (see lib/trustProxy.ts) ─────────────────────
  // Hop count (default 1), "false", or a list of proxy IPs/CIDRs. "true" is
  // refused. Controls how request.ip is derived from X-Forwarded-For, which
  // the recovery throttle, rate limiter and audit trail depend on.
  TRUST_PROXY: optionalString(),

  // ── Notification engine (Backend Phase 3) ───────────────────────────
  // In-process scheduler (D-24). Defaults ON outside tests; set "false" to
  // run an instance as API-only. Safe with several instances (DB lock).
  NOTIFICATION_SCHEDULER_ENABLED: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
    z.enum(["true", "false"]).optional()
  ).transform((v) => (v === undefined ? undefined : v === "true")),
  // D-25: push (FCM/Capacitor) is deferred; this flag exists for B3.8. Default off.
  NOTIFICATION_PUSH_ENABLED: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
    z.enum(["true", "false"]).optional()
  ).transform((v) => v === "true"),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  // eslint-disable-next-line no-console
  console.error("Invalid environment configuration:", parsed.error.flatten().fieldErrors);
  throw new Error("Invalid environment configuration. Check .env against .env.example.");
}

export const env = {
  ...parsed.data,
  CORS_ORIGINS_LIST: parsed.data.CORS_ORIGINS.split(",").map((o) => o.trim()).filter(Boolean),
  WEBAUTHN_ORIGINS_LIST: (parsed.data.WEBAUTHN_ORIGINS ?? "")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean),
};