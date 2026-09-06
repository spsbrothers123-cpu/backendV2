import dotenv from "dotenv";

const envFile = process.env.NODE_ENV === "test" ? ".env.test" : ".env";
dotenv.config({ path: envFile });
// optional fallback so shared vars in .env still apply
dotenv.config({ path: ".env" });

import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().default(5000),

  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),

  JWT_SECRET: z.string().min(16, "JWT_SECRET must be at least 16 characters"),
  JWT_EXPIRES_IN: z.string().default("12h"),

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
};