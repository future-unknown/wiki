import should from 'should'
import { once } from 'node:events'
import express from 'express'
import Database from 'better-sqlite3'
import { createWikiKit } from '../lib/kit/index.js'
import { createWikiRouter, createStaticTokenAuth, openRecordStore } from '../lib/api/index.js'
import { startDynoxide, uniqueTable } from './dynoxide.js'
import {
  WikiClient,
  NotFoundError,
  RevisionConflictError,
  UnauthenticatedError,
  NetworkError,
  RpcError
} from '../lib/sdk/index.js'

/**
 * Run the SDK against a real API served over a real socket so the
 * whole fetch path is exercised.
 */
let dynoxide

before(async () => {
  dynoxide = await startDynoxide()
})

after(() => {
  dynoxide.stop()
})

async function createServer () {
  const db = new Database(':memory:')
  const records = openRecordStore({ endpoint: dynoxide.endpoint, table: uniqueTable() })
  const kit = createWikiKit({ db, records })
  await kit.migrate()
  const auth = createStaticTokenAuth({
    tokens: { 'test-token': { actor: { type: 'agent', id: 'sdk_test', onBehalfOf: null } } }
  })
  const app = express()
  app.use(createWikiRouter({ kit, auth }))
  const server = app.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const { port } = server.address()
  return { server, baseUrl: `http://127.0.0.1:${port}` }
}

describe('wiki-sdk', () => {
  let server
  let client

  beforeEach(async () => {
    server = await createServer()
    client = new WikiClient({ baseUrl: server.baseUrl, token: 'test-token' })
  })

  afterEach(async () => {
    server.server.close()
  })

  it('round-trips the core workflow', async () => {
    const created = await client.set('acme', { content: 'This is the acme wiki' })
    created.created.should.be.true()
    await client.set('acme.about.foo', { content: '# Foo', title: 'Foo' })

    const foo = await client.get('acme.about.foo')
    foo.content.should.equal('# Foo')
    foo.title.should.equal('Foo')
    foo.fullPath.should.equal('acme.about.foo')

    const tree = await client.tree('acme')
    tree.children[0].fullPath.should.equal('acme.about')

    const results = await client.search('acme', 'foo')
    results[0].fullPath.should.equal('acme.about.foo')

    const history = await client.history('acme.about.foo')
    history.length.should.equal(1)

    const log = await client.log('acme', { limit: 1 })
    log.length.should.equal(1)
    log[0].changes.map((change) => change.fullPath).should.containEql('acme.about.foo')

    const moved = await client.move('acme.about.foo', 'acme.foo')
    moved.fullPath.should.equal('acme.foo')

    const removed = await client.remove('acme.about')
    removed.deletedPaths.should.deepEqual(['acme.about'])

    const snapshot = await client.snapshot('acme', { commitId: foo.commitId })
    snapshot.nodes.map((node) => node.fullPath).should.containEql('acme.about.foo')

    const commit = await client.getCommit('acme', foo.commitId)
    commit.actor.id.should.equal('sdk_test')

    const wikis = await client.list()
    wikis.map((wiki) => wiki.slug).should.deepEqual(['acme'])

    const note = await client.note('acme.foo', 'needs work')
    const notes = await client.notes('acme.foo')
    notes.map((entry) => entry.body).should.deepEqual(['needs work'])
    const done = await client.resolveNote('acme.foo', note.id)
    done.resolvedBy.id.should.equal('sdk_test')
    ;(await client.notes('acme.foo')).length.should.equal(0)

    const put = await client.put('acme.foo', { requests: 7 }, { ts: '2026-01-01T00:00:00Z' })
    put.fullPath.should.equal('acme.foo')
    await client.put('acme.foo', { requests: 9 })
    const data = await client.data('acme.foo', { since: '2026-01-01T00:00:00Z' })
    data.records.map((record) => record.requests).should.deepEqual([7, 9])
    const latest = await client.data('acme.foo', { latest: true })
    latest.records[0].requests.should.equal(9)
    const deleted = await client.del('acme.foo', latest.records[0]._id)
    deleted.record.requests.should.equal(9)

    const meta = await client.meta('acme.foo', { retain: { days: 30 } })
    meta.changed.should.be.true()
    meta.node.metadata.retain.should.deepEqual({ days: 30 })
  })

  it('supports optimistic concurrency through expectedRevisionId', async () => {
    await client.set('acme', { content: 'root' })
    const first = await client.set('acme.doc', { content: 'v1' })
    await client.set('acme.doc', {
      content: 'v2', expectedRevisionId: first.node.revisionId
    })
    await client.set('acme.doc', { content: 'v3', expectedRevisionId: first.node.revisionId })
      .should.be.rejectedWith(RevisionConflictError)
  })

  it('maps API errors to typed classes', async () => {
    await client.get('acme.missing').should.be.rejectedWith(NotFoundError)
    const anonymous = new WikiClient({ baseUrl: server.baseUrl })
    await anonymous.get('acme').should.be.rejectedWith(UnauthenticatedError)
  })

  it('exposes rpc protocol failures as RpcError', async () => {
    const raw = await client.rpc('wiki.get', { path: 'acme' }).catch((error) => error)
    raw.should.be.instanceOf(NotFoundError) // sanity: domain error, not RpcError
    await client.rpc('wiki.nope', {}).should.be.rejectedWith(RpcError)
  })

  it('supports an injected fetch', async () => {
    let seen = null
    const spyFetch = async (url, options) => {
      seen = { url, options }
      return {
        status: 200,
        json: async () => ({ jsonrpc: '2.0', id: 1, result: { ok: true } })
      }
    }
    const spied = new WikiClient({ baseUrl: 'http://example.test', token: 'tok', fetch: spyFetch })
    const result = await spied.get('acme')
    result.ok.should.be.true()
    seen.url.should.equal('http://example.test/rpc')
    seen.options.headers.authorization.should.equal('Bearer tok')
    JSON.parse(seen.options.body).method.should.equal('wiki.get')
  })

  it('wraps connection failures in NetworkError', async () => {
    const dead = new WikiClient({ baseUrl: 'http://127.0.0.1:1', token: 'x' })
    await dead.get('acme').should.be.rejectedWith(NetworkError)
  })
})
