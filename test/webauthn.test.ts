/**
 * Unit tests (no database) for passkey configuration and registration
 * verification, using a software authenticator that emits real WebAuthn
 * attestation data. Covers spec test #3 (successful passkey verification)
 * and #4 (invalid WebAuthn challenge rejection) at the cryptographic layer.
 */
import { afterEach, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { env } from "../src/config/env.js";
import { getWebAuthnConfig, verifyPasskeyAuthentication, verifyPasskeyRegistration } from "../src/lib/webauthn.js";
import { createSoftAssertion, createSoftRegistration } from "./helpers/softAuthenticator.js";
import { generateKeyPairSync } from "node:crypto";

const RP_ID = "eggmart.example.com";
const ORIGIN = "https://admin.eggmart.example.com";
const config = { rpID: RP_ID, rpName: "Egg Mart", origins: [ORIGIN] };
const newChallenge = () => randomBytes(32).toString("base64url");

describe("getWebAuthnConfig", () => {
  const saved = { id: env.WEBAUTHN_RP_ID, name: env.WEBAUTHN_RP_NAME, list: env.WEBAUTHN_ORIGINS_LIST };
  afterEach(() => {
    env.WEBAUTHN_RP_ID = saved.id;
    env.WEBAUTHN_RP_NAME = saved.name;
    env.WEBAUTHN_ORIGINS_LIST = saved.list;
  });
  const set = (rpId: string | undefined, origins: string[]) => {
    env.WEBAUTHN_RP_ID = rpId;
    env.WEBAUTHN_ORIGINS_LIST = origins;
  };

  it("fails closed (null) when nothing is configured — there is no default rpID", () => {
    set(undefined, []);
    expect(getWebAuthnConfig()).toBeNull();
  });
  it("fails closed when only one of rpID / origins is set", () => {
    set(RP_ID, []);
    expect(getWebAuthnConfig()).toBeNull();
    set(undefined, [ORIGIN]);
    expect(getWebAuthnConfig()).toBeNull();
  });
  it("accepts an https origin on the rpID or a subdomain, and normalises it", () => {
    set(RP_ID, [ORIGIN, "https://eggmart.example.com/"]);
    expect(getWebAuthnConfig()).toEqual({
      rpID: RP_ID,
      rpName: "Egg Mart",
      origins: [ORIGIN, "https://eggmart.example.com"],
    });
  });
  it("accepts http only for localhost", () => {
    set("localhost", ["http://localhost:5173"]);
    expect(getWebAuthnConfig()?.origins).toEqual(["http://localhost:5173"]);
    set(RP_ID, ["http://admin.eggmart.example.com"]);
    expect(getWebAuthnConfig()).toBeNull();
  });
  it("rejects an origin that is not the rpID or one of its subdomains", () => {
    set(RP_ID, ["https://evil-eggmart.example.com"]);
    expect(getWebAuthnConfig()).toBeNull();
    set(RP_ID, ["https://example.com"]);
    expect(getWebAuthnConfig()).toBeNull();
  });
  it("rejects a malformed origin", () => {
    set(RP_ID, ["not a url"]);
    expect(getWebAuthnConfig()).toBeNull();
  });
});

describe("verifyPasskeyRegistration", () => {
  it("verifies a valid registration and returns only PUBLIC key material", async () => {
    const challenge = newChallenge();
    const soft = createSoftRegistration({ rpID: RP_ID, origin: ORIGIN, challenge });
    const result = await verifyPasskeyRegistration({
      response: soft.response as never,
      expectedChallenge: challenge,
      config,
    });
    expect(result.credentialId).toBe(soft.credentialId);
    expect(result.publicKey.length).toBeGreaterThan(0);
    expect(result.counter).toBe(0);
    expect(result.deviceType).toBe("singleDevice");
    expect(result.backedUp).toBe(false);
    expect(result.transports).toEqual(["internal"]);
    // Nothing resembling a private key / biometric is part of the result.
    expect(Object.keys(result).sort()).toEqual(
      ["backedUp", "counter", "credentialId", "deviceType", "publicKey", "transports"].sort()
    );
  });

  it("reports a synced (multi-device, backed-up) passkey", async () => {
    const challenge = newChallenge();
    const soft = createSoftRegistration({ rpID: RP_ID, origin: ORIGIN, challenge, backedUp: true });
    const result = await verifyPasskeyRegistration({ response: soft.response as never, expectedChallenge: challenge, config });
    expect(result.deviceType).toBe("multiDevice");
    expect(result.backedUp).toBe(true);
  });

  it("REJECTS a response signed over a different challenge (invalid challenge)", async () => {
    const soft = createSoftRegistration({ rpID: RP_ID, origin: ORIGIN, challenge: newChallenge() });
    await expect(
      verifyPasskeyRegistration({ response: soft.response as never, expectedChallenge: newChallenge(), config })
    ).rejects.toThrow();
  });

  it("REJECTS a response from an origin that is not allow-listed", async () => {
    const challenge = newChallenge();
    const soft = createSoftRegistration({ rpID: RP_ID, origin: "https://phishing.example.net", challenge });
    await expect(
      verifyPasskeyRegistration({ response: soft.response as never, expectedChallenge: challenge, config })
    ).rejects.toThrow();
  });

  it("REJECTS a credential created for a different relying party (rpIdHash mismatch)", async () => {
    const challenge = newChallenge();
    const soft = createSoftRegistration({ rpID: "other-site.example.org", origin: ORIGIN, challenge });
    await expect(
      verifyPasskeyRegistration({ response: soft.response as never, expectedChallenge: challenge, config })
    ).rejects.toThrow();
  });

  it("REJECTS when the authenticator did not perform user verification (no biometric/PIN)", async () => {
    const challenge = newChallenge();
    const soft = createSoftRegistration({ rpID: RP_ID, origin: ORIGIN, challenge, userVerified: false });
    await expect(
      verifyPasskeyRegistration({ response: soft.response as never, expectedChallenge: challenge, config })
    ).rejects.toThrow();
  });

  it("REJECTS when user presence is missing", async () => {
    const challenge = newChallenge();
    const soft = createSoftRegistration({ rpID: RP_ID, origin: ORIGIN, challenge, userPresent: false });
    await expect(
      verifyPasskeyRegistration({ response: soft.response as never, expectedChallenge: challenge, config })
    ).rejects.toThrow();
  });

  it("REJECTS an assertion-type clientData used as a registration", async () => {
    const challenge = newChallenge();
    const soft = createSoftRegistration({ rpID: RP_ID, origin: ORIGIN, challenge, clientDataType: "webauthn.get" });
    await expect(
      verifyPasskeyRegistration({ response: soft.response as never, expectedChallenge: challenge, config })
    ).rejects.toThrow();
  });

  it("REJECTS a corrupted attestation object", async () => {
    const challenge = newChallenge();
    const soft = createSoftRegistration({ rpID: RP_ID, origin: ORIGIN, challenge });
    soft.response.response.attestationObject = Buffer.from("garbage").toString("base64url");
    await expect(
      verifyPasskeyRegistration({ response: soft.response as never, expectedChallenge: challenge, config })
    ).rejects.toThrow();
  });
});


// ── Authentication (Forgot Password) ────────────────────────────────────
describe("verifyPasskeyAuthentication", () => {
  async function enrol() {
    const challenge = newChallenge();
    const reg = createSoftRegistration({ rpID: RP_ID, origin: ORIGIN, challenge });
    const verified = await verifyPasskeyRegistration({ response: reg.response as never, expectedChallenge: challenge, config });
    return { reg, stored: { id: verified.credentialId, publicKey: verified.publicKey, counter: 0, transports: verified.transports } };
  }
  const assertion = (reg: Awaited<ReturnType<typeof enrol>>["reg"], over: Record<string, unknown> = {}) => {
    const challenge = (over.challenge as string) ?? newChallenge();
    return {
      challenge,
      response: createSoftAssertion({
        rpID: RP_ID,
        origin: ORIGIN,
        challenge,
        credentialId: reg.credentialId,
        privateKey: reg.privateKey,
        ...over,
      } as never),
    };
  };

  it("accepts a genuine assertion and returns the advanced counter", async () => {
    const { reg, stored } = await enrol();
    const a = assertion(reg, { signCount: 7 });
    const out = await verifyPasskeyAuthentication({ response: a.response as never, expectedChallenge: a.challenge, config, credential: stored });
    expect(out.newCounter).toBe(7);
  });

  it("rejects an assertion for a different challenge (invalid challenge / replay of an old ceremony)", async () => {
    const { reg, stored } = await enrol();
    const a = assertion(reg);
    await expect(
      verifyPasskeyAuthentication({ response: a.response as never, expectedChallenge: newChallenge(), config, credential: stored })
    ).rejects.toThrow();
  });

  it("rejects a forged signature (signed by a different key)", async () => {
    const { reg, stored } = await enrol();
    const attacker = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey;
    const a = assertion(reg, { signWith: attacker });
    await expect(
      verifyPasskeyAuthentication({ response: a.response as never, expectedChallenge: a.challenge, config, credential: stored })
    ).rejects.toThrow();
  });

  it("rejects an assertion without user verification (no biometric/PIN)", async () => {
    const { reg, stored } = await enrol();
    const a = assertion(reg, { userVerified: false });
    await expect(
      verifyPasskeyAuthentication({ response: a.response as never, expectedChallenge: a.challenge, config, credential: stored })
    ).rejects.toThrow();
  });

  it("rejects an assertion from the wrong origin or for the wrong relying party", async () => {
    const { reg, stored } = await enrol();
    const badOrigin = assertion(reg, { origin: "https://evil.example.com" });
    await expect(
      verifyPasskeyAuthentication({ response: badOrigin.response as never, expectedChallenge: badOrigin.challenge, config, credential: stored })
    ).rejects.toThrow();
    const badRp = assertion(reg, { rpID: "evil.example.com" });
    await expect(
      verifyPasskeyAuthentication({ response: badRp.response as never, expectedChallenge: badRp.challenge, config, credential: stored })
    ).rejects.toThrow();
  });

  it("rejects a registration-type ceremony presented as an assertion", async () => {
    const { reg, stored } = await enrol();
    const a = assertion(reg, { clientDataType: "webauthn.create" });
    await expect(
      verifyPasskeyAuthentication({ response: a.response as never, expectedChallenge: a.challenge, config, credential: stored })
    ).rejects.toThrow();
  });

  it("rejects a signature counter that fails to advance (cloned authenticator / replay), but allows 0→0", async () => {
    const { reg, stored } = await enrol();
    const stale = assertion(reg, { signCount: 3 });
    await expect(
      verifyPasskeyAuthentication({
        response: stale.response as never,
        expectedChallenge: stale.challenge,
        config,
        credential: { ...stored, counter: 5 },
      })
    ).rejects.toThrow();

    const zero = assertion(reg, { signCount: 0 });
    const out = await verifyPasskeyAuthentication({
      response: zero.response as never,
      expectedChallenge: zero.challenge,
      config,
      credential: { ...stored, counter: 0 },
    });
    expect(out.newCounter).toBe(0);
  });

  it("rejects an assertion verified against a different credential's public key", async () => {
    const { reg } = await enrol();
    const other = await enrol();
    const a = assertion(reg);
    await expect(
      verifyPasskeyAuthentication({ response: a.response as never, expectedChallenge: a.challenge, config, credential: other.stored })
    ).rejects.toThrow();
  });
});
