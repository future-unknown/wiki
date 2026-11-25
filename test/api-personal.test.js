import should from 'should'
import { once } from 'node:events'
import express from 'express'
import Database from 'better-sqlite3'
import { createWikiKit } from '../lib/kit/index.js'
import { createWikiRouter, createStaticTokenAuth, openRecordStore } from '../lib/api/index.js'
import { startDynoxide, uniqueTable } from './dynoxide.js'

describe('wiki-api: personal tables', () => {
  const servers = []
  let dynoxide

  before(async () => {
    dynoxide = await startDynoxide()
  })

  after(() => {
    dynoxide.stop()
  })

  afterEach(() => {
    while (servers.length > 0) servers.pop().close()
  })

  // dana and eli are people; the site acts for dana; the admin may see
  // everyone's rows.
  async function createApi () {
    const db = new Database(':memory:')
    const kit = createWikiKit({ db, records: openRecordStore({ endpoint: dynoxide.endpoint, table: uniqueTable() }) })
    await kit.migrate()
    const auth = createStaticTokenAuth({
      tokens: {
        admin: { actor: { type: 'human', id: 'user_admin', onBehalfOf: null }, everyone: true },
        dana: { actor: { type: 'human', id: 'user_dana', onBehalfOf: null } },
        eli: { actor: { type: 'human', id: 'user_eli', onBehalfOf: null } },
        site: { actor: { type: 'agent', id: 'app_portal', onBehalfOf: 'user_dana' } }
      }
    })
    const app = express()
    app.use(createWikiRouter({ kit, auth }))
    const server = app.listen(0, '127.0.0.1')
    await once(server, 'listening')
    servers.push(server)
    const baseUrl = `http://127.0.0.1:${server.address().port}`
    async function rpc (method, params, token) {
      const response = await fetch(`${baseUrl}/rpc`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
      })
      return response.json()
    }
    await rpc('wiki.write', { path: 'acme:', content: 'root' }, 'admin')
    await rpc('wiki.write', { path: 'acme:progress', content: '', metadata: { key: 'id', personal: true } }, 'admin')
    await rpc('wiki.write', { path: 'acme:lessons', content: '', metadata: { key: 'id' } }, 'admin')
    return { rpc, kit }
  }

  const owners = (body) => body.result.records.map((record) => [record._owner, record._id])

  it('writes a row as the caller\'s own, whoever asks', async () => {
    const { rpc } = await createApi()
    const written = await rpc('wiki.set', { path: 'acme:progress', value: { id: 'l1', done: true } }, 'dana')
    written.result.record._owner.should.equal('user_dana')
    written.result.rows.should.deepEqual({ of: 'person', person: 'user_dana' })
    const admins = await rpc('wiki.set', { path: 'acme:progress', value: { id: 'l1', done: false } }, 'admin')
    admins.result.record._owner.should.equal('user_admin')
  })

  it('takes no person on a write', async () => {
    const { rpc } = await createApi()
    const body = await rpc('wiki.set', { path: 'acme:progress', value: { id: 'l1' }, person: 'user_eli' }, 'dana')
    body.error.message.should.match(/always written as your own row/)
  })

  it('files a site\'s write under the person it acts for', async () => {
    const { rpc } = await createApi()
    await rpc('wiki.set', { path: 'acme:progress', value: { id: 'l1' } }, 'site')
    const mine = await rpc('wiki.records', { path: 'acme:progress' }, 'dana')
    owners(mine).should.deepEqual([['user_dana', 'l1']])
  })

  it('gives a person their own rows and an admin everyone\'s', async () => {
    const { rpc } = await createApi()
    await rpc('wiki.set', { path: 'acme:progress', value: { id: 'l1' } }, 'dana')
    await rpc('wiki.set', { path: 'acme:progress', value: { id: 'l1' } }, 'eli')
    await rpc('wiki.set', { path: 'acme:progress', value: { id: 'l2' } }, 'eli')

    const danas = await rpc('wiki.records', { path: 'acme:progress' }, 'dana')
    owners(danas).should.deepEqual([['user_dana', 'l1']])
    danas.result.rows.should.deepEqual({ of: 'person', person: 'user_dana' })

    const all = await rpc('wiki.records', { path: 'acme:progress' }, 'admin')
    owners(all).should.deepEqual([['user_dana', 'l1'], ['user_eli', 'l1'], ['user_eli', 'l2']])
    all.result.rows.should.deepEqual({ of: 'everyone' })
  })

  it('narrows an admin\'s read to one person, or to their own', async () => {
    const { rpc } = await createApi()
    await rpc('wiki.set', { path: 'acme:progress', value: { id: 'l1' } }, 'dana')
    await rpc('wiki.set', { path: 'acme:progress', value: { id: 'l9' } }, 'admin')
    const one = await rpc('wiki.records', { path: 'acme:progress', person: 'user_dana' }, 'admin')
    owners(one).should.deepEqual([['user_dana', 'l1']])
    const mine = await rpc('wiki.records', { path: 'acme:progress', mine: true }, 'admin')
    owners(mine).should.deepEqual([['user_admin', 'l9']])
  })

  it('refuses another person\'s rows to anyone but an admin', async () => {
    const { rpc } = await createApi()
    await rpc('wiki.set', { path: 'acme:progress', value: { id: 'l1' } }, 'dana')
    for (const [method, params] of [
      ['wiki.records', {}],
      ['wiki.get', { key: 'l1' }],
      ['wiki.del', { key: 'l1' }],
      ['wiki.history', { key: 'l1' }],
      ['wiki.getVersion', { key: 'l1', version: 1 }]
    ]) {
      const body = await rpc(method, { path: 'acme:progress', person: 'user_dana', ...params }, 'eli')
      should(body.error?.data?.code).equal('UNAUTHORIZED', method)
    }
    const still = await rpc('wiki.get', { path: 'acme:progress', key: 'l1' }, 'dana')
    still.result.record._id.should.equal('l1')
  })

  it('lets a person name themselves', async () => {
    const { rpc } = await createApi()
    await rpc('wiki.set', { path: 'acme:progress', value: { id: 'l1' } }, 'dana')
    const body = await rpc('wiki.records', { path: 'acme:progress', person: 'user_dana' }, 'dana')
    owners(body).should.deepEqual([['user_dana', 'l1']])
  })

  it('reads and deletes one row as the caller\'s own unless an admin names a person', async () => {
    const { rpc } = await createApi()
    await rpc('wiki.set', { path: 'acme:progress', value: { id: 'l1', n: 1 } }, 'dana')
    const none = await rpc('wiki.get', { path: 'acme:progress', key: 'l1' }, 'admin')
    none.error.data.code.should.equal('NOT_FOUND')
    const hers = await rpc('wiki.get', { path: 'acme:progress', key: 'l1', person: 'user_dana' }, 'admin')
    hers.result.record.n.should.equal(1)
    const history = await rpc('wiki.history', { path: 'acme:progress', key: 'l1', person: 'user_dana' }, 'admin')
    history.result.versions.length.should.equal(1)
    const gone = await rpc('wiki.del', { path: 'acme:progress', key: 'l1', person: 'user_dana' }, 'admin')
    gone.result.record._owner.should.equal('user_dana')
    const after = await rpc('wiki.records', { path: 'acme:progress' }, 'dana')
    after.result.records.should.deepEqual([])
  })

  it('reads a moment and the latest as one person\'s, an admin\'s own when they name nobody', async () => {
    const { rpc } = await createApi()
    await rpc('wiki.set', { path: 'acme:progress', value: { id: 'l1' } }, 'dana')
    const at = new Date().toISOString()
    const own = await rpc('wiki.records', { path: 'acme:progress', at }, 'admin')
    own.result.rows.should.deepEqual({ of: 'person', person: 'user_admin' })
    own.result.records.should.deepEqual([])
    const hers = await rpc('wiki.records', { path: 'acme:progress', at, person: 'user_dana' }, 'admin')
    hers.result.records.length.should.equal(1)
  })

  it('refuses person and mine on a shared table', async () => {
    const { rpc } = await createApi()
    await rpc('wiki.set', { path: 'acme:lessons', value: { id: 'l1' } }, 'admin')
    const person = await rpc('wiki.records', { path: 'acme:lessons', person: 'user_dana' }, 'admin')
    person.error.message.should.match(/apply to a personal table/)
    const mine = await rpc('wiki.records', { path: 'acme:lessons', mine: true }, 'dana')
    mine.error.message.should.match(/apply to a personal table/)
    const plain = await rpc('wiki.records', { path: 'acme:lessons' }, 'dana')
    plain.result.records.length.should.equal(1)
    should(plain.result.rows).be.undefined()
  })

  it('lists the people a table holds rows for to an admin alone', async () => {
    const { rpc } = await createApi()
    await rpc('wiki.set', { path: 'acme:progress', value: { id: 'l1' } }, 'dana')
    await rpc('wiki.set', { path: 'acme:progress', value: { id: 'l1' } }, 'eli')
    const listed = await rpc('wiki.recordOwners', { path: 'acme:progress' }, 'admin')
    listed.result.total.should.equal(2)
    listed.result.owners.map((entry) => entry.owner).should.deepEqual(['user_dana', 'user_eli'])
    const refused = await rpc('wiki.recordOwners', { path: 'acme:progress' }, 'dana')
    refused.error.data.code.should.equal('UNAUTHORIZED')
  })

  it('searches and counts a person\'s own rows, and everyone\'s for an admin', async () => {
    const { rpc } = await createApi()
    await rpc('wiki.set', { path: 'acme:progress', value: { id: 'l1', note: 'saffron' } }, 'dana')
    await rpc('wiki.set', { path: 'acme:progress', value: { id: 'l1', note: 'saffron' } }, 'eli')
    const found = async (token) => (await rpc('wiki.search', { path: 'acme:', query: 'saffron' }, token))
      .result.filter((hit) => hit.kind === 'record').map((hit) => hit.owner).sort()
    ;(await found('dana')).should.deepEqual(['user_dana'])
    ;(await found('site')).should.deepEqual(['user_dana'])
    ;(await found('admin')).should.deepEqual(['user_dana', 'user_eli'])

    const count = async (token) => (await rpc('wiki.tree', { path: 'acme:progress' }, token)).result.records?.count ?? null
    ;(await count('dana')).should.equal(1)
    ;(await count('admin')).should.equal(2)
  })
})
