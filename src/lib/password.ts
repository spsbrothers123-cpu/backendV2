import bcrypt from "bcryptjs";

const SALT_ROUNDS = 12;

// Mirrors the cashier signup frontend's requirements exactly (see
// Cashier2_0/src/utils/authValidation.js): >= 8 chars, at least one
// letter, at least one number. Frontend validation is a UX nicety only —
// this is the rule that actually gets enforced.
export function isPasswordStrongEnough(password: string): boolean {
  if (typeof password !== "string") return false;
  if (password.length < 8) return false;
  if (!/[A-Za-z]/.test(password)) return false;
  if (!/\d/.test(password)) return false;
  return true;
}

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, SALT_ROUNDS);
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}
