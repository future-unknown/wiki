import should from 'should'
import { once } from 'node:events'
import express from 'express'
import Database from 'better-sqlite3'
import { createWikiKit } from '../lib/kit/index.js'
import { createWikiRouter, createStaticTokenAuth } from '../lib/api/index.js'

const servers = []

async function createTestApi () {
  const db = new Database(':memory:')
  const kit = createWikiKit({ db })
  await kit.migrate()
  const auth = createStaticTokenAuth({
    tokens: {
      'human-token': { actor: { type: 'human', id: 'user_123', onBehalfOf: null } },
      'agent-token': { actor: { type: 'agent', id: 'agent_9', onBehalfOf: 'user_123' } },
      'read-token': { actor: { type: 'human', id: 'reader', onBehalfOf: null }, allow: ['wiki:read'] },
      'push-token': { actor: { type: 'agent', id: 'meter_1', onBehalfOf: null }, allow: ['wiki:push'] }
    }
  })
  const app = express()
  app.use(createWikiRouter({ kit, auth }))
  const server = app.listen(0, '127.0.0.1')
  await once(server, 'listening')
  servers.push(server)
  const baseUrl = `http://127.0.0.1:${server.address().port}`

  async function rpc (method, params, token = 'human-token') {
    const response = await fetch(`${baseUrl}/rpc`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {})
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
    })
    response.status.should.equal(200)
    return response.json()
  }

  return { rpc, baseUrl, kit, db }
}

afterEach(() => {
  while (servers.length > 0) servers.pop().close()
})

describe('wiki-api', () => {
  describe('authentication', () => {
    it('rejects requests without a token', async () => {
      const { rpc } = await createTestApi()
      const body = await rpc('wiki.get', { path: 'acme' }, null)
      body.error.data.code.should.equal('UNAUTHENTICATED')
    })

    it('rejects invalid tokens', async () => {
      const { rpc } = await createTestApi()
      const body = await rpc('wiki.get', { path: 'acme' }, 'wrong')
      body.error.data.code.should.equal('UNAUTHENTICATED')
    })
  })

  describe('authorization', () => {
    it('lets a read-only token read but not write', async () => {
      const { rpc } = await createTestApi()
      await rpc('wiki.set', { path: 'acme', content: 'root' })
      const read = await rpc('wiki.get', { path: 'acme' }, 'read-token')
      read.result.content.should.equal('root')
      const write = await rpc('wiki.set', { path: 'acme.x', content: 'x' }, 'read-token')
      write.error.data.code.should.equal('UNAUTHORIZED')
    })

    it('authorizes wiki:create for new root wikis', async () => {
      const { rpc } = await createTestApi()
      const denied = await rpc('wiki.set', { path: 'acme', content: 'root' }, 'read-token')
      denied.error.data.code.should.equal('UNAUTHORIZED')
    })
  })

  describe('wiki.set / wiki.get', () => {
    it('creates a wiki from a one-segment set and resolves full paths', async () => {
      const { rpc } = await createTestApi()
      const created = await rpc('wiki.set', { path: 'acme', content: 'This is the acme wiki' })
      created.result.created.should.be.true()
      created.result.node.fullPath.should.equal('acme')
      created.result.node.id.should.equal(created.result.node.wikiId)

      await rpc('wiki.set', { path: 'acme.about.foo', content: 'This is all about foo' })
      const got = await rpc('wiki.get', { path: 'acme.about.foo' })
      got.result.content.should.equal('This is all about foo')
      got.result.fullPath.should.equal('acme.about.foo')
      got.result.path.should.equal('about.foo')
    })

    it('creates the wiki automatically from a nested write', async () => {
      const { rpc } = await createTestApi()
      const body = await rpc('wiki.set', { path: 'ghost.about.team', content: 'The team' })
      body.result.created.should.be.true()
      body.result.node.fullPath.should.equal('ghost.about.team')
      const root = await rpc('wiki.get', { path: 'ghost' })
      root.result.content.should.equal('')
      const tree = await rpc('wiki.tree', { path: 'ghost' })
      tree.result.children[0].children[0].fullPath.should.equal('ghost.about.team')
    })

    it('requires wiki:create to bootstrap a wiki from a nested write', async () => {
      const { rpc } = await createTestApi()
      const denied = await rpc('wiki.set', { path: 'ghost.about', content: 'x' }, 'read-token')
      denied.error.data.code.should.equal('UNAUTHORIZED')
    })

    it('maps validation errors', async () => {
      const { rpc } = await createTestApi()
      const body = await rpc('wiki.set', { path: 'Bad.Path', content: 'x' })
      body.error.data.code.should.equal('VALIDATION_ERROR')
    })

    it('maps revision conflicts', async () => {
      const { rpc } = await createTestApi()
      await rpc('wiki.set', { path: 'acme', content: 'root' })
      await rpc('wiki.set', { path: 'acme.doc', content: 'v1' })
      const doc = await rpc('wiki.get', { path: 'acme.doc' })
      await rpc('wiki.set', { path: 'acme.doc', content: 'v2' })
      const conflict = await rpc('wiki.set', {
        path: 'acme.doc', content: 'v3', expectedRevisionId: doc.result.revisionId
      })
      conflict.error.data.code.should.equal('REVISION_CONFLICT')
    })

    it('propagates the actor from the token to commits', async () => {
      const { rpc } = await createTestApi()
      await rpc('wiki.set', { path: 'acme', content: 'root' }, 'agent-token')
      const node = await rpc('wiki.get', { path: 'acme' })
      const commit = await rpc('wiki.getCommit', { wiki: 'acme', commitId: node.result.commitId })
      commit.result.actor.should.deepEqual({ type: 'agent', id: 'agent_9', onBehalfOf: 'user_123' })
    })
  })

  describe('wiki.tree / wiki.search / wiki.history', () => {
    async function seed (rpc) {
      await rpc('wiki.set', { path: 'acme', content: 'This is the acme wiki' })
      await rpc('wiki.set', { path: 'acme.about', content: 'This is an about section' })
      await rpc('wiki.set', { path: 'acme.about.foo', content: 'This is all about foo' })
      await rpc('wiki.set', { path: 'acme.about.bar', content: 'This is all about bar' })
    }

    it('returns a tree with full paths', async () => {
      const { rpc } = await createTestApi()
      await seed(rpc)
      const tree = await rpc('wiki.tree', { path: 'acme' })
      tree.result.fullPath.should.equal('acme')
      tree.result.children[0].fullPath.should.equal('acme.about')
      tree.result.children[0].children.map((child) => child.fullPath)
        .should.deepEqual(['acme.about.bar', 'acme.about.foo'])
    })

    it('searches with full paths and excerpts', async () => {
      const { rpc } = await createTestApi()
      await seed(rpc)
      const found = await rpc('wiki.search', { path: 'acme', query: 'foo' })
      found.result.length.should.equal(1)
      found.result[0].fullPath.should.equal('acme.about.foo')
      found.result[0].excerpt.should.containEql('[foo]')
    })

    it('returns history', async () => {
      const { rpc } = await createTestApi()
      await seed(rpc)
      await rpc('wiki.set', { path: 'acme.about.foo', content: 'v2', message: 'edit' })
      const history = await rpc('wiki.history', { path: 'acme.about.foo' })
      history.result.length.should.equal(2)
      history.result[0].commit.message.should.equal('edit')
    })
  })

  describe('wiki.move / wiki.remove', () => {
    it('moves nodes and rejects cross-wiki moves', async () => {
      const { rpc } = await createTestApi()
      await rpc('wiki.set', { path: 'acme', content: 'root' })
      await rpc('wiki.set', { path: 'other', content: 'other root' })
      await rpc('wiki.set', { path: 'acme.a.b', content: 'b' })
      const moved = await rpc('wiki.move', { from: 'acme.a.b', to: 'acme.b' })
      moved.result.fullPath.should.equal('acme.b')
      const cross = await rpc('wiki.move', { from: 'acme.b', to: 'other.b' })
      cross.error.data.code.should.equal('CROSS_WIKI_MOVE')
    })

    it('removes nodes and maps non-empty errors', async () => {
      const { rpc } = await createTestApi()
      await rpc('wiki.set', { path: 'acme', content: 'root' })
      await rpc('wiki.set', { path: 'acme.a.b', content: 'b' })
      const nonEmpty = await rpc('wiki.remove', { path: 'acme.a' })
      nonEmpty.error.data.code.should.equal('NON_EMPTY_NODE')
      const removed = await rpc('wiki.remove', { path: 'acme.a', recursive: true })
      removed.result.deletedPaths.should.deepEqual(['acme.a', 'acme.a.b'])
    })
  })

  describe('wiki.note / wiki.notes / wiki.resolveNote', () => {
    it('adds, lists, and resolves notes with the session actor', async () => {
      const { rpc } = await createTestApi()
      await rpc('wiki.set', { path: 'acme.doc', content: 'v1' })

      const added = await rpc('wiki.note', { path: 'acme.doc', body: 'Needs a diagram.' }, 'agent-token')
      added.result.author.should.deepEqual({ type: 'agent', id: 'agent_9', onBehalfOf: 'user_123' })
      added.result.fullPath.should.equal('acme.doc')

      const listed = await rpc('wiki.notes', { path: 'acme.doc' }, 'read-token')
      listed.result.length.should.equal(1)

      const resolved = await rpc('wiki.resolveNote', { path: 'acme.doc', noteId: added.result.id })
      resolved.result.resolvedBy.should.deepEqual({ type: 'human', id: 'user_123' })

      const open = await rpc('wiki.notes', { path: 'acme.doc' })
      open.result.length.should.equal(0)
      const all = await rpc('wiki.notes', { path: 'acme.doc', includeResolved: true })
      all.result.length.should.equal(1)
    })

    it('lists a subtree queue with per-note full paths', async () => {
      const { rpc } = await createTestApi()
      await rpc('wiki.set', { path: 'acme.docs.a', content: 'a' })
      await rpc('wiki.set', { path: 'acme.docs.b', content: 'b' })
      await rpc('wiki.note', { path: 'acme.docs.a', body: 'note a' })
      await rpc('wiki.note', { path: 'acme.docs.b', body: 'note b' })

      const queue = await rpc('wiki.notes', { path: 'acme', subtree: true })
      queue.result.map((note) => note.fullPath).should.deepEqual(['acme.docs.a', 'acme.docs.b'])
    })

    it('requires write access to add or resolve', async () => {
      const { rpc } = await createTestApi()
      await rpc('wiki.set', { path: 'acme.doc', content: 'v1' })
      const denied = await rpc('wiki.note', { path: 'acme.doc', body: 'x' }, 'read-token')
      denied.error.data.code.should.equal('UNAUTHORIZED')
    })
  })

  describe('wiki.push / wiki.data', () => {
    it('pushes observations and reads them back with full paths', async () => {
      const { rpc } = await createTestApi()
      await rpc('wiki.set', { path: 'acme.usage', content: 'API usage.' })

      const pushed = await rpc('wiki.push', {
        path: 'acme.usage', payload: { requests: 1042 }
      }, 'agent-token')
      pushed.result.fullPath.should.equal('acme.usage')
      pushed.result.payload.should.deepEqual({ requests: 1042 })
      pushed.result.actor.should.deepEqual({ type: 'agent', id: 'agent_9', onBehalfOf: 'user_123' })

      const read = await rpc('wiki.data', { path: 'acme.usage', latest: true }, 'read-token')
      read.result.fullPath.should.equal('acme.usage')
      read.result.rows.length.should.equal(1)
      read.result.rows[0].payload.should.deepEqual({ requests: 1042 })
    })

    it('scopes a push-only token to pushing', async () => {
      const { rpc } = await createTestApi()
      await rpc('wiki.set', { path: 'acme.usage', content: 'API usage.' })

      const pushed = await rpc('wiki.push', { path: 'acme.usage', payload: 1 }, 'push-token')
      pushed.result.payload.should.equal(1)
      const write = await rpc('wiki.set', { path: 'acme.usage', content: 'x' }, 'push-token')
      write.error.data.code.should.equal('UNAUTHORIZED')
      const read = await rpc('wiki.data', { path: 'acme.usage' }, 'push-token')
      read.error.data.code.should.equal('UNAUTHORIZED')
    })

    it('keeps writing and pushing distinct actions', async () => {
      const { rpc } = await createTestApi()
      await rpc('wiki.set', { path: 'acme.usage', content: 'API usage.' })
      const denied = await rpc('wiki.push', { path: 'acme.usage', payload: 1 }, 'read-token')
      denied.error.data.code.should.equal('UNAUTHORIZED')
    })

    it('maps validation and not-found errors', async () => {
      const { rpc } = await createTestApi()
      await rpc('wiki.set', { path: 'acme.usage', content: 'API usage.' })
      const missing = await rpc('wiki.push', { path: 'acme.nope', payload: 1 })
      missing.error.data.code.should.equal('NOT_FOUND')
      const invalid = await rpc('wiki.data', { path: 'acme.usage', latest: true, limit: 5 })
      invalid.error.data.code.should.equal('VALIDATION_ERROR')
    })

    it('summarizes data pages with full paths for any reader', async () => {
      const { rpc } = await createTestApi()
      await rpc('wiki.set', { path: 'acme.usage', content: 'API usage.' })
      await rpc('wiki.push', { path: 'acme.usage', payload: 1 }, 'agent-token')
      const summary = await rpc('wiki.dataSummary', { path: 'acme' }, 'read-token')
      summary.result.length.should.equal(1)
      summary.result[0].fullPath.should.equal('acme.usage')
      summary.result[0].count.should.equal(1)
      summary.result[0].latestTs.should.be.a.String()
    })
  })

  describe('wiki.list', () => {
    it('lists wikis for any authenticated reader', async () => {
      const { rpc } = await createTestApi()
      const empty = await rpc('wiki.list', {}, 'read-token')
      empty.result.should.deepEqual([])
      await rpc('wiki.set', { path: 'acme', content: 'a' })
      await rpc('wiki.set', { path: 'other', content: 'o' })
      const listed = await rpc('wiki.list', {}, 'read-token')
      listed.result.map((wiki) => wiki.fullPath).should.deepEqual(['acme', 'other'])
    })
  })

  describe('wiki.snapshot', () => {
    it('returns historical snapshots', async () => {
      const { rpc } = await createTestApi()
      await rpc('wiki.set', { path: 'acme', content: 'root' })
      const doc = await rpc('wiki.set', { path: 'acme.doc', content: 'v1' })
      await rpc('wiki.set', { path: 'acme.later', content: 'later' })
      const snapshot = await rpc('wiki.snapshot', {
        wiki: 'acme', commitId: doc.result.node.commitId
      })
      snapshot.result.nodes.map((node) => node.fullPath).should.deepEqual(['acme', 'acme.doc'])
    })
  })

  describe('protocol', () => {
    it('rejects unknown methods', async () => {
      const { rpc } = await createTestApi()
      const body = await rpc('wiki.nope', {})
      body.error.code.should.equal(-32601)
    })

    it('rejects malformed requests', async () => {
      const { baseUrl } = await createTestApi()
      const response = await fetch(`${baseUrl}/rpc`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer human-token' },
        body: JSON.stringify({ method: 'wiki.get' })
      })
      const body = await response.json()
      body.error.code.should.equal(-32600)
    })

    it('answers malformed JSON with a parse error', async () => {
      const { baseUrl } = await createTestApi()
      const response = await fetch(`${baseUrl}/rpc`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer human-token' },
        body: '{ not json'
      })
      const body = await response.json()
      body.error.code.should.equal(-32700)
    })

    it('answers CORS preflight', async () => {
      const { baseUrl } = await createTestApi()
      const response = await fetch(`${baseUrl}/rpc`, { method: 'OPTIONS' })
      response.status.should.equal(204)
      response.headers.get('access-control-allow-origin').should.equal('*')
    })

    it('serves /health', async () => {
      const { baseUrl } = await createTestApi()
      const response = await fetch(`${baseUrl}/health`)
      const body = await response.json()
      body.ok.should.be.true()
    })
  })

  describe('method table (host embedding)', () => {
    it('exposes transport-neutral methods for a host RPC server', async () => {
      const { kit } = await createTestApi()
      const { createWikiMethods } = await import('../lib/api/index.js')
      const methods = createWikiMethods({ kit }) // no auth: host guards calls itself
      const principal = { actor: { type: 'human', id: 'host_user', onBehalfOf: null } }
      const created = await methods['wiki.set'](principal, { path: 'hosted', content: 'via host' })
      created.created.should.be.true()
      const node = await methods['wiki.get'](principal, { path: 'hosted' })
      node.content.should.equal('via host')
      const commit = await methods['wiki.getCommit'](principal, { wiki: 'hosted', commitId: node.commitId })
      commit.actor.id.should.equal('host_user')
    })
  })
})
