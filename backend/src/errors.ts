/** Error codes — keep in sync with docs/openapi.yaml. */
export type ErrorCode =
  | 'VALIDATION_ERROR'
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'DUPLICATE_SKU'
  | 'INVALID_STATE'
  | 'IDEMPOTENCY_KEY_REUSED'
  | 'OVER_RECEIPT'
  | 'ITEM_NOT_IN_DOCUMENT'
  | 'NOT_FULLY_RECEIVED'
  | 'PRODUCT_NOT_FOUND'
  | 'PRODUCT_INACTIVE'
  | 'INTERNAL_ERROR';

/** A business/HTTP error that is safe to show to the client. Services throw these; they never touch req/res. */
export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: ErrorCode,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const validationError = (message: string, details?: unknown) =>
  new AppError(400, 'VALIDATION_ERROR', message, details);
export const unauthenticated = (message = 'Authentication required') =>
  new AppError(401, 'UNAUTHENTICATED', message);
export const forbidden = (message = 'You do not have permission to perform this action') =>
  new AppError(403, 'FORBIDDEN', message);
export const notFound = (what: string) => new AppError(404, 'NOT_FOUND', `${what} not found`);
export const invalidState = (message: string, details?: unknown) =>
  new AppError(409, 'INVALID_STATE', message, details);
