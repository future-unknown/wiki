/**
 * The wiki method table, declared: every method's params, what it
 * returns, and the action it exercises. One source feeds two readers —
 * the method table validates each call against it before the handler
 * runs, and a host's discovery document publishes it — so what a
 * client is told and what the server checks cannot drift apart.
 *
 * Param types are `string`, `number`, `boolean`, or `object`, with a
 * trailing `?` when optional. A required param must be present and not
 * null; an optional one, when given, must be of its type. Finer rules
 * (a positive commit id, an ISO timestamp, a JSON-serializable record)
 * stay with the kit, which knows them. Path params take full paths —
 * the first segment is the wiki's slug — and `wiki` takes a slug alone.
 */

import { ValidationError } from '../kit/index.js'

const TYPE_PATTERN = /^(string|number|boolean|object)(\?)?$/

export const METHOD_DECLARATIONS = Object.freeze({
  'wiki.list': { params: {}, returns: 'page[]', action: 'read' },
  'wiki.get': { params: { path: 'string', commitId: 'number?', at: 'string?' }, returns: 'page', action: 'read' },
  'wiki.set': { params: { path: 'string', content: 'string?', title: 'string?', metadata: 'object?', expectedRevisionId: 'string?', message: 'string?' }, returns: 'change', action: 'write' },
  'wiki.tree': { params: { path: 'string', depth: 'number?', commitId: 'number?', at: 'string?' }, returns: 'tree', action: 'read' },
  'wiki.search': { params: { path: 'string', query: 'string', limit: 'number?' }, returns: 'hit[]', action: 'read' },
  'wiki.history': { params: { path: 'string', limit: 'number?' }, returns: 'revision[]', action: 'read' },
  'wiki.log': { params: { path: 'string', limit: 'number?', before: 'number?' }, returns: 'commit[]', action: 'read' },
  'wiki.move': { params: { from: 'string', to: 'string', expectedRevisionId: 'string?', message: 'string?' }, returns: 'page', action: 'write' },
  'wiki.remove': { params: { path: 'string', recursive: 'boolean?', expectedRevisionId: 'string?', expectedCommitId: 'number?', message: 'string?' }, returns: 'removal', action: 'delete' },
  'wiki.notes': { params: { path: 'string', includeResolved: 'boolean?', subtree: 'boolean?' }, returns: 'note[]', action: 'read' },
  'wiki.note': { params: { path: 'string', body: 'string' }, returns: 'note', action: 'write' },
  'wiki.resolveNote': { params: { path: 'string', noteId: 'string' }, returns: 'note', action: 'write' },
  'wiki.put': { params: { path: 'string', value: 'object', ts: 'string?', ifVersion: 'number?' }, returns: 'record', action: 'put' },
  'wiki.del': { params: { path: 'string', key: 'string' }, returns: 'record', action: 'put' },
  'wiki.data': { params: { path: 'string', key: 'string?', latest: 'boolean?', since: 'string?', until: 'string?', limit: 'number?', cursor: 'string?', reverse: 'boolean?' }, returns: 'records', action: 'read' },
  'wiki.meta': { params: { path: 'string', metadata: 'object', replace: 'boolean?', expectedRevisionId: 'string?', message: 'string?' }, returns: 'change', action: 'write' },
  'wiki.getCommit': { params: { wiki: 'string', commitId: 'number?' }, returns: 'commit', action: 'read' },
  'wiki.revision': { params: { wiki: 'string', revisionId: 'string' }, returns: 'revision', action: 'read' },
  'wiki.snapshot': { params: { wiki: 'string', commitId: 'number?', at: 'string?' }, returns: 'snapshot', action: 'read' }
})

for (const [name, declaration] of Object.entries(METHOD_DECLARATIONS)) {
  for (const [param, spec] of Object.entries(declaration.params)) {
    if (!TYPE_PATTERN.test(spec)) throw new Error(`${name}: bad type for ${param}: ${spec}`)
  }
}

/**
 * Check a call's params against the method's declaration. Throws
 * ValidationError naming the first offending param in `details.param`.
 */
export function validateParams (name, params) {
  const declaration = METHOD_DECLARATIONS[name]
  if (!declaration) throw new Error(`no such method: ${name}`)
  if (params === undefined) return
  if (params === null || typeof params !== 'object' || Array.isArray(params)) {
    throw new ValidationError('params must be an object', {})
  }
  for (const [param, spec] of Object.entries(declaration.params)) {
    const [, type, optional] = TYPE_PATTERN.exec(spec)
    const value = params[param]
    if (value === undefined || value === null) {
      if (!optional) throw new ValidationError(`${param} is required`, { param })
      continue
    }
    if (!isOfType(value, type)) {
      throw new ValidationError(`${param} must be ${article(type)} ${type}`, { param })
    }
  }
}

function isOfType (value, type) {
  if (type === 'object') return typeof value === 'object' && !Array.isArray(value)
  return typeof value === type
}

function article (type) {
  return type === 'object' ? 'an' : 'a'
}
