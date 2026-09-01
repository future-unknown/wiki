/**
 * wiki-kit — the wiki domain core.
 *
 * Owns SQL, schema, transactions, hierarchy, revisions, commits,
 * optimistic concurrency, historical reconstruction, and the FTS
 * search projection. Does not own HTTP, auth, or the database
 * connection lifecycle.
 */

import { randomUUID } from 'node:crypto'
import { migrate as applyMigrations } from './schema.js'
import {
  ValidationError,
  NotFoundError,
  AlreadyExistsError,
  RevisionConflictError,
  NonEmptyNodeError,
  InvalidMoveError,
  RecordsUnavailableError
} from './errors.js'
import {
  assertValidSlug,
  parseRelativePath,
  joinPath,
  parentPath,
  lastSlug,
  isSameOrDescendant
} from './paths.js'

export * from './errors.js'
export * from './paths.js'

function now () {
  return new Date().toISOString()
}

/** @param {any} row */
function rowToNode (row) {
  if (!row) return null
  return {
    id: row.id,
    wikiId: row.wiki_id,
    parentId: row.parent_id,
    slug: row.slug,
    path: row.path,
    title: row.title,
    content: row.content,
    metadata: JSON.parse(row.metadata),
    deleted: row.deleted === 1,
    revisionId: row.revision_id,
    commitId: row.commit_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

function rowToNote (row) {
  if (!row) return null
  return {
    id: row.id,
    nodeId: row.node_id,
    author: {
      type: row.author_type,
      id: row.author_id,
      onBehalfOf: row.author_on_behalf_of
    },
    body: row.body,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
    resolvedBy: row.resolved_at
      ? { type: row.resolved_by_type, id: row.resolved_by_id }
      : null
  }
}

function rowToCommit (row) {
  if (!row) return null
  return {
    id: row.id,
    wikiId: row.wiki_id,
    actor: {
      type: row.actor_type,
      id: row.actor_id,
      onBehalfOf: row.on_behalf_of
    },
    message: row.message,
    createdAt: row.created_at
  }
}

function assertActor (actor) {
  if (!actor || typeof actor !== 'object' ||
      typeof actor.type !== 'string' || actor.type === '' ||
      typeof actor.id !== 'string' || actor.id === '') {
    throw new ValidationError('actor with type and id is required', { actor })
  }
}

function assertContent (content) {
  if (content !== undefined && typeof content !== 'string') {
    throw new ValidationError('content must be a string', {})
  }
}

function assertTitle (title) {
  if (title !== undefined && title !== null && typeof title !== 'string') {
    throw new ValidationError('title must be a string or null', {})
  }
}

function assertMetadata (metadata) {
  if (metadata === undefined) return
  if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata)) {
    throw new ValidationError('metadata must be a plain object', {})
  }
}

/**
 * Validate an optional ISO-8601 timestamp option and normalize it, so
 * stored and compared timestamps share one canonical form.
 *
 * @param {unknown} value
 * @param {string} name
 */
function normalizeIsoOption (value, name) {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    throw new ValidationError(`${name} must be an ISO-8601 timestamp`, { [name]: value })
  }
  return new Date(value).toISOString()
}

const MAX_RECORD_LENGTH = 16384

/**
 * A record is a JSON object of caller fields. Underscore-prefixed
 * names are reserved for the stamps the store applies (`_id`, `_actor`,
 * `_ts`, `_v`, `_expires`), and `pk`/`sk` for addressing.
 *
 * @param {unknown} value
 */
function assertRecordValue (value) {
  if (value === null || value === undefined ||
      typeof value !== 'object' || Array.isArray(value)) {
    throw new ValidationError('a record must be a JSON object', {})
  }
  for (const field of Object.keys(value)) {
    if (field.startsWith('_') || field === 'pk' || field === 'sk') {
      throw new ValidationError(`record field name is reserved: ${field}`, { field })
    }
  }
  let serialized
  try {
    serialized = JSON.stringify(value)
  } catch {
    throw new ValidationError('a record must be JSON-serializable', {})
  }
  if (serialized.length > MAX_RECORD_LENGTH) {
    throw new ValidationError(`a record must serialize to ${MAX_RECORD_LENGTH} characters or fewer`, {})
  }
}

/**
 * The page's record declarations, from its raw metadata JSON:
 * `key` (field name giving records identity — a keyed page upserts,
 * an unkeyed page appends), `schema` (JSON Schema every record must
 * match), `retain.days` (unkeyed records expire after this many days).
 * Non-conforming declarations read as absent.
 *
 * @param {string} metadataJson
 */
function declarationsOf (metadataJson) {
  let meta
  try {
    meta = JSON.parse(metadataJson)
  } catch {
    meta = {}
  }
  const key = typeof meta?.key === 'string' && meta.key !== '' ? meta.key : null
  const schema = meta?.schema !== null && typeof meta?.schema === 'object' && !Array.isArray(meta?.schema)
    ? meta.schema
    : null
  const retain = meta?.retain
  const retainDays = retain !== null && typeof retain === 'object' && !Array.isArray(retain) &&
      typeof retain.days === 'number' && Number.isFinite(retain.days) && retain.days > 0
    ? retain.days
    : null
  return { key, schema, retainDays }
}

/**
 * Public record shape: the stored item minus its addressing, plus
 * `_id` — the record's address within its page (the key value on a
 * keyed page; `ts#uuid` on an unkeyed one).
 *
 * @param {object|null} item
 */
function toRecord (item) {
  if (!item) return null
  const { pk, sk, ...fields } = item
  return { ...fields, _id: sk.slice(sk.indexOf('#') + 1) }
}

function encodeCursor (next) {
  return next === undefined ? undefined : Buffer.from(JSON.stringify(next)).toString('base64url')
}

function decodeCursor (cursor) {
  if (cursor === undefined || cursor === null) return undefined
  try {
    const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
    if (decoded === null || typeof decoded !== 'object') throw new Error('shape')
    return decoded
  } catch {
    throw new ValidationError('cursor is not a valid continuation token', {})
  }
}

/**
 * Escape a user query for FTS5 MATCH: every whitespace-separated term
 * becomes a quoted string, so FTS syntax cannot be injected.
 *
 * @param {string} query
 */
function ftsQuery (query) {
  return query
    .split(/\s+/)
    .filter((term) => term !== '')
    .map((term) => `"${term.replaceAll('"', '""')}"`)
    .join(' ')
}

/**
 * @param {object} options
 * @param {import('better-sqlite3').Database} options.db
 * @param {object} [options.records] injected record store (see the
 *   api layer's openRecordStore); without it the record methods refuse
 */
export function createWikiKit ({ db, records }) {
  if (!db) throw new ValidationError('db is required', {})

  function requireRecords () {
    if (!records) throw new RecordsUnavailableError()
  }

  /* ------------------------------------------------------------------ *
   * low-level statements (prepared lazily after migrate)
   * ------------------------------------------------------------------ */

  const sql = {
    insertCommit: () => db.prepare(`
      INSERT INTO commits (wiki_id, actor_type, actor_id, on_behalf_of, message, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `),
    insertRevision: () => db.prepare(`
      INSERT INTO node_revisions
        (id, wiki_id, node_id, commit_id, parent_id, slug, title, content, metadata, deleted, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    insertNode: () => db.prepare(`
      INSERT INTO nodes
        (id, wiki_id, parent_id, slug, path, title, content, metadata, deleted,
         revision_id, commit_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)
    `)
  }

  function insertCommit ({ wikiId, actor, message, timestamp }) {
    const info = sql.insertCommit().run(
      wikiId, actor.type, actor.id, actor.onBehalfOf ?? null, message ?? null, timestamp
    )
    return Number(info.lastInsertRowid)
  }

  function insertRevision ({ wikiId, nodeId, commitId, parentId, slug, title, content, metadata, deleted, timestamp }) {
    const id = randomUUID()
    sql.insertRevision().run(
      id, wikiId, nodeId, commitId, parentId, slug, title, content, metadata, deleted ? 1 : 0, timestamp
    )
    return id
  }

  function getActiveRoot (wikiId) {
    return db.prepare(
      'SELECT * FROM nodes WHERE id = ? AND parent_id IS NULL AND deleted = 0'
    ).get(wikiId)
  }

  function getActiveNodeByPath (wikiId, path) {
    return db.prepare(
      'SELECT * FROM nodes WHERE wiki_id = ? AND path = ? AND deleted = 0'
    ).get(wikiId, path)
  }

  function getActiveChildren (wikiId, parentId) {
    return db.prepare(
      'SELECT * FROM nodes WHERE wiki_id = ? AND parent_id = ? AND deleted = 0'
    ).all(wikiId, parentId)
  }

  function getActiveSubtree (wikiId, path) {
    if (path === '') {
      return db.prepare(
        'SELECT * FROM nodes WHERE wiki_id = ? AND deleted = 0'
      ).all(wikiId)
    }
    return db.prepare(
      "SELECT * FROM nodes WHERE wiki_id = ? AND deleted = 0 AND (path = ? OR path LIKE ? || '.%')"
    ).all(wikiId, path, path)
  }

  function requireWiki (wikiId) {
    const root = getActiveRoot(wikiId)
    if (!root) throw new NotFoundError('wiki not found', { wikiId })
    return root
  }

  function requireActiveNode (wikiId, path) {
    const row = getActiveNodeByPath(wikiId, path)
    if (!row) throw new NotFoundError('node not found', { wikiId, path })
    return row
  }

  function checkExpectedRevision (row, expectedRevisionId) {
    if (expectedRevisionId === undefined || expectedRevisionId === null) return
    if (typeof expectedRevisionId !== 'string' || expectedRevisionId === '') {
      throw new ValidationError('expectedRevisionId must be a non-empty string', {})
    }
    if (row.revision_id !== expectedRevisionId) {
      throw new RevisionConflictError('node has changed since it was read', {
        path: row.path,
        expectedRevisionId,
        actualRevisionId: row.revision_id
      })
    }
  }

  /* ------------------------------------------------------------------ *
   * FTS projection
   * ------------------------------------------------------------------ */

  function ftsDelete (nodeId) {
    db.prepare(
      'DELETE FROM nodes_fts WHERE rowid = (SELECT rowid FROM nodes WHERE id = ?)'
    ).run(nodeId)
  }

  function ftsUpsert (nodeId) {
    ftsDelete(nodeId)
    db.prepare(`
      INSERT INTO nodes_fts (rowid, path, title, content)
      SELECT rowid, path, COALESCE(title, ''), content FROM nodes WHERE id = ? AND deleted = 0
    `).run(nodeId)
  }

  /* ------------------------------------------------------------------ *
   * commit resolution + historical reconstruction
   * ------------------------------------------------------------------ */

  function latestCommitId (wikiId) {
    const row = db.prepare('SELECT MAX(id) AS id FROM commits WHERE wiki_id = ?').get(wikiId)
    return row?.id ?? null
  }

  /**
   * Resolve { commitId, at } to a concrete commit ID for a wiki.
   * With neither given, resolves to the latest commit.
   */
  function resolveCommitRef (wikiId, { commitId, at } = {}) {
    if (commitId !== undefined && commitId !== null && at !== undefined && at !== null) {
      throw new ValidationError('commitId and at are mutually exclusive', {})
    }
    if (commitId !== undefined && commitId !== null) {
      if (!Number.isInteger(commitId) || commitId <= 0) {
        throw new ValidationError('commitId must be a positive integer', { commitId })
      }
      const row = db.prepare('SELECT id FROM commits WHERE wiki_id = ? AND id = ?').get(wikiId, commitId)
      if (!row) throw new NotFoundError('commit not found', { wikiId, commitId })
      return row.id
    }
    if (at !== undefined && at !== null) {
      if (typeof at !== 'string' || Number.isNaN(Date.parse(at))) {
        throw new ValidationError('at must be an ISO-8601 timestamp', { at })
      }
      const iso = new Date(at).toISOString()
      const row = db.prepare(
        'SELECT MAX(id) AS id FROM commits WHERE wiki_id = ? AND created_at <= ?'
      ).get(wikiId, iso)
      if (!row?.id) throw new NotFoundError('no commit at or before timestamp', { wikiId, at })
      return row.id
    }
    const latest = latestCommitId(wikiId)
    if (!latest) throw new NotFoundError('wiki has no commits', { wikiId })
    return latest
  }

  /**
   * Reconstruct the complete active wiki state at a commit.
   * Historical hierarchy comes from parent_id + slug; paths are derived.
   *
   * @returns {Map<string, object>} node id -> node (with derived path)
   */
  function buildSnapshotNodes (wikiId, commitId) {
    const rows = db.prepare(`
      SELECT * FROM (
        SELECT r.*, n.created_at AS node_created_at,
               ROW_NUMBER() OVER (PARTITION BY r.node_id ORDER BY r.commit_id DESC) AS rn
        FROM node_revisions r
        JOIN nodes n ON n.id = r.node_id
        WHERE r.wiki_id = ? AND r.commit_id <= ?
      ) WHERE rn = 1 AND deleted = 0
    `).all(wikiId, commitId)

    const byId = new Map()
    for (const row of rows) byId.set(row.node_id, row)

    /** @type {Map<string, object>} */
    const nodes = new Map()
    const paths = new Map()

    function derivePath (row) {
      if (paths.has(row.node_id)) return paths.get(row.node_id)
      if (row.parent_id === null) {
        paths.set(row.node_id, '')
        return ''
      }
      const parent = byId.get(row.parent_id)
      if (!parent) {
        paths.set(row.node_id, null)
        return null
      }
      const parentDerived = derivePath(parent)
      const path = parentDerived === null
        ? null
        : (parentDerived === '' ? row.slug : `${parentDerived}.${row.slug}`)
      paths.set(row.node_id, path)
      return path
    }

    for (const row of rows) {
      const path = derivePath(row)
      if (path === null) continue // orphaned by a deleted ancestor; defensive
      nodes.set(row.node_id, {
        id: row.node_id,
        wikiId: row.wiki_id,
        parentId: row.parent_id,
        slug: row.slug,
        path,
        title: row.title,
        content: row.content,
        metadata: JSON.parse(row.metadata),
        deleted: false,
        revisionId: row.id,
        commitId: row.commit_id,
        createdAt: row.node_created_at,
        updatedAt: row.created_at
      })
    }
    return nodes
  }

  /* ------------------------------------------------------------------ *
   * tree building
   * ------------------------------------------------------------------ */

  // Siblings with a numeric metadata.order come first (ascending); the
  // rest follow alphabetically by slug. Ordering is content, so it rides
  // the existing metadata field — no schema change, and history records
  // reorderings like any other revision.
  function childSortKey (node) {
    const order = node.metadata?.order
    return typeof order === 'number' && Number.isFinite(order) ? order : Infinity
  }

  function buildTree (nodes, rootPath, depth) {
    const byPath = new Map()
    for (const node of nodes) byPath.set(node.path, node)
    const root = byPath.get(rootPath)
    if (!root) throw new NotFoundError('node not found', { path: rootPath })

    const childrenByParent = new Map()
    for (const node of nodes) {
      if (node.parentId === null) continue
      if (!childrenByParent.has(node.parentId)) childrenByParent.set(node.parentId, [])
      childrenByParent.get(node.parentId).push(node)
    }
    for (const children of childrenByParent.values()) {
      children.sort((a, b) =>
        (childSortKey(a) - childSortKey(b)) ||
        (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0)
      )
    }

    function attach (node, remaining) {
      const entry = { ...node, children: [] }
      if (remaining !== 0) {
        const children = childrenByParent.get(node.id) || []
        for (const child of children) {
          entry.children.push(attach(child, remaining === undefined ? undefined : remaining - 1))
        }
      }
      return entry
    }

    return attach(root, depth)
  }

  /* ------------------------------------------------------------------ *
   * public domain API
   * ------------------------------------------------------------------ */

  /**
   * Create the node at `segments`, creating any missing intermediate
   * parents as empty nodes, all within the given commit. The wiki root
   * must already exist. Returns the created leaf row.
   */
  function createNodeWithParents ({ wikiId, segments, title, content, metadata, commitId, timestamp }) {
    let parent = getActiveRoot(wikiId)
    for (let index = 0; index < segments.length - 1; index += 1) {
      const ancestorPath = joinPath(segments.slice(0, index + 1))
      let row = getActiveNodeByPath(wikiId, ancestorPath)
      if (!row) {
        const id = randomUUID()
        const revisionId = insertRevision({
          wikiId,
          nodeId: id,
          commitId,
          parentId: parent.id,
          slug: segments[index],
          title: null,
          content: '',
          metadata: '{}',
          deleted: false,
          timestamp
        })
        sql.insertNode().run(
          id, wikiId, parent.id, segments[index], ancestorPath,
          null, '', '{}', revisionId, commitId, timestamp, timestamp
        )
        ftsUpsert(id)
        row = getActiveNodeByPath(wikiId, ancestorPath)
      }
      parent = row
    }

    const path = joinPath(segments)
    const id = randomUUID()
    const slug = segments[segments.length - 1]
    const nodeTitle = title === undefined ? null : title
    const nodeContent = content === undefined ? '' : content
    const nodeMetadata = metadata === undefined ? '{}' : JSON.stringify(metadata)
    const revisionId = insertRevision({
      wikiId,
      nodeId: id,
      commitId,
      parentId: parent.id,
      slug,
      title: nodeTitle,
      content: nodeContent,
      metadata: nodeMetadata,
      deleted: false,
      timestamp
    })
    sql.insertNode().run(
      id, wikiId, parent.id, slug, path,
      nodeTitle, nodeContent, nodeMetadata, revisionId, commitId, timestamp, timestamp
    )
    ftsUpsert(id)
    return getActiveNodeByPath(wikiId, path)
  }

  const setNodeTx = db.transaction((args) => {
    const { wikiId, path, title, content, metadata, expectedRevisionId, actor, message } = args
    const segments = parseRelativePath(path)
    requireWiki(wikiId)

    const existing = getActiveNodeByPath(wikiId, path)
    const timestamp = now()

    if (existing) {
      checkExpectedRevision(existing, expectedRevisionId)
      const nextTitle = title === undefined ? existing.title : title
      const nextContent = content === undefined ? existing.content : content
      const nextMetadata = metadata === undefined ? existing.metadata : JSON.stringify(metadata)

      if (nextTitle === existing.title &&
          nextContent === existing.content &&
          nextMetadata === existing.metadata) {
        return { node: rowToNode(existing), changed: false, created: false }
      }

      const commitId = insertCommit({ wikiId, actor, message, timestamp })
      const revisionId = insertRevision({
        wikiId,
        nodeId: existing.id,
        commitId,
        parentId: existing.parent_id,
        slug: existing.slug,
        title: nextTitle,
        content: nextContent,
        metadata: nextMetadata,
        deleted: false,
        timestamp
      })
      db.prepare(`
        UPDATE nodes SET title = ?, content = ?, metadata = ?, revision_id = ?, commit_id = ?, updated_at = ?
        WHERE id = ?
      `).run(nextTitle, nextContent, nextMetadata, revisionId, commitId, timestamp, existing.id)
      ftsUpsert(existing.id)
      return { node: rowToNode(getActiveNodeByPath(wikiId, path)), changed: true, created: false }
    }

    // New node. The wiki root itself always exists here (requireWiki),
    // so path is non-empty.
    if (expectedRevisionId !== undefined && expectedRevisionId !== null) {
      throw new RevisionConflictError('node does not exist', { wikiId, path, expectedRevisionId })
    }

    const commitId = insertCommit({ wikiId, actor, message, timestamp })
    const row = createNodeWithParents({
      wikiId, segments, title, content, metadata, commitId, timestamp
    })
    return { node: rowToNode(row), changed: true, created: true }
  })

  const createWikiTx = db.transaction((args) => {
    const { slug, path, title, content, metadata, actor, message } = args
    const existing = db.prepare(
      'SELECT id FROM nodes WHERE slug = ? AND parent_id IS NULL AND deleted = 0'
    ).get(slug)
    if (existing) throw new AlreadyExistsError('wiki already exists', { slug })

    const segments = parseRelativePath(path ?? '')
    const nested = segments.length > 0

    const timestamp = now()
    const id = randomUUID()
    const commitId = insertCommit({ wikiId: id, actor, message, timestamp })
    // With a nested target the supplied fields belong to that node and
    // the root is created empty, exactly like an implicit intermediate.
    const rootTitle = nested || title === undefined ? null : title
    const rootContent = nested || content === undefined ? '' : content
    const rootMetadata = nested || metadata === undefined ? '{}' : JSON.stringify(metadata)
    const revisionId = insertRevision({
      wikiId: id,
      nodeId: id,
      commitId,
      parentId: null,
      slug,
      title: rootTitle,
      content: rootContent,
      metadata: rootMetadata,
      deleted: false,
      timestamp
    })
    sql.insertNode().run(
      id, id, null, slug, '',
      rootTitle, rootContent, rootMetadata, revisionId, commitId, timestamp, timestamp
    )
    ftsUpsert(id)
    if (!nested) return rowToNode(getActiveRoot(id))
    const row = createNodeWithParents({
      wikiId: id, segments, title, content, metadata, commitId, timestamp
    })
    return rowToNode(row)
  })

  const moveNodeTx = db.transaction((args) => {
    const { wikiId, fromPath, toPath, expectedRevisionId, actor, message } = args
    requireWiki(wikiId)

    const node = requireActiveNode(wikiId, fromPath)
    checkExpectedRevision(node, expectedRevisionId)

    if (getActiveNodeByPath(wikiId, toPath)) {
      throw new AlreadyExistsError('destination already exists', { wikiId, path: toPath })
    }
    const destParentPath = parentPath(toPath)
    const destParent = getActiveNodeByPath(wikiId, destParentPath)
    if (!destParent) {
      throw new NotFoundError('destination parent not found', { wikiId, path: destParentPath })
    }

    const timestamp = now()
    const newSlug = lastSlug(toPath)
    const commitId = insertCommit({ wikiId, actor, message, timestamp })
    const revisionId = insertRevision({
      wikiId,
      nodeId: node.id,
      commitId,
      parentId: destParent.id,
      slug: newSlug,
      title: node.title,
      content: node.content,
      metadata: node.metadata,
      deleted: false,
      timestamp
    })
    db.prepare(`
      UPDATE nodes SET parent_id = ?, slug = ?, path = ?, revision_id = ?, commit_id = ?, updated_at = ?
      WHERE id = ?
    `).run(destParent.id, newSlug, toPath, revisionId, commitId, timestamp, node.id)
    ftsUpsert(node.id)

    // Descendants keep their identity and revisions; only their derived
    // materialized paths change.
    const descendants = db.prepare(
      "SELECT id, path FROM nodes WHERE wiki_id = ? AND deleted = 0 AND path LIKE ? || '.%'"
    ).all(wikiId, fromPath)
    const updatePath = db.prepare('UPDATE nodes SET path = ? WHERE id = ?')
    for (const descendant of descendants) {
      const newPath = toPath + descendant.path.slice(fromPath.length)
      updatePath.run(newPath, descendant.id)
      ftsUpsert(descendant.id)
    }

    return rowToNode(getActiveNodeByPath(wikiId, toPath))
  })

  const deleteNodeTx = db.transaction((args) => {
    const { wikiId, path, recursive, expectedRevisionId, expectedCommitId, actor, message } = args
    requireWiki(wikiId)
    const node = requireActiveNode(wikiId, path)
    checkExpectedRevision(node, expectedRevisionId)

    if (expectedCommitId !== undefined && expectedCommitId !== null) {
      const latest = latestCommitId(wikiId)
      if (latest !== expectedCommitId) {
        throw new RevisionConflictError('wiki has changed since it was read', {
          expectedCommitId,
          actualCommitId: latest
        })
      }
    }

    const children = getActiveChildren(wikiId, node.id)
    if (children.length > 0 && !recursive) {
      throw new NonEmptyNodeError('node has children; pass recursive to delete the subtree', {
        wikiId,
        path,
        childCount: children.length
      })
    }

    const rows = recursive ? getActiveSubtree(wikiId, path) : [node]
    const timestamp = now()
    const commitId = insertCommit({ wikiId, actor, message, timestamp })
    const tombstone = db.prepare(
      'UPDATE nodes SET deleted = 1, revision_id = ?, commit_id = ?, updated_at = ? WHERE id = ?'
    )
    const deletedPaths = []
    for (const row of rows) {
      const revisionId = insertRevision({
        wikiId,
        nodeId: row.id,
        commitId,
        parentId: row.parent_id,
        slug: row.slug,
        title: row.title,
        content: row.content,
        metadata: row.metadata,
        deleted: true,
        timestamp
      })
      tombstone.run(revisionId, commitId, timestamp, row.id)
      ftsDelete(row.id)
      deletedPaths.push(row.path)
    }
    deletedPaths.sort()
    return { commitId, deletedPaths }
  })

  // Metadata merge is an authored change like any other: it reads the
  // current metadata and writes the merged result through the normal
  // set path (commit + revision), all inside one transaction so a
  // concurrent metadata change cannot be clobbered.
  const mergeMetadataTx = db.transaction((args) => {
    const { wikiId, path, patch, replace, expectedRevisionId, actor, message } = args
    requireWiki(wikiId)
    const existing = requireActiveNode(wikiId, path)
    checkExpectedRevision(existing, expectedRevisionId)
    let next
    if (replace) {
      next = patch
    } else {
      next = { ...JSON.parse(existing.metadata) }
      for (const [field, value] of Object.entries(patch)) {
        if (value === null) delete next[field]
        else next[field] = value
      }
    }
    return setNodeTx({ wikiId, path, metadata: next, actor, message })
  })

  /**
   * One-time drain of the pre-record data channel into the record
   * store: each observation becomes an unkeyed record on its page
   * (non-object payloads wrap as `{ value }`). Idempotent — the sort
   * key reuses the observation id, and drained rows are removed.
   */
  async function drainLegacyObservations () {
    const table = db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'node_data'"
    ).get()
    if (!table) return
    const rows = db.prepare('SELECT * FROM node_data ORDER BY rowid').all()
    const remove = db.prepare('DELETE FROM node_data WHERE id = ?')
    for (const row of rows) {
      let payload
      try {
        payload = JSON.parse(row.payload)
      } catch {
        payload = row.payload
      }
      const value = payload !== null && typeof payload === 'object' && !Array.isArray(payload)
        ? payload
        : { value: payload }
      const item = {
        pk: row.wiki_id,
        sk: `${row.node_id}#${row.ts}#${row.id}`,
        ...value,
        _actor: { type: row.actor_type, id: row.actor_id, onBehalfOf: row.actor_on_behalf_of },
        _ts: row.ts,
        _v: 1
      }
      try {
        await records.put({ item, condition: 'attribute_not_exists(pk)' })
      } catch (error) {
        if (!error.conditionFailed) throw error
      }
      remove.run(row.id)
    }
  }

  return {
    async migrate () {
      applyMigrations(db)
      if (records) {
        await records.migrate()
        await drainLegacyObservations()
      }
    },

    /**
     * All active wikis (their root nodes), ordered by slug.
     */
    async listWikis () {
      const rows = db.prepare(
        'SELECT * FROM nodes WHERE parent_id IS NULL AND deleted = 0 ORDER BY slug'
      ).all()
      return rows.map(rowToNode)
    },

    /**
     * Look up a wiki by its public root slug. Returns the root node
     * or null when no active wiki has that slug.
     */
    async resolveWikiBySlug ({ slug }) {
      assertValidSlug(slug)
      const row = db.prepare(
        'SELECT * FROM nodes WHERE slug = ? AND parent_id IS NULL AND deleted = 0'
      ).get(slug)
      return rowToNode(row)
    },

    /**
     * Create a wiki. With a non-empty relative `path` the supplied
     * title/content/metadata land on that node (root and intermediates
     * are created empty), all in one commit; the written node is
     * returned. With no path the root itself is the target.
     */
    async createWiki ({ slug, path, title, content, metadata, actor, message }) {
      assertValidSlug(slug)
      parseRelativePath(path ?? '')
      assertTitle(title)
      assertContent(content)
      assertMetadata(metadata)
      assertActor(actor)
      return createWikiTx.immediate({ slug, path, title, content, metadata, actor, message })
    },

    async getNode ({ wikiId, path, commitId, at }) {
      const relPath = path ?? ''
      parseRelativePath(relPath)
      requireWiki(wikiId)
      // A read carries its provenance: the commit that produced this
      // revision, actor included. updatedAt already comes from that
      // commit; the actor is the other half of "updated when, by whom".
      const withCommit = (node) => ({
        ...node,
        commit: rowToCommit(db.prepare('SELECT * FROM commits WHERE id = ?').get(node.commitId))
      })
      if (commitId !== undefined || at !== undefined) {
        const resolved = resolveCommitRef(wikiId, { commitId, at })
        const nodes = buildSnapshotNodes(wikiId, resolved)
        for (const node of nodes.values()) {
          if (node.path === relPath) return withCommit(node)
        }
        throw new NotFoundError('node not found at commit', { wikiId, path: relPath, commitId: resolved })
      }
      return withCommit(rowToNode(requireActiveNode(wikiId, relPath)))
    },

    async setNode ({ wikiId, path, title, content, metadata, expectedRevisionId, actor, message }) {
      const relPath = path ?? ''
      parseRelativePath(relPath)
      assertTitle(title)
      assertContent(content)
      assertMetadata(metadata)
      assertActor(actor)
      return setNodeTx.immediate({
        wikiId, path: relPath, title, content, metadata, expectedRevisionId, actor, message
      })
    },

    async getTree ({ wikiId, path, depth, commitId, at }) {
      const relPath = path ?? ''
      parseRelativePath(relPath)
      if (depth !== undefined && (!Number.isInteger(depth) || depth < 0)) {
        throw new ValidationError('depth must be a non-negative integer', { depth })
      }
      requireWiki(wikiId)
      if (commitId !== undefined || at !== undefined) {
        const resolved = resolveCommitRef(wikiId, { commitId, at })
        const nodes = [...buildSnapshotNodes(wikiId, resolved).values()]
        return buildTree(nodes, relPath, depth)
      }
      const nodes = getActiveSubtree(wikiId, relPath).map(rowToNode)
      // buildTree needs ancestors' ids only for parent lookup of the
      // subtree root's children, which are all included. The subtree
      // root itself is present; that is enough.
      return buildTree(nodes, relPath, depth)
    },

    async search ({ wikiId, path, query, limit }) {
      const relPath = path ?? ''
      parseRelativePath(relPath)
      if (typeof query !== 'string' || query.trim() === '') {
        throw new ValidationError('query must be a non-empty string', {})
      }
      const max = limit === undefined ? 20 : limit
      if (!Number.isInteger(max) || max <= 0 || max > 200) {
        throw new ValidationError('limit must be an integer between 1 and 200', { limit })
      }
      requireWiki(wikiId)
      const match = ftsQuery(query)
      if (match === '') return []
      const rows = db.prepare(`
        SELECT n.id, n.path, n.slug, n.title, n.revision_id, n.commit_id, n.updated_at,
               snippet(nodes_fts, 2, '[', ']', '…', 16) AS excerpt,
               bm25(nodes_fts) AS rank
        FROM nodes_fts
        JOIN nodes n ON n.rowid = nodes_fts.rowid
        WHERE nodes_fts MATCH ?
          AND n.wiki_id = ? AND n.deleted = 0
          AND (? = '' OR n.path = ? OR n.path LIKE ? || '.%')
        ORDER BY rank
        LIMIT ?
      `).all(match, wikiId, relPath, relPath, relPath, max)
      return rows.map((row) => ({
        id: row.id,
        path: row.path,
        slug: row.slug,
        title: row.title,
        excerpt: row.excerpt,
        revisionId: row.revision_id,
        commitId: row.commit_id,
        updatedAt: row.updated_at
      }))
    },

    async getNodeHistory ({ wikiId, path, limit }) {
      const relPath = path ?? ''
      parseRelativePath(relPath)
      const max = limit === undefined ? 50 : limit
      if (!Number.isInteger(max) || max <= 0 || max > 500) {
        throw new ValidationError('limit must be an integer between 1 and 500', { limit })
      }
      requireWiki(wikiId)
      // Prefer the active node at this path; fall back to the most
      // recently deleted identity so tombstoned history stays reachable.
      let node = getActiveNodeByPath(wikiId, relPath)
      if (!node) {
        node = db.prepare(
          'SELECT * FROM nodes WHERE wiki_id = ? AND path = ? AND deleted = 1 ORDER BY commit_id DESC LIMIT 1'
        ).get(wikiId, relPath)
      }
      if (!node) throw new NotFoundError('node not found', { wikiId, path: relPath })
      const rows = db.prepare(`
        SELECT r.id AS revision_id, r.commit_id, r.parent_id, r.slug, r.title, r.content,
               r.metadata, r.deleted, r.created_at,
               c.actor_type, c.actor_id, c.on_behalf_of, c.message
        FROM node_revisions r
        JOIN commits c ON c.id = r.commit_id
        WHERE r.node_id = ?
        ORDER BY r.commit_id DESC
        LIMIT ?
      `).all(node.id, max)
      return rows.map((row) => ({
        nodeId: node.id,
        revisionId: row.revision_id,
        commitId: row.commit_id,
        parentId: row.parent_id,
        slug: row.slug,
        title: row.title,
        content: row.content,
        metadata: JSON.parse(row.metadata),
        deleted: row.deleted === 1,
        createdAt: row.created_at,
        commit: {
          id: row.commit_id,
          message: row.message,
          actor: {
            type: row.actor_type,
            id: row.actor_id,
            onBehalfOf: row.on_behalf_of
          }
        }
      }))
    },

    async moveNode ({ wikiId, fromPath, toPath, expectedRevisionId, actor, message }) {
      const from = fromPath ?? ''
      const to = toPath ?? ''
      parseRelativePath(from)
      parseRelativePath(to)
      assertActor(actor)
      if (from === '') throw new InvalidMoveError('cannot move the wiki root', {})
      if (to === '') throw new InvalidMoveError('cannot move onto the wiki root', {})
      if (isSameOrDescendant(to, from)) {
        throw new InvalidMoveError('cannot move a node beneath itself', { fromPath: from, toPath: to })
      }
      return moveNodeTx.immediate({ wikiId, fromPath: from, toPath: to, expectedRevisionId, actor, message })
    },

    async deleteNode ({ wikiId, path, recursive, expectedRevisionId, expectedCommitId, actor, message }) {
      const relPath = path ?? ''
      parseRelativePath(relPath)
      assertActor(actor)
      if (relPath === '') {
        throw new ValidationError('deleting a wiki root is not supported', {})
      }
      if (expectedCommitId !== undefined && expectedCommitId !== null &&
          (!Number.isInteger(expectedCommitId) || expectedCommitId <= 0)) {
        throw new ValidationError('expectedCommitId must be a positive integer', { expectedCommitId })
      }
      return deleteNodeTx.immediate({
        wikiId, path: relPath, recursive: !!recursive, expectedRevisionId, expectedCommitId, actor, message
      })
    },

    /**
     * Attach a note to the page at `path`. Notes are append-only
     * annotations outside the commit model: they create no revision and
     * never conflict with content edits.
     */
    async addNote ({ wikiId, path, body, actor }) {
      const relPath = path ?? ''
      parseRelativePath(relPath)
      assertActor(actor)
      if (typeof body !== 'string' || body.trim() === '') {
        throw new ValidationError('note body must be a non-empty string', {})
      }
      if (body.length > 10000) {
        throw new ValidationError('note body must be 10000 characters or fewer', {})
      }
      requireWiki(wikiId)
      const node = requireActiveNode(wikiId, relPath)
      const id = randomUUID()
      const timestamp = now()
      db.prepare(`
        INSERT INTO node_notes
          (id, wiki_id, node_id, author_type, author_id, author_on_behalf_of, body, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, wikiId, node.id, actor.type, actor.id, actor.onBehalfOf ?? null, body, timestamp)
      return rowToNote(db.prepare('SELECT * FROM node_notes WHERE id = ?').get(id))
    },

    /**
     * Notes for the page at `path`, oldest first (they read as a thread).
     * Resolved notes are excluded unless asked for. With `subtree`, notes
     * for the page and every active descendant — the triage queue —
     * ordered by page path then age. Notes resolve their page's *current*
     * path at read time, so the queue stays true across moves; notes on
     * tombstoned pages drop out with their pages.
     */
    async listNotes ({ wikiId, path, includeResolved, subtree }) {
      const relPath = path ?? ''
      parseRelativePath(relPath)
      requireWiki(wikiId)
      const node = requireActiveNode(wikiId, relPath)

      if (!subtree) {
        const rows = includeResolved
          ? db.prepare('SELECT * FROM node_notes WHERE node_id = ? ORDER BY created_at, rowid').all(node.id)
          : db.prepare(
            'SELECT * FROM node_notes WHERE node_id = ? AND resolved_at IS NULL ORDER BY created_at, rowid'
          ).all(node.id)
        return rows.map((row) => ({ ...rowToNote(row), path: node.path }))
      }

      const rows = db.prepare(`
        SELECT nn.*, n.path AS node_path
        FROM node_notes nn
        JOIN nodes n ON n.id = nn.node_id
        WHERE nn.wiki_id = ? AND n.deleted = 0
          AND (? = '' OR n.path = ? OR n.path LIKE ? || '.%')
          ${includeResolved ? '' : 'AND nn.resolved_at IS NULL'}
        ORDER BY n.path, nn.created_at, nn.rowid
      `).all(wikiId, relPath, relPath, relPath)
      return rows.map((row) => ({ ...rowToNote(row), path: row.node_path }))
    },

    /**
     * Mark a note resolved. Idempotent: resolving a resolved note returns
     * it unchanged, so retries are safe.
     */
    async resolveNote ({ wikiId, path, noteId, actor }) {
      const relPath = path ?? ''
      parseRelativePath(relPath)
      assertActor(actor)
      if (typeof noteId !== 'string' || noteId === '') {
        throw new ValidationError('noteId must be a non-empty string', {})
      }
      requireWiki(wikiId)
      const node = requireActiveNode(wikiId, relPath)
      const note = db.prepare('SELECT * FROM node_notes WHERE id = ? AND node_id = ?').get(noteId, node.id)
      if (!note) throw new NotFoundError('note not found', { wikiId, path: relPath, noteId })
      if (note.resolved_at) return rowToNote(note)
      db.prepare(
        'UPDATE node_notes SET resolved_at = ?, resolved_by_type = ?, resolved_by_id = ? WHERE id = ?'
      ).run(now(), actor.type, actor.id, noteId)
      return rowToNote(db.prepare('SELECT * FROM node_notes WHERE id = ?').get(noteId))
    },

    /**
     * Write one record to the page at `path`. On a keyed page
     * (`metadata.key` names a field) the record upserts by its key
     * value; `ifVersion` makes the write conditional on the record's
     * current `_v` — the compare-and-swap primitive. On an unkeyed page
     * the record appends; `ts` (ISO-8601) backfills its time, and the
     * page's `metadata.retain` (`{ days }`) sets its expiry. A declared
     * `metadata.schema` (JSON Schema) is enforced before the write.
     * Records are stamped, not versioned: no commit, no revision.
     */
    async putRecord ({ wikiId, path, value, ts, ifVersion, actor }) {
      requireRecords()
      const relPath = path ?? ''
      parseRelativePath(relPath)
      assertActor(actor)
      assertRecordValue(value)
      requireWiki(wikiId)
      const node = requireActiveNode(wikiId, relPath)
      const { key, schema, retainDays } = declarationsOf(node.metadata)

      if (schema) {
        let validate
        try {
          validate = records.compileSchema(schema)
        } catch (error) {
          if (!error.invalidSchema) throw error
          throw new ValidationError(`the page's schema does not compile: ${error.message}`, { path: relPath })
        }
        const problem = validate(value)
        if (problem !== null) {
          throw new ValidationError(`record does not match the page's schema: ${problem}`, { path: relPath })
        }
      }

      const timestamp = now()
      const stamp = { type: actor.type, id: actor.id, onBehalfOf: actor.onBehalfOf ?? null }

      if (key) {
        if (ts !== undefined) {
          throw new ValidationError('ts applies only to unkeyed pages', { path: relPath })
        }
        const raw = value[key]
        const usable = (typeof raw === 'string' && raw !== '') ||
          (typeof raw === 'number' && Number.isFinite(raw))
        if (!usable) {
          throw new ValidationError(`record is missing its key field: ${key}`, { path: relPath, key })
        }
        const id = String(raw)
        const sk = `${node.id}#${id}`

        if (ifVersion !== undefined) {
          if (!Number.isInteger(ifVersion) || ifVersion <= 0) {
            throw new ValidationError('ifVersion must be a positive integer', { ifVersion })
          }
          const item = { pk: wikiId, sk, ...value, _actor: stamp, _ts: timestamp, _v: ifVersion + 1 }
          try {
            await records.put({
              item,
              condition: '#v = :v',
              names: { '#v': '_v' },
              values: { ':v': ifVersion }
            })
          } catch (error) {
            if (!error.conditionFailed) throw error
            throw new RevisionConflictError('record has changed since it was read', {
              path: relPath, key: id, ifVersion
            })
          }
          return toRecord(item)
        }

        // Unconditional upsert still moves _v atomically: read the
        // current version, write version+1 guarded on what was read,
        // and retry the rare race.
        for (let attempt = 0; attempt < 3; attempt += 1) {
          const current = await records.get(wikiId, sk)
          const version = Number.isInteger(current?._v) ? current._v : 0
          const item = { pk: wikiId, sk, ...value, _actor: stamp, _ts: timestamp, _v: version + 1 }
          const guard = !current
            ? { condition: 'attribute_not_exists(pk)' }
            : Number.isInteger(current._v)
              ? { condition: '#v = :v', names: { '#v': '_v' }, values: { ':v': current._v } }
              : { condition: 'attribute_exists(pk) AND attribute_not_exists(#v)', names: { '#v': '_v' } }
          try {
            await records.put({ item, ...guard })
            return toRecord(item)
          } catch (error) {
            if (!error.conditionFailed) throw error
          }
        }
        throw new RevisionConflictError('record is under write contention; retry', { path: relPath, key: id })
      }

      // Unkeyed page: pure append.
      if (ifVersion !== undefined) {
        throw new ValidationError('ifVersion applies only to keyed pages', { path: relPath })
      }
      const tsIso = normalizeIsoOption(ts, 'ts') ?? timestamp
      const sk = `${node.id}#${tsIso}#${randomUUID()}`
      const item = {
        pk: wikiId,
        sk,
        ...value,
        _actor: stamp,
        _ts: tsIso,
        _v: 1,
        ...(retainDays !== null
          ? { _expires: Math.floor(Date.parse(tsIso) / 1000) + Math.round(retainDays * 86400) }
          : {})
      }
      await records.put({ item, condition: 'attribute_not_exists(pk)' })
      return toRecord(item)
    },

    /**
     * Records of the page at `path`. With `key`, exactly that record
     * (combines with nothing else). Otherwise a page of records
     * ascending by sort order — time on unkeyed pages, key on keyed
     * ones — bounded by `since`/`until` (ISO-8601), capped by `limit`,
     * and continued with `cursor` when a previous page reported one.
     * `latest` returns only the newest record. Returns
     * `{ record }` for a key read, `{ records, cursor? }` otherwise.
     */
    async getRecords ({ wikiId, path, key, latest, since, until, limit, cursor }) {
      requireRecords()
      const relPath = path ?? ''
      parseRelativePath(relPath)
      requireWiki(wikiId)
      const node = requireActiveNode(wikiId, relPath)

      if (key !== undefined && key !== null) {
        if (typeof key !== 'string' || key === '') {
          throw new ValidationError('key must be a non-empty string', {})
        }
        if (latest || since !== undefined || until !== undefined ||
            limit !== undefined || cursor !== undefined) {
          throw new ValidationError('key combines with no other read option', {})
        }
        const item = await records.get(wikiId, `${node.id}#${key}`)
        if (!item) throw new NotFoundError('record not found', { path: relPath, key })
        return { record: toRecord(item) }
      }

      if (latest) {
        if (since !== undefined || until !== undefined || limit !== undefined || cursor !== undefined) {
          throw new ValidationError('latest cannot be combined with since, until, limit, or cursor', {})
        }
        const { items } = await records.query({
          pk: wikiId,
          from: `${node.id}#`,
          to: `${node.id}#\uffff`,
          limit: 1,
          descending: true
        })
        return { records: items.map(toRecord) }
      }

      const sinceIso = normalizeIsoOption(since, 'since')
      const untilIso = normalizeIsoOption(until, 'until')
      const max = limit === undefined ? 1000 : limit
      if (!Number.isInteger(max) || max <= 0 || max > 10000) {
        throw new ValidationError('limit must be an integer between 1 and 10000', { limit })
      }
      const { items, next } = await records.query({
        pk: wikiId,
        from: `${node.id}#${sinceIso ?? ''}`,
        to: untilIso === undefined ? `${node.id}#\uffff` : `${node.id}#${untilIso}#\uffff`,
        limit: max,
        cursor: decodeCursor(cursor)
      })
      return { records: items.map(toRecord), cursor: encodeCursor(next) }
    },

    /**
     * Delete one record by its address within the page: the key value
     * on a keyed page, the `_id` stamp on an unkeyed one. Returns the
     * deleted record.
     */
    async deleteRecord ({ wikiId, path, key, actor }) {
      requireRecords()
      const relPath = path ?? ''
      parseRelativePath(relPath)
      assertActor(actor)
      if (typeof key !== 'string' || key === '') {
        throw new ValidationError('key must be a non-empty string', {})
      }
      requireWiki(wikiId)
      const node = requireActiveNode(wikiId, relPath)
      const old = await records.delete(wikiId, `${node.id}#${key}`)
      if (!old) throw new NotFoundError('record not found', { path: relPath, key })
      return { record: toRecord(old) }
    },

    /**
     * Merge fields into the metadata of the page at `path` — an
     * authored change (commit + revision) that touches only the named
     * fields. A `null` value removes its field; `replace` swaps the
     * whole object instead of merging.
     */
    async mergeMetadata ({ wikiId, path, metadata, replace, expectedRevisionId, actor, message }) {
      const relPath = path ?? ''
      parseRelativePath(relPath)
      assertActor(actor)
      if (metadata === undefined) {
        throw new ValidationError('metadata is required', {})
      }
      assertMetadata(metadata)
      return mergeMetadataTx.immediate({
        wikiId, path: relPath, patch: metadata, replace: !!replace, expectedRevisionId, actor, message
      })
    },

    async getCommit ({ wikiId, commitId }) {
      if (!Number.isInteger(commitId) || commitId <= 0) {
        throw new ValidationError('commitId must be a positive integer', { commitId })
      }
      const row = db.prepare('SELECT * FROM commits WHERE wiki_id = ? AND id = ?').get(wikiId, commitId)
      if (!row) throw new NotFoundError('commit not found', { wikiId, commitId })
      const commit = rowToCommit(row)
      commit.revisions = db.prepare(`
        SELECT id AS revision_id, node_id, slug, deleted FROM node_revisions
        WHERE commit_id = ? ORDER BY rowid
      `).all(commitId).map((revision) => ({
        revisionId: revision.revision_id,
        nodeId: revision.node_id,
        slug: revision.slug,
        deleted: revision.deleted === 1
      }))
      return commit
    },

    async getSnapshot ({ wikiId, commitId, at }) {
      requireWikiEverExisted(wikiId)
      const resolved = resolveCommitRef(wikiId, { commitId, at })
      const nodes = [...buildSnapshotNodes(wikiId, resolved).values()]
      nodes.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
      return { commitId: resolved, nodes }
    }
  }

  function requireWikiEverExisted (wikiId) {
    const row = db.prepare('SELECT id FROM nodes WHERE id = ? AND parent_id IS NULL').get(wikiId)
    if (!row) throw new NotFoundError('wiki not found', { wikiId })
  }
}
