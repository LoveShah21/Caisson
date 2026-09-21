import { z } from "zod";

export const ERROR_CODES = [
  "INVALID_REQUEST",
  "SESSION_NOT_FOUND",
  "SESSION_NOT_READY",
  "SESSION_EXPIRED",
  "SCOPE_DENIED",
  "POLICY_DENIED",
  "POLICY_UNAVAILABLE",
  "APPROVAL_REQUIRED",
  "APPROVAL_DENIED",
  "APPROVAL_TIMEOUT",
  "SECRET_UNAVAILABLE",
  "AUDIT_UNAVAILABLE",
  "ADAPTER_NOT_FOUND",
  "METHOD_NOT_FOUND",
  "PARAMS_INVALID",
  "SERVICE_TIMEOUT",
  "SERVICE_ERROR",
  "RATE_LIMITED",
  "SANDBOX_FAILED",
  "BINARY_NOT_ALLOWED",
  "PATH_DENIED",
  "INTERNAL",
] as const;

export const ErrorCodeSchema = z.enum(ERROR_CODES);

export type ErrorCode = z.infer<typeof ErrorCodeSchema>;

export class CaissonError extends Error {
  override readonly name = "CaissonError";

  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: Readonly<Record<string, unknown>>,
    override readonly cause?: unknown,
  ) {
    super(message, { cause });
  }
}

export function isErrorCode(value: unknown): value is ErrorCode {
  return ErrorCodeSchema.safeParse(value).success;
}
