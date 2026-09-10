/**
 * The wiki method table, declared: every method's params, what it
 * returns, the action it exercises, and — in words — what it does and
 * what each param means. One source feeds two readers —
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
  'wiki.list': {
    describe: 'Every wiki the caller may read, as root pages.',
    params: {},
    about: {},
    returns: 'page[]',
    action: 'read'
  },
  'wiki.get': {
    describe: 'Read one page: its title, content, metadata, and revision, as it is now or as it was at a commit or time.',
    params: { path: 'string', commitId: 'number?', at: 'string?' },
    about: { path: 'the full path of the page, wiki slug first', commitId: 'read the page as of this commit', at: 'read the page as of this ISO-8601 time' },
    returns: 'page',
    action: 'read'
  },
  'wiki.set': {
    describe: 'Write a page whole: create it, or replace its content, title, or metadata, guarded by the revision the caller last saw.',
    params: { path: 'string', content: 'string?', title: 'string?', metadata: 'object?', expectedRevisionId: 'string?', message: 'string?' },
    about: { path: 'the full path of the page', content: 'the whole Markdown body', title: 'the page title', metadata: 'the page metadata, replaced whole', expectedRevisionId: 'refuse unless the page is still at this revision', message: 'a commit message' },
    returns: 'change',
    action: 'write'
  },
  'wiki.tree': {
    describe: 'The page hierarchy under a path, with each page\'s record count.',
    params: { path: 'string', depth: 'number?', commitId: 'number?', at: 'string?' },
    about: { path: 'the full path to start from; the wiki slug alone is the whole wiki', depth: 'how many levels down to include', commitId: 'the tree as of this commit', at: 'the tree as of this ISO-8601 time' },
    returns: 'tree',
    action: 'read'
  },
  'wiki.search': {
    describe: 'Full-text search over page content under a path.',
    params: { path: 'string', query: 'string', limit: 'number?' },
    about: { path: 'the full path to search under', query: 'the words to find', limit: 'at most this many hits' },
    returns: 'hit[]',
    action: 'read'
  },
  'wiki.history': {
    describe: 'A page\'s revisions, newest first.',
    params: { path: 'string', limit: 'number?' },
    about: { path: 'the full path of the page', limit: 'at most this many revisions' },
    returns: 'revision[]',
    action: 'read'
  },
  'wiki.log': {
    describe: 'The wiki\'s commit log under a path, newest first, each commit with the pages it changed.',
    params: { path: 'string', limit: 'number?', before: 'number?' },
    about: { path: 'the full path to read the log under', limit: 'at most this many commits', before: 'only commits before this commit id' },
    returns: 'commit[]',
    action: 'read'
  },
  'wiki.move': {
    describe: 'Move or rename a page and everything under it.',
    params: { from: 'string', to: 'string', expectedRevisionId: 'string?', message: 'string?' },
    about: { from: 'the full path of the page now', to: 'the full path it should have', expectedRevisionId: 'refuse unless the page is still at this revision', message: 'a commit message' },
    returns: 'page',
    action: 'write'
  },
  'wiki.remove': {
    describe: 'Delete a page, or a page and its subtree.',
    params: { path: 'string', recursive: 'boolean?', expectedRevisionId: 'string?', expectedCommitId: 'number?', message: 'string?' },
    about: { path: 'the full path of the page', recursive: 'delete the pages beneath it too', expectedRevisionId: 'refuse unless the page is still at this revision', expectedCommitId: 'refuse unless the wiki is still at this commit', message: 'a commit message' },
    returns: 'removal',
    action: 'delete'
  },
  'wiki.notes': {
    describe: 'The open notes on a page, or on a subtree.',
    params: { path: 'string', includeResolved: 'boolean?', subtree: 'boolean?' },
    about: { path: 'the full path of the page', includeResolved: 'include notes already resolved', subtree: 'include notes on pages beneath it' },
    returns: 'note[]',
    action: 'read'
  },
  'wiki.note': {
    describe: 'Leave a note on a page: feedback for whoever tends it.',
    params: { path: 'string', body: 'string' },
    about: { path: 'the full path of the page', body: 'the note' },
    returns: 'note',
    action: 'write'
  },
  'wiki.resolveNote': {
    describe: 'Resolve a note on a page.',
    params: { path: 'string', noteId: 'string' },
    about: { path: 'the full path of the page', noteId: 'the note to resolve' },
    returns: 'note',
    action: 'write'
  },
  'wiki.put': {
    describe: 'Write a record to a page: an upsert by key on a keyed page, an append on an unkeyed one. Records are stamped with the actor, time, and version, never versioned.',
    params: { path: 'string', value: 'object', ts: 'string?', ifVersion: 'number?' },
    about: { path: 'the full path of the page', value: 'the record, a JSON object; on a keyed page it must carry the key field, and it must match the page\'s schema if one is declared', ts: 'the record\'s time on an unkeyed page, ISO-8601; defaults to now', ifVersion: 'on a keyed page, refuse unless the record is still at this version' },
    returns: 'record',
    action: 'put'
  },
  'wiki.del': {
    describe: 'Delete one record from a page.',
    params: { path: 'string', key: 'string' },
    about: { path: 'the full path of the page', key: 'the record\'s key on a keyed page, or its _id on an unkeyed one' },
    returns: 'record',
    action: 'put'
  },
  'wiki.data': {
    describe: 'Read a page\'s records: one by key, or a range by time, paged by cursor. Keyed pages read in key order, unkeyed pages in time order.',
    params: { path: 'string', key: 'string?', latest: 'boolean?', since: 'string?', until: 'string?', limit: 'number?', cursor: 'string?', reverse: 'boolean?' },
    about: { path: 'the full path of the page', key: 'one record, by key; combines with no other option', latest: 'only the newest record', since: 'records at or after this ISO-8601 time', until: 'records before this ISO-8601 time', limit: 'at most this many records', cursor: 'continue a previous read from where it stopped', reverse: 'newest first, or highest key first' },
    returns: 'records',
    action: 'read'
  },
  'wiki.meta': {
    describe: 'Merge declarations into a page\'s metadata: the record key, the record schema, retention. A null value removes one.',
    params: { path: 'string', metadata: 'object', replace: 'boolean?', expectedRevisionId: 'string?', message: 'string?' },
    about: { path: 'the full path of the page', metadata: 'the declarations to merge', replace: 'replace the metadata whole instead of merging', expectedRevisionId: 'refuse unless the page is still at this revision', message: 'a commit message' },
    returns: 'change',
    action: 'write'
  },
  'wiki.getCommit': {
    describe: 'One commit of a wiki, with what it changed; the latest when no id is given.',
    params: { wiki: 'string', commitId: 'number?' },
    about: { wiki: 'the wiki slug', commitId: 'the commit to read' },
    returns: 'commit',
    action: 'read'
  },
  'wiki.revision': {
    describe: 'One revision of a page by id, and the revision before it, for a diff.',
    params: { wiki: 'string', revisionId: 'string' },
    about: { wiki: 'the wiki slug', revisionId: 'the revision to read' },
    returns: 'revision',
    action: 'read'
  },
  'wiki.snapshot': {
    describe: 'Every page of a wiki as it was at a commit or time.',
    params: { wiki: 'string', commitId: 'number?', at: 'string?' },
    about: { wiki: 'the wiki slug', commitId: 'the wiki as of this commit', at: 'the wiki as of this ISO-8601 time' },
    returns: 'snapshot',
    action: 'read'
  }
})

for (const [name, declaration] of Object.entries(METHOD_DECLARATIONS)) {
  if (typeof declaration.describe !== 'string' || !declaration.describe) throw new Error(`${name}: no description`)
  for (const [param, spec] of Object.entries(declaration.params)) {
    if (!TYPE_PATTERN.test(spec)) throw new Error(`${name}: bad type for ${param}: ${spec}`)
    if (typeof declaration.about[param] !== 'string') throw new Error(`${name}: ${param} is not described`)
  }
  for (const param of Object.keys(declaration.about)) {
    if (!(param in declaration.params)) throw new Error(`${name}: ${param} is described but not declared`)
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
