import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";

/**
 * A minimal software WebAuthn authenticator for tests: produces genuine
 * "none"-attestation registration responses (real ES256 P-256 key, real
 * CBOR authData) that @simplewebauthn/server verifies exactly as it would a
 * browser's. This is a TEST double for the authenticator hardware only —
 * the server-side verification under test is the real code path.
 */

const b64url = (b: Uint8Array | Buffer) => Buffer.from(b).toString("base64url");

// ── tiny CBOR encoder (only what a registration response needs) ─────────
function cborHead(major: number, n: number): Buffer {
  if (n < 24) return Buffer.from([(major << 5) | n]);
  if (n < 256) return Buffer.from([(major << 5) | 24, n]);
  return Buffer.from([(major << 5) | 25, n >> 8, n & 0xff]);
}
const cborText = (s: string) => Buffer.concat([cborHead(3, Buffer.byteLength(s)), Buffer.from(s)]);
const cborBytes = (b: Buffer) => Buffer.concat([cborHead(2, b.length), b]);
const cborUint = (n: number) => cborHead(0, n);
const cborNegInt = (n: number) => cborHead(1, -1 - n); // n < 0

export interface SoftRegistrationOptions {
  rpID: string;
  origin: string;
  /** base64url challenge exactly as issued by the server. */
  challenge: string;
  /** Default true. false → the UV flag is NOT set (no biometric/PIN). */
  userVerified?: boolean;
  /** Default true. */
  userPresent?: boolean;
  /** Default false → "singleDevice". true → BE+BS flags ("multiDevice", backed up). */
  backedUp?: boolean;
  /** Override clientData.type (default "webauthn.create"). */
  clientDataType?: string;
  /** Reuse a credential (to test duplicate registration). */
  credentialId?: Buffer;
}

export interface SoftRegistration {
  /** What the browser would POST: RegistrationResponseJSON. */
  response: {
    id: string;
    rawId: string;
    type: "public-key";
    response: { clientDataJSON: string; attestationObject: string; transports: string[] };
    clientExtensionResults: Record<string, never>;
    authenticatorAttachment: "platform";
  };
  credentialId: string;
  /** The authenticator's private key — only ever held by the TEST double, like real hardware. */
  privateKey: KeyObject;
}

export function createSoftRegistration(opts: SoftRegistrationOptions): SoftRegistration {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" });
  const x = Buffer.from(jwk.x as string, "base64url");
  const y = Buffer.from(jwk.y as string, "base64url");

  // COSE_Key (EC2, ES256, P-256): {1:2, 3:-7, -1:1, -2:x, -3:y}
  const coseKey = Buffer.concat([
    Buffer.from([0xa5]),
    cborUint(1), cborUint(2),
    cborUint(3), cborNegInt(-7),
    cborNegInt(-1), cborUint(1),
    cborNegInt(-2), cborBytes(x),
    cborNegInt(-3), cborBytes(y),
  ]);

  const credId = opts.credentialId ?? randomBytes(32);
  let flags = 0x40; // AT (attested credential data present)
  if (opts.userPresent !== false) flags |= 0x01;
  if (opts.userVerified !== false) flags |= 0x04;
  if (opts.backedUp) flags |= 0x08 | 0x10; // BE + BS

  const credIdLen = Buffer.alloc(2);
  credIdLen.writeUInt16BE(credId.length);
  const authData = Buffer.concat([
    createHash("sha256").update(opts.rpID).digest(), // rpIdHash
    Buffer.from([flags]),
    Buffer.alloc(4), // signCount = 0
    Buffer.alloc(16), // AAGUID (zeros)
    credIdLen,
    credId,
    coseKey,
  ]);

  // attestationObject = {"fmt":"none","attStmt":{},"authData":<bytes>}
  const attestationObject = Buffer.concat([
    Buffer.from([0xa3]),
    cborText("fmt"), cborText("none"),
    cborText("attStmt"), Buffer.from([0xa0]),
    cborText("authData"), cborBytes(authData),
  ]);

  const clientDataJSON = Buffer.from(
    JSON.stringify({
      type: opts.clientDataType ?? "webauthn.create",
      challenge: opts.challenge,
      origin: opts.origin,
      crossOrigin: false,
    })
  );

  return {
    credentialId: b64url(credId),
    privateKey,
    response: {
      id: b64url(credId),
      rawId: b64url(credId),
      type: "public-key",
      response: {
        clientDataJSON: b64url(clientDataJSON),
        attestationObject: b64url(attestationObject),
        transports: ["internal"],
      },
      clientExtensionResults: {},
      authenticatorAttachment: "platform",
    },
  };
}

export interface SoftAssertionOptions {
  rpID: string;
  origin: string;
  /** base64url challenge exactly as issued by the server. */
  challenge: string;
  /** From the registration (SoftRegistration.credentialId / .privateKey). */
  credentialId: string;
  privateKey: KeyObject;
  /** Default 1. Platform authenticators often report 0 forever; pass 0 to model that. */
  signCount?: number;
  /** Default true. false → UV flag NOT set. */
  userVerified?: boolean;
  /** Default true. */
  userPresent?: boolean;
  /** Override clientData.type (default "webauthn.get"). */
  clientDataType?: string;
  /** base64url user handle to return (what a discoverable credential reports). */
  userHandle?: string;
  /** Sign with a DIFFERENT key (forged signature) while keeping everything else valid. */
  signWith?: KeyObject;
}

/** What the browser would POST for an authentication ceremony: AuthenticationResponseJSON. */
export function createSoftAssertion(opts: SoftAssertionOptions) {
  let flags = 0;
  if (opts.userPresent !== false) flags |= 0x01;
  if (opts.userVerified !== false) flags |= 0x04;

  const counter = Buffer.alloc(4);
  counter.writeUInt32BE(opts.signCount ?? 1);
  const authData = Buffer.concat([
    createHash("sha256").update(opts.rpID).digest(),
    Buffer.from([flags]),
    counter,
  ]);

  const clientDataJSON = Buffer.from(
    JSON.stringify({
      type: opts.clientDataType ?? "webauthn.get",
      challenge: opts.challenge,
      origin: opts.origin,
      crossOrigin: false,
    })
  );

  const signedData = Buffer.concat([authData, createHash("sha256").update(clientDataJSON).digest()]);
  const signature = sign("sha256", signedData, opts.signWith ?? opts.privateKey); // DER-encoded ECDSA, as WebAuthn requires

  return {
    id: opts.credentialId,
    rawId: opts.credentialId,
    type: "public-key" as const,
    response: {
      clientDataJSON: b64url(clientDataJSON),
      authenticatorData: b64url(authData),
      signature: b64url(signature),
      ...(opts.userHandle ? { userHandle: opts.userHandle } : {}),
    },
    clientExtensionResults: {},
    authenticatorAttachment: "platform" as const,
  };
}
