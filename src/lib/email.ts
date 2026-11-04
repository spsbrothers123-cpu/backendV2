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

const DEFAULT_FOOTER = "If you didn't request this, you can safely ignore this email.";

function wrapHtml(bodyHtml: string, footer: string = DEFAULT_FOOTER): string {
  return `<div style="font-family:sans-serif;max-width:480px;margin:0 auto;">
    <h2 style="color:#b45309;">🥚 Egg Mart</h2>
    ${bodyHtml}
    <hr style="margin-top:24px;border:none;border-top:1px solid #eee;" />
    <p style="font-size:12px;color:#999;">${footer}</p>
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

// Admin Forgot Password (passkey / recovery code). A SECURITY NOTIFICATION
// only: it contains no link, code or token and nothing in it can be used to
// act on the account. It exists so a real Admin is told when their password
// was changed through recovery and can react if it wasn't them.
export async function sendAdminPasswordRecovered(
  to: string,
  name: string,
  details: { method: "PASSKEY" | "RECOVERY_CODE"; at: Date; ip: string | null }
) {
  const how = details.method === "PASSKEY" ? "a registered passkey" : "an emergency recovery code";
  const when = details.at.toUTCString();
  const where = details.ip ? ` from IP address ${details.ip}` : "";
  const subject = "Egg Mart — Your admin password was changed";
  const text = `Hi ${name},\n\nThe password for your Egg Mart admin account (${to}) was just changed using ${how}${where} at ${when}. All of your signed-in sessions were signed out.\n\nIf this was you, no action is needed. If it was NOT you, someone has access to one of your recovery methods: contact your Egg Mart system owner immediately.\n\n— Egg Mart`;
  const html = wrapHtml(
    `<p>Hi ${escapeHtml(name)},</p>
     <p>The password for your admin account <strong>${escapeHtml(to)}</strong> was changed using ${how}${escapeHtml(where)} at ${escapeHtml(when)}.</p>
     <p>All of your signed-in sessions were signed out.</p>
     <p><strong>If this was not you</strong>, someone has access to one of your recovery methods. Contact your Egg Mart system owner immediately.</p>`,
    // The default footer says "safe to ignore" — wrong for a security alert.
    "This is an automated security notification. Do not ignore it if you did not make this change."
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
