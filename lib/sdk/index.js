/**
 * wiki-sdk — environment-neutral client for the wiki API.
 *
 * Works in Node.js and browsers; depends only on `fetch`. Hides the
 * JSON-RPC transport and maps API errors to typed error classes.
 * Contains no wiki domain rules.
 */

import { errorFromRpc, NetworkError, RpcError } from './errors.js'

export * from './errors.js'

/**
 * Split an address into its page and, for a record, its key: a record
 * is addressed as its page's path, a slash, and its key
 * (`acme.crm.contacts/jo@acme.com`). Slugs never contain a slash, so
 * the first one is the boundary; everything after it is the key.
 *
 * @param {string} address
 * @returns {{ path: string, key: string|null }}
 */
export function splitAddress (address) {
  const at = String(address).indexOf('/')
  if (at === -1) return { path: address, key: null }
  const key = address.slice(at + 1)
  return { path: address.slice(0, at), key: key === '' ? null : key }
}

export class WikiClient {
  /**
   * @param {object} options
   * @param {string} options.baseUrl e.g. "http://localhost:3000"
   * @param {string} [options.token] bearer token
   * @param {typeof fetch} [options.fetch] injectable fetch for tests
   */
  constructor ({ baseUrl, token, fetch: fetchImpl } = {}) {
    if (!baseUrl) throw new NetworkError('baseUrl is required', { code: 'CONFIG' })
    this.baseUrl = baseUrl.replace(/\/+$/, '')
    this.token = token
    this._fetch = fetchImpl || globalThis.fetch.bind(globalThis)
    this._nextId = 1
  }

  /** @private */
  async rpc (method, params) {
    const id = this._nextId++
    let response
    try {
      response = await this._fetch(`${this.baseUrl}/rpc`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(this.token ? { authorization: `Bearer ${this.token}` } : {})
        },
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params })
      })
    } catch (error) {
      throw new NetworkError(`request failed: ${error.message}`, { code: 'NETWORK' })
    }
    let body
    try {
      body = await response.json()
    } catch {
      throw new RpcError(`invalid response (HTTP ${response.status})`, { code: 'RPC_ERROR' })
    }
    if (body.error) throw errorFromRpc(body.error)
    return body.result
  }

  /**
   * List all wikis (their root nodes).
   */
  async list () {
    return this.rpc('wiki.list', {})
  }

  /**
   * Read a node. Options allow historical reads.
   *
   * @param {string} path full path, e.g. "acme.about.foo"
   * @param {{ commitId?: number, at?: string }} [options]
   */
  async get (path, { commitId, at } = {}) {
    return this.rpc('wiki.get', { path, commitId, at })
  }

  /**
   * Create or replace a node (creates the wiki for one-segment paths).
   *
   * @param {string} path
   * @param {{ content?: string, title?: string|null, metadata?: object,
   *           expectedRevisionId?: string, message?: string }} [options]
   * @returns {Promise<{ node: object, changed: boolean, created: boolean }>}
   */
  async set (path, { content, title, metadata, expectedRevisionId, message } = {}) {
    return this.rpc('wiki.set', { path, content, title, metadata, expectedRevisionId, message })
  }

  /**
   * @param {string} path
   * @param {{ depth?: number, commitId?: number, at?: string }} [options]
   */
  async tree (path, { depth, commitId, at } = {}) {
    return this.rpc('wiki.tree', { path, depth, commitId, at })
  }

  /**
   * @param {string} path subtree to search
   * @param {string} query
   * @param {{ limit?: number }} [options]
   */
  async search (path, query, { limit } = {}) {
    return this.rpc('wiki.search', { path, query, limit })
  }

  /**
   * @param {string} path
   * @param {{ limit?: number }} [options]
   */
  async history (path, { limit } = {}) {
    return this.rpc('wiki.history', { path, limit })
  }

  /**
   * The wiki's change log, newest first: commits with the pages they
   * touched. `path` may name a subtree to scope to.
   * @param {string} path
   * @param {{ limit?: number, before?: number }} [options]
   */
  async log (path, { limit, before } = {}) {
    return this.rpc('wiki.log', { path, limit, before })
  }

  /**
   * @param {string} from full path
   * @param {string} to full path in the same wiki
   * @param {{ expectedRevisionId?: string, message?: string }} [options]
   */
  async move (from, to, { expectedRevisionId, message } = {}) {
    return this.rpc('wiki.move', { from, to, expectedRevisionId, message })
  }

  /**
   * @param {string} path
   * @param {{ recursive?: boolean, expectedRevisionId?: string,
   *           expectedCommitId?: number, message?: string }} [options]
   */
  async remove (path, { recursive, expectedRevisionId, expectedCommitId, message } = {}) {
    return this.rpc('wiki.remove', { path, recursive, expectedRevisionId, expectedCommitId, message })
  }

  /**
   * Notes on a page, oldest first (open notes only unless includeResolved).
   * With `subtree`, notes for the page and every descendant — the triage
   * queue — ordered by page then age.
   *
   * @param {string} path
   * @param {{ includeResolved?: boolean, subtree?: boolean }} [options]
   */
  async notes (path, { includeResolved, subtree } = {}) {
    return this.rpc('wiki.notes', { path, includeResolved, subtree })
  }

  /**
   * Attach a note to a page.
   *
   * @param {string} path
   * @param {string} body
   */
  async note (path, body) {
    return this.rpc('wiki.note', { path, body })
  }

  /**
   * Mark a note resolved (idempotent).
   *
   * @param {string} path
   * @param {string} noteId
   */
  async resolveNote (path, noteId) {
    return this.rpc('wiki.resolveNote', { path, noteId })
  }

  /**
   * Write one record (a JSON object) to a page. A table (a page with a
   * key) upserts by its key field — `ifVersion` makes that a
   * compare-and-swap; a log appends — `ts` backfills when it happened.
   *
   * @param {string} path
   * @param {object} value
   * @param {{ ts?: string, ifVersion?: number }} [options]
   * @returns {Promise<{ fullPath: string, record: object }>}
   */
  async put (path, value, { ts, ifVersion } = {}) {
    return this.rpc('wiki.put', { path, value, ts, ifVersion })
  }

  /**
   * Delete one record by its address within the page (key value on a
   * table, `_id` on a log). Returns the deleted record.
   *
   * @param {string} path
   * @param {string} key
   * @returns {Promise<{ fullPath: string, record: object }>}
   */
  async del (path, key) {
    return this.rpc('wiki.del', { path, key })
  }

  /**
   * Read a page's records. With `key`, exactly that record (combines
   * with nothing else): `{ fullPath, record }`. Otherwise a page of
   * records in sort order (or reversed with `reverse`), bounded by
   * `since`/`until`, capped by `limit`, continued with `cursor`;
   * `latest` returns only the newest: `{ fullPath, records, cursor? }`.
   * With `at`, the records as they stood at that moment: a table whole
   * (`unknown` names keys whose state then was not kept), a log in
   * pages, the records written by then.
   *
   * @param {string} path
   * @param {{ key?: string, latest?: boolean, reverse?: boolean, since?: string,
   *           until?: string, limit?: number, cursor?: string, at?: string }} [options]
   */
  async data (path, { key, latest, reverse, since, until, limit, cursor, at } = {}) {
    return this.rpc('wiki.data', { path, key, latest, reverse, since, until, limit, cursor, at })
  }

  /**
   * A table record's versions, newest first: `{ fullPath, key, versions, cursor? }`.
   * Each is the record as that version left it, with `_change`
   * (created, updated, deleted).
   *
   * @param {string} path the table's full path
   * @param {string} key
   * @param {{ limit?: number, cursor?: string }} [options]
   */
  async versions (path, key, { limit, cursor } = {}) {
    return this.rpc('wiki.versions', { path, key, limit, cursor })
  }

  /**
   * One version of a table record and the one before it — what a diff
   * reads: `{ fullPath, key, version, previous }`.
   *
   * @param {string} path the table's full path
   * @param {string} key
   * @param {number} version
   */
  async version (path, key, version) {
    return this.rpc('wiki.version', { path, key, version })
  }

  /**
   * What links to a page, or to one of its records:
   * `{ fullPath, key, links: [{ fullPath, path, key, title, record? }] }`.
   *
   * @param {string} path the page's full path
   * @param {{ key?: string, limit?: number }} [options]
   */
  async links (path, { key, limit } = {}) {
    return this.rpc('wiki.links', { path, key, limit })
  }

  /**
   * Merge fields into a page's metadata (an authored change touching
   * only the named fields; `null` removes a field). `replace` swaps
   * the whole object instead.
   *
   * @param {string} path
   * @param {object} metadata
   * @param {{ replace?: boolean, expectedRevisionId?: string, message?: string }} [options]
   * @returns {Promise<{ node: object, changed: boolean }>}
   */
  async meta (path, metadata, { replace, expectedRevisionId, message } = {}) {
    return this.rpc('wiki.meta', { path, metadata, replace, expectedRevisionId, message })
  }

  /**
   * @param {string} wiki root slug, e.g. "acme"
   * @param {number} commitId
   */
  async getCommit (wiki, commitId) {
    return this.rpc('wiki.getCommit', { wiki, commitId })
  }

  /**
   * A revision and the one before it on the same page — what a diff
   * reads. Revision ids come from `history` and `log`.
   * @param {string} wiki root slug
   * @param {string} revisionId
   */
  async revision (wiki, revisionId) {
    return this.rpc('wiki.revision', { wiki, revisionId })
  }

  /**
   * @param {string} wiki root slug
   * @param {{ commitId?: number, at?: string }} [options]
   */
  async snapshot (wiki, { commitId, at } = {}) {
    return this.rpc('wiki.snapshot', { wiki, commitId, at })
  }
}
