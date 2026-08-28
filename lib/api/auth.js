/**
 * Pluggable authentication for wiki-api.
 *
 * An auth implementation provides:
 *   authenticate(request) -> principal (throw UnauthenticatedError otherwise)
 *   authorize(principal, operation) -> void (throw UnauthorizedError otherwise)
 *
 * A principal carries the trusted audit actor passed down to wiki-kit:
 *   { actor: { type, id, onBehalfOf } }
 */

import { WikiError } from '../kit/index.js'

export class UnauthenticatedError extends WikiError {
  constructor (message = 'authentication required', details) {
    super(message, { code: 'UNAUTHENTICATED', details })
  }
}

export class UnauthorizedError extends WikiError {
  constructor (message = 'operation not allowed', details) {
    super(message, { code: 'UNAUTHORIZED', details })
  }
}

/**
 * Minimal static bearer-token auth for development and tests.
 *
 * @param {{ tokens: Record<string, { actor: object, allow?: string[], wikis?: string[] }> }} options
 *   `allow` optionally restricts a token to specific actions
 *   (e.g. ['wiki:read']); omitted means all actions.
 *   `wikis` optionally restricts a token to specific wikis by root
 *   slug (e.g. ['acme']); omitted means all wikis. A grant is the
 *   product of the two: every allowed action on every allowed wiki.
 *   The wiki is the whole boundary — there is no finer scope.
 */
export function createStaticTokenAuth ({ tokens }) {
  return {
    async authenticate (request) {
      const header = request.headers.authorization || ''
      const match = header.match(/^Bearer\s+(.+)$/i)
      if (!match) throw new UnauthenticatedError()
      const entry = tokens[match[1]]
      if (!entry) throw new UnauthenticatedError('invalid token')
      return { actor: entry.actor, allow: entry.allow ?? null, wikis: entry.wikis ?? null }
    },

    async authorize (principal, operation) {
      if (principal.allow && !principal.allow.includes(operation.action)) {
        throw new UnauthorizedError(`not allowed: ${operation.action}`, {
          action: operation.action,
          wiki: operation.wiki
        })
      }
      // operation.wiki is null when the call addresses no particular
      // wiki (wiki.list); the method then authorizes each wiki it
      // would return, so a scoped token sees only its own.
      if (principal.wikis && operation.wiki !== null && !principal.wikis.includes(operation.wiki)) {
        throw new UnauthorizedError(`not allowed: wiki ${operation.wiki}`, {
          action: operation.action,
          wiki: operation.wiki
        })
      }
    }
  }
}
