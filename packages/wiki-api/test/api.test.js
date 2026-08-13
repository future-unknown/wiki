import should from 'should'
import Database from 'better-sqlite3'
import { createWikiKit } from 'wiki-kit'
import { createWikiApi, createStaticTokenAuth } from '../lib/index.js'

async function createTestApi () {
  const db = new Database(':memory:')
  const kit = createWikiKit({ db })
  await kit.migrate()
  const auth = createStaticTokenAuth({
    tokens: {
      'human-token': { actor: { type: 'human', id: 'user_123', onBehalfOf: null } },
      'agent-token': { actor: { type: 'agent', id: 'agent_9', onBehalfOf: 'user_123' } },
      'read-token': { actor: { type: 'human', id: 'reader', onBehalfOf: null }, allow: ['wiki:read'] }
    }
  })
  const app = createWikiApi({ kit, auth })
  return { app, kit, db }
}

async function rpc (app, method, params, token = 'human-token') {
  const response = await app.inject({
    method: 'POST',
    url: '/rpc',
    headers: token ? { authorization: `Bearer ${token}` } : {},
    payload: { jsonrpc: '2.0', id: 1, method, params }
  })
  response.statusCode.should.equal(200)
  return response.json()
}

describe('wiki-api', () => {
  describe('authentication', () => {
    it('rejects requests without a token', async () => {
      const { app } = await createTestApi()
      const body = await rpc(app, 'wiki.get', { path: 'acme' }, null)
      body.error.data.code.should.equal('UNAUTHENTICATED')
    })

    it('rejects invalid tokens', async () => {
      const { app } = await createTestApi()
      const body = await rpc(app, 'wiki.get', { path: 'acme' }, 'wrong')
      body.error.data.code.should.equal('UNAUTHENTICATED')
    })
  })

  describe('authorization', () => {
    it('lets a read-only token read but not write', async () => {
      const { app } = await createTestApi()
      await rpc(app, 'wiki.set', { path: 'acme', content: 'root' })
      const read = await rpc(app, 'wiki.get', { path: 'acme' }, 'read-token')
      read.result.content.should.equal('root')
      const write = await rpc(app, 'wiki.set', { path: 'acme.x', content: 'x' }, 'read-token')
      write.error.data.code.should.equal('UNAUTHORIZED')
    })

    it('authorizes wiki:create for new root wikis', async () => {
      const { app } = await createTestApi()
      const denied = await rpc(app, 'wiki.set', { path: 'acme', content: 'root' }, 'read-token')
      denied.error.data.code.should.equal('UNAUTHORIZED')
    })
  })

  describe('wiki.set / wiki.get', () => {
    it('creates a wiki from a one-segment set and resolves full paths', async () => {
      const { app } = await createTestApi()
      const created = await rpc(app, 'wiki.set', { path: 'acme', content: 'This is the acme wiki' })
      created.result.created.should.be.true()
      created.result.node.fullPath.should.equal('acme')
      created.result.node.id.should.equal(created.result.node.wikiId)

      await rpc(app, 'wiki.set', { path: 'acme.about.foo', content: 'This is all about foo' })
      const got = await rpc(app, 'wiki.get', { path: 'acme.about.foo' })
      got.result.content.should.equal('This is all about foo')
      got.result.fullPath.should.equal('acme.about.foo')
      got.result.path.should.equal('about.foo')
    })

    it('does not create a wiki from a nested write', async () => {
      const { app } = await createTestApi()
      const body = await rpc(app, 'wiki.set', { path: 'ghost.about', content: 'x' })
      body.error.data.code.should.equal('NOT_FOUND')
    })

    it('maps validation errors', async () => {
      const { app } = await createTestApi()
      const body = await rpc(app, 'wiki.set', { path: 'Bad.Path', content: 'x' })
      body.error.data.code.should.equal('VALIDATION_ERROR')
    })

    it('maps revision conflicts', async () => {
      const { app } = await createTestApi()
      await rpc(app, 'wiki.set', { path: 'acme', content: 'root' })
      await rpc(app, 'wiki.set', { path: 'acme.doc', content: 'v1' })
      const doc = await rpc(app, 'wiki.get', { path: 'acme.doc' })
      await rpc(app, 'wiki.set', { path: 'acme.doc', content: 'v2' })
      const conflict = await rpc(app, 'wiki.set', {
        path: 'acme.doc', content: 'v3', expectedRevisionId: doc.result.revisionId
      })
      conflict.error.data.code.should.equal('REVISION_CONFLICT')
    })

    it('propagates the actor from the token to commits', async () => {
      const { app } = await createTestApi()
      await rpc(app, 'wiki.set', { path: 'acme', content: 'root' }, 'agent-token')
      const node = await rpc(app, 'wiki.get', { path: 'acme' })
      const commit = await rpc(app, 'wiki.getCommit', { wiki: 'acme', commitId: node.result.commitId })
      commit.result.actor.should.deepEqual({ type: 'agent', id: 'agent_9', onBehalfOf: 'user_123' })
    })
  })

  describe('wiki.tree / wiki.search / wiki.history', () => {
    async function seed (app) {
      await rpc(app, 'wiki.set', { path: 'acme', content: 'This is the acme wiki' })
      await rpc(app, 'wiki.set', { path: 'acme.about', content: 'This is an about section' })
      await rpc(app, 'wiki.set', { path: 'acme.about.foo', content: 'This is all about foo' })
      await rpc(app, 'wiki.set', { path: 'acme.about.bar', content: 'This is all about bar' })
    }

    it('returns a tree with full paths', async () => {
      const { app } = await createTestApi()
      await seed(app)
      const tree = await rpc(app, 'wiki.tree', { path: 'acme' })
      tree.result.fullPath.should.equal('acme')
      tree.result.children[0].fullPath.should.equal('acme.about')
      tree.result.children[0].children.map((child) => child.fullPath)
        .should.deepEqual(['acme.about.bar', 'acme.about.foo'])
    })

    it('searches with full paths and excerpts', async () => {
      const { app } = await createTestApi()
      await seed(app)
      const found = await rpc(app, 'wiki.search', { path: 'acme', query: 'foo' })
      found.result.length.should.equal(1)
      found.result[0].fullPath.should.equal('acme.about.foo')
      found.result[0].excerpt.should.containEql('[foo]')
    })

    it('returns history', async () => {
      const { app } = await createTestApi()
      await seed(app)
      await rpc(app, 'wiki.set', { path: 'acme.about.foo', content: 'v2', message: 'edit' })
      const history = await rpc(app, 'wiki.history', { path: 'acme.about.foo' })
      history.result.length.should.equal(2)
      history.result[0].commit.message.should.equal('edit')
    })
  })

  describe('wiki.move / wiki.remove', () => {
    it('moves nodes and rejects cross-wiki moves', async () => {
      const { app } = await createTestApi()
      await rpc(app, 'wiki.set', { path: 'acme', content: 'root' })
      await rpc(app, 'wiki.set', { path: 'other', content: 'other root' })
      await rpc(app, 'wiki.set', { path: 'acme.a.b', content: 'b' })
      const moved = await rpc(app, 'wiki.move', { from: 'acme.a.b', to: 'acme.b' })
      moved.result.fullPath.should.equal('acme.b')
      const cross = await rpc(app, 'wiki.move', { from: 'acme.b', to: 'other.b' })
      cross.error.data.code.should.equal('CROSS_WIKI_MOVE')
    })

    it('removes nodes and maps non-empty errors', async () => {
      const { app } = await createTestApi()
      await rpc(app, 'wiki.set', { path: 'acme', content: 'root' })
      await rpc(app, 'wiki.set', { path: 'acme.a.b', content: 'b' })
      const nonEmpty = await rpc(app, 'wiki.remove', { path: 'acme.a' })
      nonEmpty.error.data.code.should.equal('NON_EMPTY_NODE')
      const removed = await rpc(app, 'wiki.remove', { path: 'acme.a', recursive: true })
      removed.result.deletedPaths.should.deepEqual(['acme.a', 'acme.a.b'])
    })
  })

  describe('wiki.snapshot', () => {
    it('returns historical snapshots', async () => {
      const { app } = await createTestApi()
      await rpc(app, 'wiki.set', { path: 'acme', content: 'root' })
      const doc = await rpc(app, 'wiki.set', { path: 'acme.doc', content: 'v1' })
      await rpc(app, 'wiki.set', { path: 'acme.later', content: 'later' })
      const snapshot = await rpc(app, 'wiki.snapshot', {
        wiki: 'acme', commitId: doc.result.node.commitId
      })
      snapshot.result.nodes.map((node) => node.fullPath).should.deepEqual(['acme', 'acme.doc'])
    })
  })

  describe('protocol', () => {
    it('rejects unknown methods', async () => {
      const { app } = await createTestApi()
      const body = await rpc(app, 'wiki.nope', {})
      body.error.code.should.equal(-32601)
    })

    it('rejects malformed requests', async () => {
      const { app } = await createTestApi()
      const response = await app.inject({
        method: 'POST',
        url: '/rpc',
        headers: { authorization: 'Bearer human-token' },
        payload: { method: 'wiki.get' }
      })
      response.json().error.code.should.equal(-32600)
    })

    it('answers CORS preflight', async () => {
      const { app } = await createTestApi()
      const response = await app.inject({ method: 'OPTIONS', url: '/rpc' })
      response.statusCode.should.equal(204)
      response.headers['access-control-allow-origin'].should.equal('*')
    })
  })
})
