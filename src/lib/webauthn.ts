import {
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { env } from "../config/env.js";

/**
 * WebAuthn configuration + response verification — deliberately free of any
 * database import so it can be unit-tested with a software authenticator
 * (see test/webauthn.test.ts). Persistence lives in passkeys.ts.
 */

// ── Relying-party configuration ─────────────────────────────────────────

export interface WebAuthnConfig {
  rpID: string;
  rpName: string;
  /** Normalised origins (scheme + host + port) a registration may come from. */
  origins: string[];
}

/**
 * Returns the validated relying-party config, or null if passkeys are not
 * (correctly) configured. FAILS CLOSED: there is deliberately no default
 * rpID, because a passkey is bound to its rpID forever — guessing wrong
 * would silently orphan every registered passkey.
 *
 * Rules: rpID must be set; every origin must be https (http only for
 * localhost) and its host must equal the rpID or be a subdomain of it.
 */
export function getWebAuthnConfig(): WebAuthnConfig | null {
  const rpID = env.WEBAUTHN_RP_ID?.trim().toLowerCase();
  if (!rpID || env.WEBAUTHN_ORIGINS_LIST.length === 0) return null;

  const origins: string[] = [];
  for (const raw of env.WEBAUTHN_ORIGINS_LIST) {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return null;
    }
    const isLocalhost = url.hostname === "localhost";
    if (url.protocol !== "https:" && !(url.protocol === "http:" && isLocalhost)) return null;
    if (url.hostname !== rpID && !url.hostname.endsWith(`.${rpID}`)) return null;
    origins.push(url.origin);
  }

  return { rpID, rpName: env.WEBAUTHN_RP_NAME?.trim() || "Egg Mart", origins };
}

export function arePasskeysAvailable(): boolean {
  return getWebAuthnConfig() !== null;
}

// ── Pure verification wrapper (unit-testable without a database) ────────

export interface VerifiedPasskey {
  credentialId: string;
  publicKey: Uint8Array;
  counter: number;
  transports: string[];
  deviceType: string;
  backedUp: boolean;
}

/**
 * Verifies a registration response against the issued challenge. Requires
 * user presence AND user verification (biometric/PIN) — a passkey that can be
 * used without proving who is holding it is not acceptable for recovery.
 * Throws on ANY failure; callers must not reveal why.
 */
export async function verifyPasskeyRegistration(input: {
  response: RegistrationResponseJSON;
  expectedChallenge: string;
  config: WebAuthnConfig;
}): Promise<VerifiedPasskey> {
  const verification = await verifyRegistrationResponse({
    response: input.response,
    expectedChallenge: input.expectedChallenge,
    expectedOrigin: input.config.origins,
    expectedRPID: input.config.rpID,
    requireUserPresence: true,
    requireUserVerification: true,
  });
  if (!verification.verified || !verification.registrationInfo) {
    throw new Error("registration not verified");
  }
  const { credential, credentialDeviceType, credentialBackedUp } = verification.registrationInfo;
  return {
    credentialId: credential.id,
    publicKey: credential.publicKey,
    counter: credential.counter,
    transports: [...(credential.transports ?? input.response.response.transports ?? [])],
    deviceType: credentialDeviceType,
    backedUp: credentialBackedUp,
  };
}

/**
 * Verifies an authentication (assertion) response against the issued
 * challenge and the stored public key. Requires user presence AND user
 * verification. The library also rejects a signature counter that fails to
 * advance (cloned-authenticator signal) whenever either counter is non-zero.
 * Throws on ANY failure; callers must not reveal why.
 */
export async function verifyPasskeyAuthentication(input: {
  response: AuthenticationResponseJSON;
  expectedChallenge: string;
  config: WebAuthnConfig;
  credential: { id: string; publicKey: Uint8Array; counter: number; transports: string[] };
}): Promise<{ newCounter: number }> {
  const verification = await verifyAuthenticationResponse({
    response: input.response,
    expectedChallenge: input.expectedChallenge,
    expectedOrigin: input.config.origins,
    expectedRPID: input.config.rpID,
    requireUserVerification: true,
    credential: {
      id: input.credential.id,
      publicKey: input.credential.publicKey as Uint8Array<ArrayBuffer>,
      counter: input.credential.counter,
      transports: input.credential.transports as never,
    },
  });
  if (!verification.verified) throw new Error("authentication not verified");
  return { newCounter: verification.authenticationInfo.newCounter };
}
