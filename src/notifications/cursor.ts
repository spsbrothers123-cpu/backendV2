import { AppError } from "../lib/errors.js";

export interface CursorPayload {
  /** createdAt of the last item (ISO) */
  t: string;
  /** recipient row id of the last item */
  i: string;
  /** fingerprint of the filter set the cursor was issued for */
  f: string;
}

export const encodeCursor = (c: CursorPayload): string => Buffer.from(JSON.stringify(c), "utf8").toString("base64url");

/** A malformed cursor, or one issued for a different filter set, is 400 INVALID_CURSOR (Cashier contract). */
export function decodeCursor(raw: string, filterFingerprint: string): CursorPayload {
  const bad = () => new AppError(400, "INVALID_CURSOR", "That page cursor is not valid. Refresh the list and try again.");
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as Partial<CursorPayload>;
    if (
      typeof parsed.t !== "string" ||
      typeof parsed.i !== "string" ||
      typeof parsed.f !== "string" ||
      !Number.isFinite(Date.parse(parsed.t)) ||
      parsed.f !== filterFingerprint
    ) {
      throw bad();
    }
    return { t: parsed.t, i: parsed.i, f: parsed.f };
  } catch (err) {
    throw err instanceof AppError ? err : bad();
  }
}
