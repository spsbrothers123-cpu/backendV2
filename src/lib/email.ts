import { Resend } from "resend";
import { env } from "../config/env.js";

/**
 * Centralized email service. Routes must never send email directly —
 * everything goes through here so credentials stay backend-only and the
 * message content (and what NEVER goes in it — passwords, invitation
 * codes, tokens) is defined in exactly one place.
 */

const resend = env.EMAIL_PROVIDER === "resend" && env.RESEND_API_KEY ? new Resend(env.RESEND_API_KEY) : null;

async function send(to: string, subject: string, html: string, text: string) {
  if (env.EMAIL_PROVIDER === "resend" && resend) {
    await resend.emails.send({ from: env.EMAIL_FROM, to, subject, html, text });
    return;
  }
  // Dev/test fallback — never throws, never blocks signup flows on a
  // missing email provider.
  // eslint-disable-next-line no-console
  console.log(`[email:console] to=${to} subject="${subject}"\n${text}`);
}

function wrapHtml(bodyHtml: string): string {
  return `<div style="font-family:sans-serif;max-width:480px;margin:0 auto;">
    <h2 style="color:#b45309;">🥚 Egg Mart</h2>
    ${bodyHtml}
    <hr style="margin-top:24px;border:none;border-top:1px solid #eee;" />
    <p style="font-size:12px;color:#999;">If you didn't request this, you can safely ignore this email.</p>
  </div>`;
}

// NOTE: cashier signup no longer emails a verification code — signup is
// gated by an admin-generated, admin-communicated invitation code instead
// (see lib/invitationCode.ts, routes/admin/invitationCodes.ts). The old
// sendSignupOtp() has been removed along with that flow.

export async function sendCashierApproved(to: string, name: string) {
  const subject = "Egg Mart — Your Cashier Account Is Approved";
  const text = `Hi ${name},\n\nYour Egg Mart cashier account (${to}) has been approved by your shop administrator. You can now log in with your email and password.\n\n— Egg Mart`;
  const html = wrapHtml(
    `<p>Hi ${escapeHtml(name)},</p>
     <p>Your cashier account has been <strong>approved</strong>.</p>
     <p>Account email: <strong>${escapeHtml(to)}</strong></p>
     <p>You can now log in with your email and password — no verification code is needed to log in.</p>`
  );
  await send(to, subject, html, text);
}

export async function sendCashierRejected(to: string, name: string, reason?: string) {
  const subject = "Egg Mart — Cashier Account Request";
  const text = `Hi ${name},\n\nYour Egg Mart cashier account request was not approved.${
    reason ? ` Reason: ${reason}` : ""
  }\n\nPlease contact your shop administrator for details.\n\n— Egg Mart`;
  const html = wrapHtml(
    `<p>Hi ${escapeHtml(name)},</p>
     <p>Your cashier account request was not approved.</p>
     ${reason ? `<p>Reason: ${escapeHtml(reason)}</p>` : ""}
     <p>Please contact your shop administrator for details.</p>`
  );
  await send(to, subject, html, text);
}

// RBR Egg Mart V2 Phase 1: Forgot Password (Admin + Cashier). `resetUrl`
// already points at the right frontend (Admin app vs Cashier app) and
// carries the one-time token as a query param — see routes/auth.ts. The
// token itself is never included anywhere else in this email.
export async function sendPasswordReset(to: string, name: string, resetUrl: string) {
  const subject = "Egg Mart — Reset Your Password";
  const text = `Hi ${name},\n\nWe received a request to reset your Egg Mart password. Click the link below to choose a new password:\n\n${resetUrl}\n\nThis link expires soon and can only be used once. If you didn't request this, you can safely ignore this email — your password will not change.\n\n— Egg Mart`;
  const html = wrapHtml(
    `<p>Hi ${escapeHtml(name)},</p>
     <p>We received a request to reset your Egg Mart password.</p>
     <p><a href="${resetUrl}" style="display:inline-block;background:#b45309;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none;">Reset your password</a></p>
     <p style="font-size:13px;color:#666;">This link expires soon and can only be used once.</p>`
  );
  await send(to, subject, html, text);
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
