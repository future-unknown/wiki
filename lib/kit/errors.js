/**
 * Domain error classes for wiki.
 *
 * Layers above wiki-kit (API, CLI) match on these classes / codes,
 * never on message strings.
 */

export class WikiError extends Error {
  /**
   * @param {string} message
   * @param {{ code?: string, details?: object }} [options]
   */
  constructor (message, { code, details } = {}) {
    super(message)
    this.name = this.constructor.name
    this.code = code || 'WIKI_ERROR'
    this.details = details || {}
  }
}

export class ValidationError extends WikiError {
  constructor (message, details) {
    super(message, { code: 'VALIDATION_ERROR', details })
  }
}

export class NotFoundError extends WikiError {
  constructor (message, details) {
    super(message, { code: 'NOT_FOUND', details })
  }
}

export class AlreadyExistsError extends WikiError {
  constructor (message, details) {
    super(message, { code: 'ALREADY_EXISTS', details })
  }
}

export class RevisionConflictError extends WikiError {
  constructor (message, details) {
    super(message, { code: 'REVISION_CONFLICT', details })
  }
}

export class NonEmptyNodeError extends WikiError {
  constructor (message, details) {
    super(message, { code: 'NON_EMPTY_NODE', details })
  }
}

export class CrossWikiMoveError extends WikiError {
  constructor (message, details) {
    super(message, { code: 'CROSS_WIKI_MOVE', details })
  }
}

export class InvalidMoveError extends WikiError {
  constructor (message, details) {
    super(message, { code: 'INVALID_MOVE', details })
  }
}

export class RecordsUnavailableError extends WikiError {
  constructor (message = 'no record store is configured', details) {
    super(message, { code: 'RECORDS_UNAVAILABLE', details })
  }
}
