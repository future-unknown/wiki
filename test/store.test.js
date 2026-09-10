import should from 'should'
import Database from 'better-sqlite3'
import { createWikiKit, WikiError } from '../lib/kit/index.js'
import { createWikiMethods, openRecordStore } from '../lib/api/index.js'
import { createWikiStore, discover, declarationsOf, fullPathOf, recordSummary } from '../lib/store/index.js'
import { startDynoxide, uniqueTable } from './dynoxide.js'

/**
 * The store against the real method table: a methodry-shaped client
 * whose calls land on createWikiMethods, refusals returned as results
 * the way methodry returns them.
 */
let dynoxide

before(async () => {
  dynoxide = await startDynoxide()
})

after(() => {
  dynoxide.stop()
})

const PRINCIPAL = { actor: { type: 'human', id: 'ada', onBehalfOf: null } }

// A background refresh lands when it lands: wait for the state to say
// so, bounded, rather than guessing a sleep.
async function until (check, { timeout = 3000 } = {}) {
  const deadline = Date.now() + timeout
  while (!check()) {
    if (Date.now() > deadline) throw new Error('condition not met in time')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

async function seeded () {
  const db = new Database(':memory:')
  const kit = createWikiKit({ db, records: openRecordStore({ endpoint: dynoxide.endpoint, table: uniqueTable() }) })
  await kit.migrate()
  const methods = createWikiMethods({ kit })
  await methods['wiki.set'](PRINCIPAL, { path: 'acme_labs', title: 'Labs', content: 'Root.' })
  await methods['wiki.set'](PRINCIPAL, { path: 'acme_labs.tasks', content: 'Tasks.', metadata: { key: 'id' } })
  await methods['wiki.set'](PRINCIPAL, { path: 'acme_labs.tasks', content: 'Tasks, again.' })
  await methods['wiki.set'](PRINCIPAL, { path: 'acme_labs.log', content: 'Log.' })
  for (let i = 1; i <= 7; i++) {
    await methods['wiki.put'](PRINCIPAL, { path: 'acme_labs.log', value: { n: i }, ts: `2026-01-0${i}T00:00:00Z` })
  }
  const calls = []
  const rpc = {
    wiki: new Proxy({}, {
      get: (_, verb) => async (params) => {
        calls.push([`wiki.${verb}`, params])
        try {
          return { response: await methods[`wiki.${verb}`](PRINCIPAL, params), refused: null }
        } catch (error) {
          if (error instanceof WikiError) return { response: null, refused: { message: error.message, fields: error.details } }
          throw error
        }
      }
    })
  }
  return { rpc, calls, methods }
}

describe('wiki/store', () => {
  it('loads the tree, a page, its records, and its history, each with a status', async () => {
    const { rpc } = await seeded()
    const store = createWikiStore({ rpc, wiki: 'acme_labs' })
    store.getState().treeStatus.should.equal('idle')

    await store.getState().loadTree()
    const state = store.getState()
    state.treeStatus.should.equal('loaded')
    state.tree.children.map((child) => child.slug).should.deepEqual(['log', 'tasks'])
    recordSummary(state.tree).should.deepEqual([{ fullPath: 'acme_labs.log', count: 7, latestTs: '2026-01-07T00:00:00.000Z' }])

    await store.getState().loadPage('tasks')
    store.getState().page.content.should.equal('Tasks, again.')
    store.getState().pagePath.should.equal('tasks')

    await store.getState().loadHistory('tasks')
    store.getState().history.length.should.equal(2)

    await store.getState().loadData('log', { limit: 3, reverse: true })
    store.getState().data.map((record) => record.n).should.deepEqual([7, 6, 5])
    should(store.getState().dataCursor).be.ok()
  })

  it('pages records forward with the cursor and drops a fetch a newer one supersedes', async () => {
    const { rpc } = await seeded()
    const store = createWikiStore({ rpc, wiki: 'acme_labs', pageSize: 3 })
    await store.getState().loadPage('log')
    await store.getState().loadData('log')
    store.getState().data.map((record) => record.n).should.deepEqual([1, 2, 3])
    await store.getState().loadMoreData()
    store.getState().data.map((record) => record.n).should.deepEqual([1, 2, 3, 4, 5, 6])
    await store.getState().loadMoreData()
    store.getState().data.map((record) => record.n).should.deepEqual([1, 2, 3, 4, 5, 6, 7])
    should(store.getState().dataCursor).equal(null)
    // nothing more: a no-op
    await store.getState().loadMoreData()
    store.getState().data.length.should.equal(7)

    // a reload racing a continuation: the reload wins, no doubling
    await store.getState().loadData('log')
    const more = store.getState().loadMoreData()
    const reload = store.getState().loadData('log', { background: true })
    await Promise.all([more, reload])
    store.getState().data.map((record) => record.n).should.deepEqual([1, 2, 3])
  })

  it('records a refusal as the loader’s error and throws it from a write', async () => {
    const { rpc } = await seeded()
    const store = createWikiStore({ rpc, wiki: 'acme_labs' })
    await store.getState().loadPage('nope')
    store.getState().pageStatus.should.equal('error')
    store.getState().pageError.should.match(/not found/)

    await store.getState().put('log', { n: 8 }).should.be.fulfilled()
    await store.getState().put('log', 'not a record').should.be.rejectedWith(/value must be an object/)
    await store.getState().del('tasks', 'missing').should.be.rejectedWith(/not found/)
  })

  it('a write refreshes the addressed page’s records in the background', async () => {
    const { rpc } = await seeded()
    const store = createWikiStore({ rpc, wiki: 'acme_labs' })
    await store.getState().loadPage('tasks')
    await store.getState().loadData('tasks')
    store.getState().data.length.should.equal(0)
    const record = await store.getState().put('tasks', { id: 't1', title: 'Write the store' })
    record.id.should.equal('t1')
    record._actor.id.should.equal('ada')
    await until(() => store.getState().data.length === 1)
    store.getState().data.map((entry) => entry.id).should.deepEqual(['t1'])
    await store.getState().del('tasks', 't1')
    await until(() => store.getState().data.length === 0)
  })

  it('searches the wiki, and clears on an empty query', async () => {
    const { rpc } = await seeded()
    const store = createWikiStore({ rpc, wiki: 'acme_labs' })
    await store.getState().search('again')
    store.getState().results.map((hit) => hit.fullPath).should.deepEqual(['acme_labs.tasks'])
    await store.getState().search('  ')
    store.getState().searchStatus.should.equal('idle')
    store.getState().results.should.deepEqual([])
  })

  it('built from discovery: unserved methods are refused before a request, declarations read off the document', async () => {
    const { rpc, calls } = await seeded()
    const discovery = {
      methods: { 'wiki.get': {}, 'wiki.tree': {}, 'wiki.data': {} },
      pages: { 'acme_labs.tasks': { key: 'id', schema: { type: 'object' } } }
    }
    const store = createWikiStore({ rpc, wiki: 'acme_labs', discovery })
    await store.getState().loadPage('tasks')
    should(declarationsOf(store.getState())).deepEqual({ key: 'id', schema: { type: 'object' } })
    should(declarationsOf(store.getState(), 'log')).equal(null)
    await store.getState().put('tasks', { id: 'x' }).should.be.rejectedWith(/wiki.put is not served by this host/)
    await store.getState().loadHistory('tasks')
    store.getState().historyStatus.should.equal('error')
    store.getState().historyError.should.match(/not served/)
    calls.map(([name]) => name).should.deepEqual(['wiki.get'])
  })

  it('refresh reloads what is shown without a flash', async () => {
    const { rpc, methods } = await seeded()
    const store = createWikiStore({ rpc, wiki: 'acme_labs' })
    await store.getState().loadTree()
    await store.getState().loadPage('tasks')
    await store.getState().loadData('tasks')
    await methods['wiki.set'](PRINCIPAL, { path: 'acme_labs.tasks', content: 'Tasks, thrice.' })
    const statuses = []
    const unsubscribe = store.subscribe((state) => statuses.push(state.pageStatus))
    await store.getState().refresh()
    unsubscribe()
    statuses.should.not.containEql('loading')
    store.getState().page.content.should.equal('Tasks, thrice.')
  })

  it('discover fetches the wiki document from the host, and says when there is none', async () => {
    const fetch = async (url, options) => {
      url.should.equal('https://rpc.example.test/rpc/acme_labs')
      options.headers.accept.should.equal('application/json')
      return { ok: true, json: async () => ({ wiki: { slug: 'acme_labs' }, methods: {}, pages: {} }) }
    }
    const document = await discover({ baseUrl: 'https://rpc.example.test/', wiki: 'acme_labs', fetch })
    document.wiki.slug.should.equal('acme_labs')
    await discover({ baseUrl: 'https://rpc.example.test', wiki: 'acme_nope', fetch: async () => ({ ok: false, status: 404 }) })
      .should.be.rejectedWith(/no public wiki named acme_nope/)
  })

  it('fullPathOf accepts relative and full paths alike', () => {
    fullPathOf('acme_labs', '').should.equal('acme_labs')
    fullPathOf('acme_labs', 'docs.intro').should.equal('acme_labs.docs.intro')
    fullPathOf('acme_labs', 'acme_labs.docs').should.equal('acme_labs.docs')
    fullPathOf('acme_labs', 'acme_labs').should.equal('acme_labs')
  })
})
