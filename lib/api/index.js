/**
 * wiki API layer.
 *
 * Two doors, one set of rules:
 *
 *   createWikiMethods({ kit, auth })  transport-neutral JSON-RPC method
 *                                     table — mount these on any host's
 *                                     RPC server (each method takes
 *                                     (principal, params))
 *
 *   createWikiRouter({ kit, auth })   an express.Router exposing the
 *                                     table at POST /rpc for standalone
 *                                     or embedded Express apps
 *
 * This layer owns authentication hooks, authorization checks, transport
 * validation, and error mapping. It contains no SQL and no domain rules:
 * full public paths resolve to (wikiId, relative path) and go to the kit.
 */

import express from 'express'
import {
  WikiError,
  ValidationError,
  NotFoundError,
  CrossWikiMoveError,
  parseFullPath
} from '../kit/index.js'
import { UnauthenticatedError } from './auth.js'

export { createStaticTokenAuth, UnauthenticatedError, UnauthorizedError } from './auth.js'
export { openDatabase } from './db.js'

const RPC = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  DOMAIN_ERROR: -32000
}

function fullPathOf (rootSlug, relPath) {
  return relPath === '' ? rootSlug : `${rootSlug}.${relPath}`
}

function decorateNode (rootSlug, node) {
  return { ...node, fullPath: fullPathOf(rootSlug, node.path) }
}

function decorateTree (rootSlug, tree) {
  return {
    ...decorateNode(rootSlug, tree),
    children: tree.children.map((child) => decorateTree(rootSlug, child))
  }
}

function requireString (params, key, { optional = false } = {}) {
  const value = params[key]
  if (value === undefined || value === null) {
    if (optional) return undefined
    throw new ValidationError(`${key} is required`, { param: key })
  }
  if (typeof value !== 'string') {
    throw new ValidationError(`${key} must be a string`, { param: key })
  }
  return value
}

/**
 * Build the transport-neutral method table. Every method has the shape
 * `(principal, params) => result` and throws domain errors; hosts map
 * those to their wire format (createWikiRouter does this for JSON-RPC).
 *
 * `auth.authorize(principal, operation)` is consulted per call when
 * provided; hosts that guard calls themselves may omit it.
 *
 * @param {{ kit: object, auth?: { authorize?: Function } }} options
 */
export function createWikiMethods ({ kit, auth }) {
  if (!kit) throw new Error('kit is required')
  const authorize = auth?.authorize
    ? auth.authorize.bind(auth)
    : async () => {}

  /**
   * Resolve a full public path to { wiki, relPath, rootSlug }.
   * Throws NotFoundError when the wiki root does not exist.
   */
  async function resolveWiki (fullPath) {
    const { slug, path } = parseFullPath(fullPath)
    const wiki = await kit.resolveWikiBySlug({ slug })
    if (!wiki) throw new NotFoundError('wiki not found', { wiki: slug })
    return { wiki, relPath: path, rootSlug: slug }
  }

  return {
    async 'wiki.list' (principal) {
      await authorize(principal, { action: 'wiki:read', wiki: null, path: null })
      const wikis = await kit.listWikis()
      return wikis.map((wiki) => decorateNode(wiki.slug, wiki))
    },

    async 'wiki.get' (principal, params) {
      const fullPath = requireString(params, 'path')
      const { wiki, relPath, rootSlug } = await resolveWiki(fullPath)
      await authorize(principal, { action: 'wiki:read', wiki: rootSlug, path: fullPath })
      const node = await kit.getNode({
        wikiId: wiki.id, path: relPath, commitId: params.commitId, at: params.at
      })
      return decorateNode(rootSlug, node)
    },

    async 'wiki.set' (principal, params) {
      const fullPath = requireString(params, 'path')
      const { slug, path: relPath } = parseFullPath(fullPath)
      const wiki = await kit.resolveWikiBySlug({ slug })

      if (!wiki) {
        // The wiki does not exist yet: any write bootstraps it. The
        // root (and intermediates) are created in the same commit.
        await authorize(principal, { action: 'wiki:create', wiki: slug, path: fullPath })
        const node = await kit.createWiki({
          slug,
          path: relPath,
          title: params.title,
          content: params.content,
          metadata: params.metadata,
          actor: principal.actor,
          message: params.message
        })
        return { node: decorateNode(slug, node), changed: true, created: true }
      }

      await authorize(principal, { action: 'wiki:write', wiki: slug, path: fullPath })
      const result = await kit.setNode({
        wikiId: wiki.id,
        path: relPath,
        title: params.title,
        content: params.content,
        metadata: params.metadata,
        expectedRevisionId: params.expectedRevisionId,
        actor: principal.actor,
        message: params.message
      })
      return { node: decorateNode(slug, result.node), changed: result.changed, created: result.created }
    },

    async 'wiki.tree' (principal, params) {
      const fullPath = requireString(params, 'path')
      const { wiki, relPath, rootSlug } = await resolveWiki(fullPath)
      await authorize(principal, { action: 'wiki:read', wiki: rootSlug, path: fullPath })
      const tree = await kit.getTree({
        wikiId: wiki.id, path: relPath, depth: params.depth, commitId: params.commitId, at: params.at
      })
      return decorateTree(rootSlug, tree)
    },

    async 'wiki.search' (principal, params) {
      const fullPath = requireString(params, 'path')
      const query = requireString(params, 'query')
      const { wiki, relPath, rootSlug } = await resolveWiki(fullPath)
      await authorize(principal, { action: 'wiki:read', wiki: rootSlug, path: fullPath })
      const results = await kit.search({
        wikiId: wiki.id, path: relPath, query, limit: params.limit
      })
      return results.map((result) => ({ ...result, fullPath: fullPathOf(rootSlug, result.path) }))
    },

    async 'wiki.history' (principal, params) {
      const fullPath = requireString(params, 'path')
      const { wiki, relPath, rootSlug } = await resolveWiki(fullPath)
      await authorize(principal, { action: 'wiki:read', wiki: rootSlug, path: fullPath })
      const history = await kit.getNodeHistory({
        wikiId: wiki.id, path: relPath, limit: params.limit
      })
      return history.map((entry) => ({ ...entry, fullPath }))
    },

    async 'wiki.move' (principal, params) {
      const from = requireString(params, 'from')
      const to = requireString(params, 'to')
      const parsedFrom = parseFullPath(from)
      const parsedTo = parseFullPath(to)
      if (parsedFrom.slug !== parsedTo.slug) {
        throw new CrossWikiMoveError('cannot move between wikis', { from, to })
      }
      const { wiki, rootSlug } = await resolveWiki(from)
      await authorize(principal, { action: 'wiki:write', wiki: rootSlug, path: from })
      const node = await kit.moveNode({
        wikiId: wiki.id,
        fromPath: parsedFrom.path,
        toPath: parsedTo.path,
        expectedRevisionId: params.expectedRevisionId,
        actor: principal.actor,
        message: params.message
      })
      return decorateNode(rootSlug, node)
    },

    async 'wiki.remove' (principal, params) {
      const fullPath = requireString(params, 'path')
      const { wiki, relPath, rootSlug } = await resolveWiki(fullPath)
      await authorize(principal, { action: 'wiki:delete', wiki: rootSlug, path: fullPath })
      const result = await kit.deleteNode({
        wikiId: wiki.id,
        path: relPath,
        recursive: params.recursive,
        expectedRevisionId: params.expectedRevisionId,
        expectedCommitId: params.expectedCommitId,
        actor: principal.actor,
        message: params.message
      })
      return {
        commitId: result.commitId,
        deletedPaths: result.deletedPaths.map((deleted) => fullPathOf(rootSlug, deleted))
      }
    },

    async 'wiki.notes' (principal, params) {
      const fullPath = requireString(params, 'path')
      const { wiki, relPath, rootSlug } = await resolveWiki(fullPath)
      await authorize(principal, { action: 'wiki:read', wiki: rootSlug, path: fullPath })
      const notes = await kit.listNotes({
        wikiId: wiki.id,
        path: relPath,
        includeResolved: params.includeResolved,
        subtree: params.subtree
      })
      // Each note names its own page: in subtree mode pages differ per note.
      return notes.map((note) => ({ ...note, fullPath: fullPathOf(rootSlug, note.path) }))
    },

    async 'wiki.note' (principal, params) {
      const fullPath = requireString(params, 'path')
      const { wiki, relPath, rootSlug } = await resolveWiki(fullPath)
      await authorize(principal, { action: 'wiki:write', wiki: rootSlug, path: fullPath })
      const note = await kit.addNote({
        wikiId: wiki.id, path: relPath, body: params.body, actor: principal.actor
      })
      return { ...note, fullPath }
    },

    async 'wiki.resolveNote' (principal, params) {
      const fullPath = requireString(params, 'path')
      const { wiki, relPath, rootSlug } = await resolveWiki(fullPath)
      await authorize(principal, { action: 'wiki:write', wiki: rootSlug, path: fullPath })
      const note = await kit.resolveNote({
        wikiId: wiki.id, path: relPath, noteId: params.noteId, actor: principal.actor
      })
      return { ...note, fullPath }
    },

    async 'wiki.push' (principal, params) {
      const fullPath = requireString(params, 'path')
      const { wiki, relPath, rootSlug } = await resolveWiki(fullPath)
      // Pushing observations is its own action, distinct from authoring:
      // emitter principals can be scoped to report data and nothing else.
      await authorize(principal, { action: 'wiki:push', wiki: rootSlug, path: fullPath })
      const datum = await kit.pushData({
        wikiId: wiki.id,
        path: relPath,
        payload: params.payload,
        ts: params.ts,
        actor: principal.actor
      })
      return { ...datum, fullPath }
    },

    async 'wiki.data' (principal, params) {
      const fullPath = requireString(params, 'path')
      const { wiki, relPath, rootSlug } = await resolveWiki(fullPath)
      await authorize(principal, { action: 'wiki:read', wiki: rootSlug, path: fullPath })
      const rows = await kit.getData({
        wikiId: wiki.id,
        path: relPath,
        latest: params.latest,
        since: params.since,
        until: params.until,
        limit: params.limit
      })
      return { fullPath, rows }
    },

    async 'wiki.getCommit' (principal, params) {
      const wikiSlug = requireString(params, 'wiki')
      const { wiki, rootSlug } = await resolveWiki(wikiSlug)
      await authorize(principal, { action: 'wiki:read', wiki: rootSlug, path: wikiSlug })
      return kit.getCommit({ wikiId: wiki.id, commitId: params.commitId })
    },

    async 'wiki.snapshot' (principal, params) {
      const wikiSlug = requireString(params, 'wiki')
      const { wiki, rootSlug } = await resolveWiki(wikiSlug)
      await authorize(principal, { action: 'wiki:read', wiki: rootSlug, path: wikiSlug })
      const snapshot = await kit.getSnapshot({
        wikiId: wiki.id, commitId: params.commitId, at: params.at
      })
      return {
        commitId: snapshot.commitId,
        nodes: snapshot.nodes.map((node) => decorateNode(rootSlug, node))
      }
    }
  }
}

function rpcError (id, code, message, data) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message, ...(data ? { data } : {}) } }
}

function mapError (id, error) {
  if (error instanceof WikiError) {
    return rpcError(id, RPC.DOMAIN_ERROR, error.message, {
      code: error.code,
      details: error.details
    })
  }
  return rpcError(id, RPC.INTERNAL_ERROR, 'internal error')
}

/**
 * Express adapter: mounts the method table at POST /rpc (plus /health
 * and permissive CORS for browser clients). Attach it to any Express
 * app:
 *
 *   const app = express()
 *   app.use(createWikiRouter({ kit, auth }))
 *
 * @param {object} options
 * @param {object} options.kit wiki-kit instance
 * @param {{ authenticate: Function, authorize: Function }} options.auth
 * @param {string} [options.bodyLimit] express.json limit (default '4mb')
 * @param {(error: Error) => void} [options.onError] hook for unexpected errors
 */
export function createWikiRouter ({ kit, auth, bodyLimit = '4mb', onError } = {}) {
  if (!auth || typeof auth.authenticate !== 'function' || typeof auth.authorize !== 'function') {
    throw new Error('auth with authenticate and authorize is required')
  }
  const methods = createWikiMethods({ kit, auth })
  const router = express.Router()

  router.use((request, response, next) => {
    response.set('access-control-allow-origin', '*')
    response.set('access-control-allow-methods', 'POST, OPTIONS')
    response.set('access-control-allow-headers', 'content-type, authorization')
    if (request.method === 'OPTIONS') return response.status(204).end()
    next()
  })

  router.get('/health', (request, response) => response.json({ ok: true }))

  router.post('/rpc', express.json({ limit: bodyLimit }), async (request, response) => {
    const body = request.body
    if (!body || typeof body !== 'object' || Array.isArray(body) ||
        body.jsonrpc !== '2.0' || typeof body.method !== 'string') {
      return response.json(rpcError(body?.id, RPC.INVALID_REQUEST, 'invalid JSON-RPC 2.0 request'))
    }
    const { id, method } = body
    const params = body.params ?? {}
    if (typeof params !== 'object' || Array.isArray(params)) {
      return response.json(rpcError(id, RPC.INVALID_PARAMS, 'params must be an object'))
    }
    const handler = methods[method]
    if (!handler) {
      return response.json(rpcError(id, RPC.METHOD_NOT_FOUND, `method not found: ${method}`))
    }
    try {
      const principal = await auth.authenticate(request)
      if (!principal || !principal.actor) throw new UnauthenticatedError()
      const result = await handler(principal, params)
      return response.json({ jsonrpc: '2.0', id: id ?? null, result })
    } catch (error) {
      if (!(error instanceof WikiError) && onError) onError(error)
      return response.json(mapError(id, error))
    }
  })

  // Body-parse failures (malformed JSON, oversized payloads) from
  // express.json surface here.
  router.use('/rpc', (error, request, response, next) => {
    if (error.type === 'entity.parse.failed' || error.type === 'entity.too.large') {
      return response.status(200).json(rpcError(null, RPC.PARSE_ERROR, 'parse error'))
    }
    if (onError) onError(error)
    return response.status(200).json(rpcError(null, RPC.INTERNAL_ERROR, 'internal error'))
  })

  return router
}
