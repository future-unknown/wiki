/**
 * Canonical command definitions for the wiki CLI.
 *
 * This is the single source of truth for the CLI surface: the parser,
 * `wiki help`, and the wiki-skills documentation checks all read it,
 * so reference material cannot silently drift.
 */

export const globalOptions = {
  url: { type: 'string', description: 'API base URL (defaults to WIKI_URL)' },
  token: { type: 'string', description: 'bearer token (defaults to WIKI_TOKEN)' },
  json: { type: 'boolean', description: 'structured JSON output on stdout' },
  help: { type: 'boolean', description: 'show help' }
}

export const commands = {
  // Pages: authored writing
  read: {
    usage: 'wiki read <path>',
    summary: 'Print a page (raw content on stdout; --json for full structured data)',
    options: {
      change: { type: 'string', description: 'read as of a change id' },
      at: { type: 'string', description: 'read as of an ISO-8601 timestamp' }
    },
    examples: ['wiki read acme.about.foo', 'wiki read acme.about.foo --json', 'wiki read acme.about.foo --change 123']
  },
  write: {
    usage: 'wiki write <path> [content]',
    summary: 'Write a page whole: create or replace it (inline content, stdin, or --file; one source only)',
    options: {
      file: { type: 'string', description: 'read content from a file' },
      title: { type: 'string', description: 'set the page title' },
      metadata: { type: 'string', description: 'set page metadata as a JSON object' },
      'if-revision': { type: 'string', description: 'fail unless the page is still at this revision id' },
      message: { type: 'string', description: 'a note on the change' }
    },
    examples: [
      'wiki write acme "This is the acme wiki"',
      'wiki write acme.about.foo < foo.md',
      'wiki write acme.about.foo --file foo.md --if-revision <revisionId>'
    ]
  },
  edit: {
    usage: 'wiki edit <path> --old <text> --new <text>',
    summary: 'Change part of a page: replace one exact string (refused unless it occurs exactly once, or --all)',
    options: {
      old: { type: 'string', description: 'the exact text to replace' },
      new: { type: 'string', description: 'the text to put in its place' },
      all: { type: 'boolean', description: 'replace every occurrence' },
      'if-revision': { type: 'string', description: 'fail unless the page is still at this revision id' },
      message: { type: 'string', description: 'a note on the change' }
    },
    examples: [
      'wiki edit acme.about.foo --old "Q3 targets" --new "Q4 targets"',
      'wiki edit acme.about.foo --old "acme" --new "Acme" --all'
    ]
  },
  move: {
    usage: 'wiki move <from> <to>',
    summary: 'Move or rename a page (identity and subtree preserved)',
    options: {
      'if-revision': { type: 'string', description: 'fail unless the page is still at this revision id' },
      message: { type: 'string', description: 'a note on the change' }
    },
    examples: ['wiki move acme.about.foo acme.archive.foo']
  },
  rm: {
    usage: 'wiki rm <path>',
    summary: 'Delete a page (history is preserved; a page with pages beneath it needs --recursive)',
    options: {
      recursive: { type: 'boolean', description: 'delete the whole subtree' },
      'if-revision': { type: 'string', description: 'fail unless the page is still at this revision id' },
      'if-change': { type: 'string', description: 'fail unless the wiki is still at this change id' },
      message: { type: 'string', description: 'a note on the change' }
    },
    examples: ['wiki rm acme.about.foo', 'wiki rm acme.about --recursive']
  },
  tree: {
    usage: 'wiki tree <path>',
    summary: 'Show the page hierarchy with single-line previews',
    options: {
      depth: { type: 'string', description: 'limit tree depth' },
      change: { type: 'string', description: 'tree as of a change id' },
      at: { type: 'string', description: 'tree as of an ISO-8601 timestamp' }
    },
    examples: ['wiki tree acme', 'wiki tree acme --depth 2', 'wiki tree acme --at 2026-08-01T12:00:00Z']
  },
  search: {
    usage: 'wiki search <path> <query>',
    summary: 'Full-text search within a subtree, over pages and table records; returns addresses and excerpts',
    options: {
      limit: { type: 'string', description: 'maximum number of results' }
    },
    examples: ['wiki search acme "authentication"', 'wiki search acme.architecture "tokens" --json']
  },
  links: {
    usage: 'wiki links <path>[/<key>]',
    summary: 'Show what links to a page or a table record: pages and records carrying a wikilink to it',
    options: {
      limit: { type: 'string', description: 'maximum number of links' }
    },
    examples: ['wiki links acme.crm.contacts/jo', 'wiki links acme.architecture --json']
  },
  meta: {
    usage: 'wiki meta <path> [json]',
    summary: 'Merge fields into a page’s metadata (a null value removes its field)',
    options: {
      replace: { type: 'boolean', description: 'replace the whole metadata object instead of merging' },
      'if-revision': { type: 'string', description: 'fail unless the page is still at this revision id' },
      message: { type: 'string', description: 'a note on the change' }
    },
    examples: [
      'wiki meta acme.usage \'{"retain": {"days": 90}}\'',
      'wiki meta acme.tasks \'{"key": "id", "schema": {"type": "object", "required": ["id"]}}\'',
      'wiki meta acme.tasks \'{"retain": {"versions": 50}}\'',
      'wiki meta acme.usage \'{"retain": null}\''
    ]
  },

  // Records: data on a page
  records: {
    usage: 'wiki records <path>',
    summary: 'Read a page’s records: a range in sort order, or the records as they stood at a moment',
    options: {
      latest: { type: 'boolean', description: 'only the newest record' },
      reverse: { type: 'boolean', description: 'reverse the sort order: newest first on a log, highest key first on a table' },
      since: { type: 'string', description: 'records at or after an ISO-8601 timestamp' },
      until: { type: 'string', description: 'records at or before an ISO-8601 timestamp' },
      limit: { type: 'string', description: 'maximum number of records' },
      cursor: { type: 'string', description: 'continue from a previous read’s continuation token' },
      at: { type: 'string', description: 'the records as they stood at an ISO-8601 timestamp' }
    },
    examples: [
      'wiki records acme.tasks --at 2026-09-01T00:00:00Z',
      'wiki records acme.usage --since 2026-08-01T00:00:00Z --limit 100',
      'wiki records acme.usage --reverse --limit 20',
      'wiki records acme.usage --latest'
    ]
  },
  get: {
    usage: 'wiki get <path>/<key>',
    summary: 'Print one record: a table’s row by key, or a log entry by its _id',
    options: {},
    examples: ['wiki get acme.tasks/t-41', 'wiki get acme.tasks/t-41 --json']
  },
  set: {
    usage: 'wiki set <path> [json]',
    summary: 'Write a record (a JSON object): on a table (a page with a key) it adds or replaces the row with its key; on a log it adds an entry',
    options: {
      ts: { type: 'string', description: 'when it happened, on a log (ISO-8601; defaults to now)' },
      'if-version': { type: 'string', description: 'fail unless the row is still at this version (tables)' }
    },
    examples: [
      'wiki set acme.usage \'{"requests": 1042}\'',
      'wiki set acme.tasks \'{"id": "t-41", "status": "claimed"}\' --if-version 1',
      'wiki set acme.usage --ts 2026-08-01T00:00:00Z < record.json'
    ]
  },
  del: {
    usage: 'wiki del <path>/<key>',
    summary: 'Delete one record by its key (tables) or its _id (logs); a table keeps the deletion in the row’s history',
    options: {},
    examples: ['wiki del acme.tasks/t-41']
  },

  // History, of a page or a row
  history: {
    usage: 'wiki history <path>[/<key>]',
    summary: 'Show a page’s revisions, or a table row’s versions, newest first',
    options: {
      limit: { type: 'string', description: 'maximum number of revisions or versions' },
      cursor: { type: 'string', description: 'continue a row’s versions from a previous read’s continuation token' }
    },
    examples: ['wiki history acme.about.foo', 'wiki history acme.crm.contacts/jo --json']
  },
  diff: {
    usage: 'wiki diff <path>[/<key>]',
    summary: 'Show what a revision or a row version changed, against the one before it (latest by default)',
    options: {
      change: { type: 'string', description: 'the page’s revision as of this change id' },
      revision: { type: 'string', description: 'a revision id, as listed by history and changes' },
      version: { type: 'string', description: 'a table row’s version, as listed by history' }
    },
    examples: [
      'wiki diff acme.about.foo',
      'wiki diff acme.about.foo --change 12',
      'wiki diff acme.about.foo --revision <id> --json',
      'wiki diff acme.crm.contacts/jo --version 3'
    ]
  },

  // Changes across a wiki
  changes: {
    usage: 'wiki changes <path>',
    summary: 'Show what changed in a wiki, newest first: each change and the pages it touched',
    options: {
      limit: { type: 'string', description: 'maximum number of changes' },
      before: { type: 'string', description: 'continue from before this change id' }
    },
    examples: ['wiki changes acme', 'wiki changes acme.about --limit 10', 'wiki changes acme --json']
  }
}

export const exitCodes = {
  success: 0,
  failure: 1,
  invalidArguments: 2,
  notFound: 3,
  conflict: 4,
  unauthenticated: 5,
  unauthorized: 6
}
