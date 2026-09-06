/**
 * A single error type carried through the whole backend. Every thrown
 * AppError is caught once, centrally, in server.ts's setErrorHandler and
 * turned into a consistent JSON body — routes never format error responses
 * by hand.
 */
export class AppError extends Error {
  statusCode: number;
  code: string;

  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.name = "AppError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

export const Errors = {
  validation: (message: string) => new AppError(422, "VALIDATION_ERROR", message),
  badRequest: (message: string, code = "BAD_REQUEST") => new AppError(400, code, message),
  unauthorized: (message = "Authentication required.", code = "UNAUTHORIZED") =>
    new AppError(401, code, message),
  forbidden: (message = "You don't have permission to do that.", code = "FORBIDDEN") =>
    new AppError(403, code, message),
  notFound: (message = "Not found.", code = "NOT_FOUND") => new AppError(404, code, message),
  conflict: (message: string, code = "CONFLICT") => new AppError(409, code, message),
  rateLimited: (message = "Too many requests. Please try again later.") =>
    new AppError(429, "RATE_LIMITED", message),
  internal: (message = "Something went wrong on our end. Please try again.") =>
    new AppError(500, "INTERNAL_ERROR", message),
};
