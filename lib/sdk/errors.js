/**
 * SDK error classes. These mirror the API's structured error codes so
 * callers can catch typed errors without knowing about JSON-RPC.
 * The SDK is environment-neutral, so it defines its own classes rather
 * than importing server-side packages.
 */

export class WikiClientError extends Error {
  /**
   * @param {string} message
   * @param {{ code?: string, details?: object, rpcCode?: number }} [options]
   */
  constructor (message, { code, details, rpcCode } = {}) {
    super(message)
    this.name = this.constructor.name
    this.code = code || 'CLIENT_ERROR'
    this.details = details || {}
    this.rpcCode = rpcCode
  }
}

export class ValidationError extends WikiClientError {}
export class NotFoundError extends WikiClientError {}
export class AlreadyExistsError extends WikiClientError {}
export class RevisionConflictError extends WikiClientError {}
export class NonEmptyNodeError extends WikiClientError {}
export class CrossWikiMoveError extends WikiClientError {}
export class InvalidMoveError extends WikiClientError {}
export class UnauthenticatedError extends WikiClientError {}
export class UnauthorizedError extends WikiClientError {}
export class RecordsUnavailableError extends WikiClientError {}
export class NetworkError extends WikiClientError {}
export class RpcError extends WikiClientError {}

const classByCode = {
  VALIDATION_ERROR: ValidationError,
  NOT_FOUND: NotFoundError,
  ALREADY_EXISTS: AlreadyExistsError,
  REVISION_CONFLICT: RevisionConflictError,
  NON_EMPTY_NODE: NonEmptyNodeError,
  CROSS_WIKI_MOVE: CrossWikiMoveError,
  INVALID_MOVE: InvalidMoveError,
  UNAUTHENTICATED: UnauthenticatedError,
  UNAUTHORIZED: UnauthorizedError,
  RECORDS_UNAVAILABLE: RecordsUnavailableError
}

/**
 * Map a JSON-RPC error object to a typed SDK error.
 *
 * @param {{ code: number, message: string, data?: { code?: string, details?: object } }} error
 */
export function errorFromRpc (error) {
  const domainCode = error.data?.code
  const ErrorClass = (domainCode && classByCode[domainCode]) || RpcError
  return new ErrorClass(error.message, {
    code: domainCode || 'RPC_ERROR',
    details: error.data?.details,
    rpcCode: error.code
  })
}
