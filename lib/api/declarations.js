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
 * stay with the kit, which knows them. `misuse` names params that mark
 * a call meant for another method — a required one left out, or one
 * this method does not take — with the words that point there. Path
 * params take full paths —
 * the first segment is the wiki's name — and `wiki` takes a name alone.
 */

import { ValidationError } from '../kit/index.js'

const TYPE_PATTERN = /^(string|number|boolean|object)(\?)?$/

export const METHOD_DECLARATIONS = Object.freeze({
  // Wikis
  'wiki.list': {
    describe: 'Every wiki the caller may read, as root pages.',
    params: {},
    about: {},
    returns: 'page[]',
    action: 'read'
  },

  // Pages: authored writing, read and written whole, edited in place
  'wiki.read': {
    describe: 'Read one page: its title, content, metadata, and revision, as it is now or as it was at a change or time.',
    params: { path: 'string', changeId: 'number?', at: 'string?' },
    about: { path: 'the full path of the page, wiki name first', changeId: 'read the page as of this change', at: 'read the page as of this ISO-8601 time' },
    returns: 'page',
    action: 'read',
    misuse: { key: 'records are read with wiki.get' }
  },
  'wiki.write': {
    describe: 'Write a page whole: create it, or replace its content, title, or metadata, guarded by the revision the caller last read.',
    params: { path: 'string', content: 'string?', title: 'string?', metadata: 'object?', ifRevision: 'string?', message: 'string?' },
    about: { path: 'the full path of the page', content: 'the whole Markdown body', title: 'the page title', metadata: 'the page metadata, replaced whole', ifRevision: 'refuse unless the page is still at this revision', message: 'a note on the change' },
    returns: 'change',
    action: 'write'
  },
  'wiki.edit': {
    describe: 'Change part of a page: replace one exact string in its content. Refused unless the string occurs exactly once, or replaceAll is given.',
    params: { path: 'string', oldString: 'string', newString: 'string', replaceAll: 'boolean?', ifRevision: 'string?', message: 'string?' },
    about: { path: 'the full path of the page', oldString: 'the exact text to replace, with enough around it to occur once', newString: 'the text to put in its place', replaceAll: 'replace every occurrence', ifRevision: 'refuse unless the page is still at this revision', message: 'a note on the change' },
    returns: 'change',
    action: 'write'
  },
  'wiki.move': {
    describe: 'Move or rename a page and everything under it.',
    params: { from: 'string', to: 'string', ifRevision: 'string?', message: 'string?' },
    about: { from: 'the full path of the page now', to: 'the full path it should have', ifRevision: 'refuse unless the page is still at this revision', message: 'a note on the change' },
    returns: 'page',
    action: 'write'
  },
  'wiki.remove': {
    describe: 'Delete a page, or a page and its subtree.',
    params: { path: 'string', recursive: 'boolean?', ifRevision: 'string?', ifChange: 'number?', message: 'string?' },
    about: { path: 'the full path of the page', recursive: 'delete the pages beneath it too', ifRevision: 'refuse unless the page is still at this revision', ifChange: 'refuse unless the wiki is still at this change', message: 'a note on the change' },
    returns: 'removal',
    action: 'delete'
  },
  'wiki.tree': {
    describe: 'The page hierarchy under a path, with each page\'s record count.',
    params: { path: 'string', depth: 'number?', changeId: 'number?', at: 'string?' },
    about: { path: 'the full path to start from; the wiki name alone is the whole wiki', depth: 'how many levels down to include', changeId: 'the tree as of this change', at: 'the tree as of this ISO-8601 time' },
    returns: 'tree',
    action: 'read'
  },
  'wiki.search': {
    describe: 'Full-text search under a path: pages, and the records of tables. A record hit names its page and key.',
    params: { path: 'string', query: 'string', limit: 'number?' },
    about: { path: 'the full path to search under', query: 'the words to find', limit: 'at most this many hits' },
    returns: 'hit[]',
    action: 'read'
  },
  'wiki.links': {
    describe: 'What links to a page, or to one of its records: the pages whose content and the records that carry a wikilink to it. A linking record comes with its value.',
    params: { path: 'string', key: 'string?', limit: 'number?' },
    about: { path: 'the full path of the page', key: 'a record of the page, by key; without it, the page itself', limit: 'at most this many links' },
    returns: 'links',
    action: 'read'
  },
  'wiki.updateMeta': {
    describe: 'Merge declarations into a page\'s metadata: the record key (which makes the page a table), the record schema, retention (retain.days on a log, retain.versions on a table). A null value removes one.',
    params: { path: 'string', metadata: 'object', replace: 'boolean?', ifRevision: 'string?', message: 'string?' },
    about: { path: 'the full path of the page', metadata: 'the declarations to merge', replace: 'replace the metadata whole instead of merging', ifRevision: 'refuse unless the page is still at this revision', message: 'a note on the change' },
    returns: 'change',
    action: 'write'
  },

  // Records: data on a page — rows of a table by key, entries of a log
  'wiki.records': {
    describe: 'Read a page\'s records: a range by time, paged by cursor, or the records the page held at a moment. Tables read in key order, logs in time order. One record by key is wiki.get.',
    params: { path: 'string', latest: 'boolean?', since: 'string?', until: 'string?', limit: 'number?', cursor: 'string?', reverse: 'boolean?', at: 'string?' },
    about: { path: 'the full path of the page', latest: 'only the newest record', since: 'records at or after this ISO-8601 time', until: 'records before this ISO-8601 time', limit: 'at most this many records', cursor: 'continue a previous read from where it stopped', reverse: 'newest first, or highest key first', at: 'the records as they stood at this ISO-8601 time: a table whole, with `unknown` naming keys whose state then was not kept; a log in pages, the records written by then' },
    returns: 'records',
    action: 'read',
    misuse: { key: 'one record by key is wiki.get' }
  },
  'wiki.get': {
    describe: 'Read one record by key: a table\'s row, or a log entry by its _id. Pages are read with wiki.read.',
    params: { path: 'string', key: 'string' },
    about: { path: 'the full path of the page that holds the record', key: 'the record\'s key on a table, or its _id on a log' },
    returns: 'record',
    action: 'read',
    misuse: { key: 'wiki.get reads one record by its key; pages are read with wiki.read' }
  },
  'wiki.set': {
    describe: 'Write one record: on a table (a page with a key) it adds or replaces the row with that key; on a log it adds an entry. Records are stamped with the actor, time, and version; a table keeps every version of each row. Pages are written with wiki.write.',
    params: { path: 'string', value: 'object', ts: 'string?', ifVersion: 'number?' },
    about: { path: 'the full path of the page', value: 'the record, a JSON object; on a table it must carry the key field, and it must match the page\'s schema if one is declared', ts: 'when it happened, on a log, ISO-8601; defaults to now', ifVersion: 'on a table, refuse unless the row is still at this version' },
    returns: 'record',
    action: 'set',
    misuse: { content: 'pages are written with wiki.write', title: 'pages are written with wiki.write', metadata: 'page metadata is changed with wiki.updateMeta' }
  },
  'wiki.del': {
    describe: 'Delete one record from a page.',
    params: { path: 'string', key: 'string' },
    about: { path: 'the full path of the page', key: 'the record\'s key on a table, or its _id on a log' },
    returns: 'record',
    action: 'set'
  },

  // History: of a page, or of one row
  'wiki.history': {
    describe: 'How a page or a row got to be as it is, newest first: a page\'s revisions, or — with key — a table row\'s versions, each as the row that version left (no fields on a deletion) with its stamps and _change (created, updated, deleted).',
    params: { path: 'string', key: 'string?', limit: 'number?', cursor: 'string?' },
    about: { path: 'the full path of the page', key: 'a row of the table, by key; without it, the page itself', limit: 'at most this many revisions or versions', cursor: 'with key, continue a previous read from where it stopped' },
    returns: 'revision[] | versions',
    action: 'read'
  },
  'wiki.getRevision': {
    describe: 'One revision of a page by id, and the revision before it, for a diff.',
    params: { wiki: 'string', revisionId: 'string' },
    about: { wiki: 'the wiki name', revisionId: 'the revision to read' },
    returns: 'revision',
    action: 'read'
  },
  'wiki.getVersion': {
    describe: 'One version of a table row and the version before it, for a diff.',
    params: { path: 'string', key: 'string', version: 'number' },
    about: { path: 'the full path of the table', key: 'the row\'s key', version: 'the version to read' },
    returns: 'version',
    action: 'read'
  },

  // Notes: feedback on a page
  'wiki.notes': {
    describe: 'The open notes on a page, or on a subtree.',
    params: { path: 'string', includeResolved: 'boolean?', subtree: 'boolean?' },
    about: { path: 'the full path of the page', includeResolved: 'include notes already resolved', subtree: 'include notes on pages beneath it' },
    returns: 'note[]',
    action: 'read'
  },
  'wiki.addNote': {
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

  // Changes: what happened across a wiki
  'wiki.changes': {
    describe: 'What changed in a wiki, under a path, newest first: each change with who made it, its note, and the pages it touched.',
    params: { path: 'string', limit: 'number?', before: 'number?' },
    about: { path: 'the full path to read changes under; the wiki name alone is the whole wiki', limit: 'at most this many changes', before: 'only changes before this change id' },
    returns: 'change[]',
    action: 'read'
  },
  'wiki.getChange': {
    describe: 'One change to a wiki, with the revisions it made; the latest when no id is given.',
    params: { wiki: 'string', changeId: 'number?' },
    about: { wiki: 'the wiki name', changeId: 'the change to read' },
    returns: 'change',
    action: 'read'
  },
  'wiki.snapshot': {
    describe: 'Every page of a wiki as it was at a change or time.',
    params: { wiki: 'string', changeId: 'number?', at: 'string?' },
    about: { wiki: 'the wiki name', changeId: 'the wiki as of this change', at: 'the wiki as of this ISO-8601 time' },
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
  for (const [param, words] of Object.entries(declaration.misuse ?? {})) {
    if (typeof words !== 'string' || !words) throw new Error(`${name}: misuse of ${param} has no words`)
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
  for (const [param, words] of Object.entries(declaration.misuse ?? {})) {
    const given = params[param] !== undefined && params[param] !== null
    const declared = param in declaration.params
    if (declared ? !given : given) {
      throw new ValidationError(`${name} ${declared ? 'needs' : 'does not take'} ${param}: ${words}`, { param })
    }
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
