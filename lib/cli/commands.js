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
    summary: 'Full-text search within a subtree; returns full paths and excerpts',
    options: {
      limit: { type: 'string', description: 'maximum number of results' }
    },
    examples: ['wiki search acme "authentication"', 'wiki search acme.architecture "tokens" --json']
  },
  history: {
    usage: 'wiki history <path>',
    summary: 'Show a node’s revision history, newest first',
    options: {
      limit: { type: 'string', description: 'maximum number of revisions' }
    },
    examples: ['wiki history acme.about.foo', 'wiki history acme.about.foo --json']
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
  push: {
    usage: 'wiki push <path> [json]',
    summary: 'Append an observation (a JSON value) to a page’s data channel',
    options: {
      ts: { type: 'string', description: 'observation timestamp (ISO-8601; defaults to now)' }
    },
    examples: [
      'wiki push acme.usage \'{"requests": 1042}\'',
      'wiki push acme.usage --ts 2026-08-01T00:00:00Z < datum.json'
    ]
  },
  data: {
    usage: 'wiki data <path>',
    summary: 'Read a page’s data channel, oldest observation first',
    options: {
      latest: { type: 'boolean', description: 'only the newest observation' },
      since: { type: 'string', description: 'observations at or after an ISO-8601 timestamp' },
      until: { type: 'string', description: 'observations at or before an ISO-8601 timestamp' },
      limit: { type: 'string', description: 'maximum number of observations' },
      summary: { type: 'boolean', description: 'which pages in the subtree carry observations (count + latest)' }
    },
    examples: [
      'wiki data acme.usage --latest --json',
      'wiki data acme.usage --since 2026-08-01T00:00:00Z --limit 100',
      'wiki data acme --summary'
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
