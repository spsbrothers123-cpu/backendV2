import type { z } from "zod";
import { Errors } from "./errors.js";

export function parseBody<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
  const result = schema.safeParse(input);
  if (!result.success) {
    const firstIssue = result.error.issues[0];
    const message = firstIssue ? `${firstIssue.path.join(".") || "value"}: ${firstIssue.message}` : "Invalid request.";
    throw Errors.validation(message);
  }
  return result.data;
}