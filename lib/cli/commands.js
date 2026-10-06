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
  get: {
    usage: 'wiki get <path>',
    summary: 'Print node content (raw on stdout; --json for full structured data)',
    options: {
      commit: { type: 'string', description: 'read at a commit ID' },
      at: { type: 'string', description: 'read at an ISO-8601 timestamp' }
    },
    examples: ['wiki get acme.about.foo', 'wiki get acme.about.foo --json', 'wiki get acme.about.foo --commit 123']
  },
  set: {
    usage: 'wiki set <path> [content]',
    summary: 'Create or replace a node (inline content, stdin, or --file; one source only)',
    options: {
      file: { type: 'string', description: 'read content from a file' },
      title: { type: 'string', description: 'set the node title' },
      metadata: { type: 'string', description: 'set node metadata as a JSON object' },
      'if-revision': { type: 'string', description: 'fail unless the node is still at this revision ID' },
      message: { type: 'string', description: 'commit message' }
    },
    examples: [
      'wiki set acme "This is the acme wiki"',
      'wiki set acme.about.foo < foo.md',
      'wiki set acme.about.foo --file foo.md --if-revision <revisionId>'
    ]
  },
  tree: {
    usage: 'wiki tree <path>',
    summary: 'Show the node hierarchy with single-line previews',
    options: {
      depth: { type: 'string', description: 'limit tree depth' },
      commit: { type: 'string', description: 'tree at a commit ID' },
      at: { type: 'string', description: 'tree at an ISO-8601 timestamp' }
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
  history: {
    usage: 'wiki history <path>[/<key>]',
    summary: 'Show a page’s revisions, or a table record’s versions, newest first',
    options: {
      limit: { type: 'string', description: 'maximum number of revisions or versions' },
      cursor: { type: 'string', description: 'continue a record’s versions from a previous read’s continuation token' }
    },
    examples: ['wiki history acme.about.foo', 'wiki history acme.crm.contacts/jo --json']
  },
  diff: {
    usage: 'wiki diff <path>[/<key>]',
    summary: 'Show what a revision or a record version changed, against the one before it (latest by default)',
    options: {
      commit: { type: 'string', description: 'the page’s revision at this commit id' },
      revision: { type: 'string', description: 'a revision id, as listed by history and log' },
      version: { type: 'string', description: 'a table record’s version, as listed by history' }
    },
    examples: [
      'wiki diff acme.about.foo',
      'wiki diff acme.about.foo --commit 12',
      'wiki diff acme.about.foo --revision <id> --json',
      'wiki diff acme.crm.contacts/jo --version 3'
    ]
  },
  links: {
    usage: 'wiki links <path>[/<key>]',
    summary: 'Show what links to a page or a table record: pages and records carrying a wikilink to it',
    options: {
      limit: { type: 'string', description: 'maximum number of links' }
    },
    examples: ['wiki links acme.crm.contacts/jo', 'wiki links acme.architecture --json']
  },
  log: {
    usage: 'wiki log <path>',
    summary: 'Show the wiki’s change log, newest first: commits and the pages they touched',
    options: {
      limit: { type: 'string', description: 'maximum number of commits' },
      before: { type: 'string', description: 'continue from before this commit id' }
    },
    examples: ['wiki log acme', 'wiki log acme.about --limit 10', 'wiki log acme --json']
  },
  move: {
    usage: 'wiki move <from> <to>',
    summary: 'Move or rename a node (identity and subtree preserved)',
    options: {
      'if-revision': { type: 'string', description: 'fail unless the node is still at this revision ID' },
      message: { type: 'string', description: 'commit message' }
    },
    examples: ['wiki move acme.about.foo acme.archive.foo']
  },
  rm: {
    usage: 'wiki rm <path>',
    summary: 'Delete a node (history is preserved; non-empty nodes need --recursive)',
    options: {
      recursive: { type: 'boolean', description: 'delete the whole subtree' },
      'if-revision': { type: 'string', description: 'fail unless the node is still at this revision ID' },
      'if-commit': { type: 'string', description: 'fail unless the wiki is still at this commit ID' },
      message: { type: 'string', description: 'commit message' }
    },
    examples: ['wiki rm acme.about.foo', 'wiki rm acme.about --recursive']
  },
  meta: {
    usage: 'wiki meta <path> [json]',
    summary: 'Merge fields into a page’s metadata (a null value removes its field)',
    options: {
      replace: { type: 'boolean', description: 'replace the whole metadata object instead of merging' },
      'if-revision': { type: 'string', description: 'fail unless the node is still at this revision ID' },
      message: { type: 'string', description: 'commit message' }
    },
    examples: [
      'wiki meta acme.usage \'{"retain": {"days": 90}}\'',
      'wiki meta acme.tasks \'{"key": "id", "schema": {"type": "object", "required": ["id"]}}\'',
      'wiki meta acme.tasks \'{"retain": {"versions": 50}}\'',
      'wiki meta acme.usage \'{"retain": null}\''
    ]
  },
  put: {
    usage: 'wiki put <path> [json]',
    summary: 'Write a record (a JSON object): a table (a page with a key) upserts by key, a log appends',
    options: {
      ts: { type: 'string', description: 'when it happened, on a log (ISO-8601; defaults to now)' },
      'if-version': { type: 'string', description: 'fail unless the record is still at this version (tables)' }
    },
    examples: [
      'wiki put acme.usage \'{"requests": 1042}\'',
      'wiki put acme.tasks \'{"id": "t-41", "status": "claimed"}\' --if-version 1',
      'wiki put acme.usage --ts 2026-08-01T00:00:00Z < record.json'
    ]
  },
  del: {
    usage: 'wiki del <path> <key>',
    summary: 'Delete one record by its key (tables) or its _id (logs); a table keeps the deletion in the record’s history',
    options: {},
    examples: ['wiki del acme.tasks t-41']
  },
  data: {
    usage: 'wiki data <path> [key]',
    summary: 'Read a page’s records: one by key, a range in sort order, or the records as they stood at a moment',
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
      'wiki data acme.tasks t-41 --json',
      'wiki data acme.tasks --at 2026-09-01T00:00:00Z',
      'wiki data acme.usage --since 2026-08-01T00:00:00Z --limit 100',
      'wiki data acme.usage --reverse --limit 20',
      'wiki data acme.usage --latest'
    ]
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
