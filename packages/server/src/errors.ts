/**
 * Structured error contract: every failure leaves the server as
 * `{ error: { kind, message, details } }` with a meaningful status, so the UI
 * can distinguish "you asked for a dim that does not exist" (400) from
 * "there is no such session" (404) from "this build cannot scan" (501).
 */

export type ErrorKind = 'bad_request' | 'not_found' | 'conflict' | 'not_implemented' | 'internal'

const STATUS: Record<ErrorKind, number> = {
  bad_request: 400,
  not_found: 404,
  conflict: 409,
  not_implemented: 501,
  internal: 500,
}

export class ApiError extends Error {
  override readonly name = 'ApiError'
  readonly status: number

  constructor(
    readonly kind: ErrorKind,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message)
    this.status = STATUS[kind]
  }

  static badRequest(message: string, details?: Record<string, unknown>): ApiError {
    return new ApiError('bad_request', message, details)
  }
  static notFound(message: string, details?: Record<string, unknown>): ApiError {
    return new ApiError('not_found', message, details)
  }
  static conflict(message: string, details?: Record<string, unknown>): ApiError {
    return new ApiError('conflict', message, details)
  }
  static notImplemented(message: string, details?: Record<string, unknown>): ApiError {
    return new ApiError('not_implemented', message, details)
  }
}

export interface ErrorBody {
  error: { kind: ErrorKind; message: string; details?: Record<string, unknown> }
}

export function toErrorBody(err: unknown): { status: number; body: ErrorBody } {
  if (err instanceof ApiError) {
    return { status: err.status, body: { error: { kind: err.kind, message: err.message, ...(err.details ? { details: err.details } : {}) } } }
  }
  const message = err instanceof Error ? err.message : String(err)
  return { status: 500, body: { error: { kind: 'internal', message } } }
}
