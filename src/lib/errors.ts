import type { ApiErrorCode } from "@/lib/types";

export const API_ERROR_STATUS: Record<ApiErrorCode, number> = {
  INVALID_REQUEST: 400,
  UNAUTHENTICATED: 401,
  SESSION_RESTRICTED: 403,
  SESSION_REVOKED: 403,
  NOT_TRUSTED_CHANNEL: 403,
  NOT_FOUND: 404,
  PAYMENT_HELD: 409,
  CONFLICT: 409,
  INSUFFICIENT_FUNDS: 422,
};

/** Error raised by domain functions. Route handlers map it to the ApiError shape. */
export class DomainError extends Error {
  readonly code: ApiErrorCode;

  constructor(code: ApiErrorCode, message: string) {
    super(message);
    this.name = "DomainError";
    this.code = code;
  }

  get status(): number {
    return API_ERROR_STATUS[this.code];
  }
}
