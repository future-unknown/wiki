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
  InvalidMoveError
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

function rowToDatum (row) {
  if (!row) return null
  return {
    id: row.id,
    nodeId: row.node_id,
    ts: row.ts,
    actor: {
      type: row.actor_type,
      id: row.actor_id,
      onBehalfOf: row.actor_on_behalf_of
    },
    payload: JSON.parse(row.payload),
    createdAt: row.created_at
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

const MAX_PAYLOAD_LENGTH = 16384

/** @param {unknown} payload */
function serializePayload (payload) {
  if (payload === undefined) {
    throw new ValidationError('payload is required', {})
  }
  let serialized
  try {
    serialized = JSON.stringify(payload)
  } catch {
    throw new ValidationError('payload must be JSON-serializable', {})
  }
  if (serialized === undefined) {
    throw new ValidationError('payload must be JSON-serializable', {})
  }
  if (serialized.length > MAX_PAYLOAD_LENGTH) {
    throw new ValidationError(`payload must serialize to ${MAX_PAYLOAD_LENGTH} characters or fewer`, {})
  }
  return serialized
}

/**
 * Retention policy from a node's raw metadata JSON. Policies are
 * free-form metadata, so anything non-conforming reads as "keep
 * everything" — a bad policy must never fail a push.
 *
 * @param {string} metadataJson
 * @returns {{ rows?: number, days?: number }}
 */
function retentionOf (metadataJson) {
  let retain
  try {
    retain = JSON.parse(metadataJson)?.data?.retain
  } catch {
    return {}
  }
  if (retain === null || typeof retain !== 'object' || Array.isArray(retain)) return {}
  return {
    rows: Number.isInteger(retain.rows) && retain.rows > 0 ? retain.rows : undefined,
    days: typeof retain.days === 'number' && Number.isFinite(retain.days) && retain.days > 0
      ? retain.days
      : undefined
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
 * @param {{ db: import('better-sqlite3').Database }} options
 */
export function createWikiKit ({ db }) {
  if (!db) throw new ValidationError('db is required', {})

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

  const pushDataTx = db.transaction((args) => {
    const { wikiId, path, serialized, ts, actor } = args
    requireWiki(wikiId)
    const node = requireActiveNode(wikiId, path)

    const id = randomUUID()
    const timestamp = now()
    db.prepare(`
      INSERT INTO node_data
        (id, wiki_id, node_id, ts, actor_type, actor_id, actor_on_behalf_of, payload, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, wikiId, node.id, ts ?? timestamp,
      actor.type, actor.id, actor.onBehalfOf ?? null, serialized, timestamp
    )
    // Read back before trimming: a backfilled observation older than the
    // retention window is accepted and immediately trimmed, but the push
    // still reports what was stored.
    const datum = rowToDatum(db.prepare('SELECT * FROM node_data WHERE id = ?').get(id))

    const retention = retentionOf(node.metadata)
    if (retention.rows !== undefined) {
      db.prepare(`
        DELETE FROM node_data WHERE node_id = ? AND id NOT IN (
          SELECT id FROM node_data WHERE node_id = ? ORDER BY ts DESC, rowid DESC LIMIT ?
        )
      `).run(node.id, node.id, retention.rows)
    }
    if (retention.days !== undefined) {
      const cutoff = new Date(Date.now() - retention.days * 86400000).toISOString()
      db.prepare('DELETE FROM node_data WHERE node_id = ? AND ts < ?').run(node.id, cutoff)
    }
    return datum
  })

  return {
    async migrate () {
      applyMigrations(db)
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
     * Append an observation to the data channel of the page at `path`.
     * Data is observed, not authored: no commit, no revision, and no
     * conflict — appends always succeed against the current page. The
     * page's `metadata.data.retain` policy (`{ rows }` and/or `{ days }`)
     * is applied in the same transaction; non-conforming policies are
     * ignored rather than failing the push. `ts` (ISO-8601) backfills
     * an observation time; it defaults to now.
     */
    async pushData ({ wikiId, path, payload, ts, actor }) {
      const relPath = path ?? ''
      parseRelativePath(relPath)
      assertActor(actor)
      const serialized = serializePayload(payload)
      const tsIso = normalizeIsoOption(ts, 'ts')
      return pushDataTx.immediate({ wikiId, path: relPath, serialized, ts: tsIso, actor })
    },

    /**
     * Observations for the page at `path`, ascending by observation
     * time (chart-ready). Always returns an array. `latest` returns
     * just the newest observation and cannot combine with the range
     * options.
     */
    async getData ({ wikiId, path, latest, since, until, limit }) {
      const relPath = path ?? ''
      parseRelativePath(relPath)
      if (latest && (since !== undefined || until !== undefined || limit !== undefined)) {
        throw new ValidationError('latest cannot be combined with since, until, or limit', {})
      }
      const sinceIso = normalizeIsoOption(since, 'since')
      const untilIso = normalizeIsoOption(until, 'until')
      const max = limit === undefined ? 1000 : limit
      if (!Number.isInteger(max) || max <= 0 || max > 10000) {
        throw new ValidationError('limit must be an integer between 1 and 10000', { limit })
      }
      requireWiki(wikiId)
      const node = requireActiveNode(wikiId, relPath)

      if (latest) {
        const row = db.prepare(
          'SELECT * FROM node_data WHERE node_id = ? ORDER BY ts DESC, rowid DESC LIMIT 1'
        ).get(node.id)
        return row ? [rowToDatum(row)] : []
      }

      const conditions = ['node_id = ?']
      const params = [node.id]
      if (sinceIso !== undefined) {
        conditions.push('ts >= ?')
        params.push(sinceIso)
      }
      if (untilIso !== undefined) {
        conditions.push('ts <= ?')
        params.push(untilIso)
      }
      const rows = db.prepare(
        `SELECT * FROM node_data WHERE ${conditions.join(' AND ')} ORDER BY ts, rowid LIMIT ?`
      ).all(...params, max)
      return rows.map(rowToDatum)
    },

    /**
     * Which pages carry observations: one row per active page in the
     * subtree at `path` whose data channel is non-empty — count and
     * latest observation time, ordered by page path. The cheap answer
     * for navigation surfaces; never the observations themselves.
     * Pages resolve their current path at read time, so summaries stay
     * true across moves and tombstoned pages drop out.
     */
    async getDataSummary ({ wikiId, path }) {
      const relPath = path ?? ''
      parseRelativePath(relPath)
      requireWiki(wikiId)
      requireActiveNode(wikiId, relPath)
      const rows = db.prepare(`
        SELECT n.path AS node_path, COUNT(*) AS observation_count, MAX(nd.ts) AS latest_ts
        FROM node_data nd
        JOIN nodes n ON n.id = nd.node_id
        WHERE nd.wiki_id = ? AND n.deleted = 0
          AND (? = '' OR n.path = ? OR n.path LIKE ? || '.%')
        GROUP BY nd.node_id
        ORDER BY n.path
      `).all(wikiId, relPath, relPath, relPath)
      return rows.map((row) => ({
        path: row.node_path,
        count: row.observation_count,
        latestTs: row.latest_ts
      }))
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
