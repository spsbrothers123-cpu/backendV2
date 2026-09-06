import { describe, expect, it } from "vitest";
import jwt from "jsonwebtoken";
import { signInvitationToken, verifyInvitationToken } from "../src/lib/invitationToken.js";

describe("signInvitationToken / verifyInvitationToken", () => {
  it("round-trips the invitationId and shopId", () => {
    const token = signInvitationToken("inv_1", "shop_1");
    const payload = verifyInvitationToken(token);
    expect(payload.invitationId).toBe("inv_1");
    expect(payload.shopId).toBe("shop_1");
    expect(payload.purpose).toBe("CASHIER_SIGNUP_INVITATION");
  });

  it("rejects a garbage/tampered token as INVALID", () => {
    expect(() => verifyInvitationToken("not-a-real-token")).toThrow();
    try {
      verifyInvitationToken("not-a-real-token");
    } catch (reason) {
      expect(reason).toBe("INVALID");
    }
  });

  it("rejects a token signed for a different purpose", () => {
    // Sanity check that the payload shape itself (not just the signature)
    // is validated — a token missing `purpose` should never be accepted.
    const forged = jwt.sign({ invitationId: "x", shopId: "y" }, process.env.JWT_SECRET as string);
    expect(() => verifyInvitationToken(forged)).toThrow();
  });
});
