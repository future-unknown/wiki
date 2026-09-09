/**
 * wiki/store — the consumer's state for one wiki: a zustand vanilla
 * store over an RPC client, the pattern loom keeps for its own wiki
 * view, extracted so every consumer — a static page on the public host,
 * the known.vision front-end, a third-party app — holds the same shape.
 *
 * The store owns the tree, the addressed page, its records, its
 * history, and a search — each with a status and an error — and the
 * mechanics of a load: status transitions and stale-response
 * protection. It owns nothing else: no cache, no TTL, no retry. A
 * consumer that needs those adds them outside.
 *
 * The client is methodry-shaped: `rpc.wiki.get(params)` and friends,
 * returning either a plain value or a result `{ response, refused }`.
 * A refusal becomes an error on the store; the exceptional throws.
 * Built from discovery when a document is given: a method the host
 * does not serve is refused here, before a request, and a page's
 * declarations (key, schema) read off the document.
 */

import { createStore } from 'zustand/vanilla'

const DATA_PAGE_SIZE = 500
const HISTORY_LIMIT = 50
const SEARCH_LIMIT = 50

const FALLBACK = {
  tree: 'Unable to load the wiki.',
  page: 'Unable to load this page.',
  data: 'Unable to load records.',
  history: 'Unable to load history.',
  search: 'Unable to search.'
}

/**
 * Fetch a public wiki's discovery document from the host that serves
 * it: `<baseUrl>/rpc/<wiki>`. The document names the transport, the
 * methods served, and the wiki's declared pages.
 */
export async function discover ({ baseUrl, wiki, fetch: fetchImpl = globalThis.fetch } = {}) {
  if (!baseUrl) throw new Error('discover requires baseUrl')
  if (!wiki) throw new Error('discover requires wiki')
  const response = await fetchImpl(`${String(baseUrl).replace(/\/+$/, '')}/rpc/${encodeURIComponent(wiki)}`)
  if (!response.ok) {
    throw new Error(response.status === 404 ? `no public wiki named ${wiki}` : `discovery failed with ${response.status}`)
  }
  return response.json()
}

/** The full path of a page: the wiki's slug, then the relative path. */
export function fullPathOf (wiki, relPath = '') {
  const rel = String(relPath ?? '')
  if (rel === '' || rel === wiki) return wiki
  if (rel.startsWith(wiki + '.')) return rel
  return `${wiki}.${rel}`
}

/** The pages that carry records, read off the tree. */
export function recordSummary (tree) {
  const entries = []
  const walk = (node) => {
    if (node?.records?.count > 0) {
      entries.push({ fullPath: node.fullPath, count: node.records.count, latestTs: node.records.latestTs ?? null })
    }
    for (const child of node?.children ?? []) walk(child)
  }
  if (tree) walk(tree)
  return entries
}

/** A page's declarations (key, schema, retain, records) from discovery, or null. */
export function declarationsOf (state, relPath = state.pagePath ?? '') {
  return state.discovery?.pages?.[fullPathOf(state.wiki, relPath)] ?? null
}

export function createWikiStore ({ rpc, wiki, discovery = null, pageSize = DATA_PAGE_SIZE } = {}) {
  if (!rpc?.wiki) throw new Error('createWikiStore requires an rpc client with a wiki namespace')
  if (typeof wiki !== 'string' || wiki === '') throw new Error('createWikiStore requires the wiki slug')

  // One request to the host, with a refusal turned into a thrown error
  // so every loader records it the same way.
  async function call (method, params) {
    if (discovery?.methods && !(method in discovery.methods)) {
      throw new Error(`${method} is not served by this host`)
    }
    const verb = method.slice('wiki.'.length)
    return unwrap(await rpc.wiki[verb](params))
  }

  const initial = {
    wiki,
    discovery,
    tree: null,
    treeStatus: 'idle',
    treeError: null,
    pagePath: null,
    page: null,
    pageStatus: 'idle',
    pageError: null,
    data: [],
    dataCursor: null,
    dataReverse: false,
    dataStatus: 'idle',
    dataError: null,
    history: [],
    historyStatus: 'idle',
    historyError: null,
    query: '',
    results: [],
    searchStatus: 'idle',
    searchError: null
  }

  const generations = { tree: 0, page: 0, data: 0, history: 0, search: 0 }

  return createStore((set, get) => ({
    ...initial,

    reset () {
      for (const key of Object.keys(generations)) generations[key] += 1
      set({ ...initial, discovery: get().discovery })
    },

    // The whole tree. A background reload keeps what is shown until the
    // answer lands; a first load says it is loading.
    async loadTree ({ background = false } = {}) {
      const current = ++generations.tree
      if (!background || !get().tree) set({ treeStatus: 'loading', treeError: null })
      else set({ treeError: null })
      try {
        const tree = await call('wiki.tree', { path: wiki })
        if (current !== generations.tree) return
        set({ tree, treeStatus: 'loaded', treeError: null })
      } catch (error) {
        if (current !== generations.tree) return
        set({ treeStatus: get().tree ? 'loaded' : 'error', treeError: messageOf(error, FALLBACK.tree) })
      }
    },

    // Address a page and read it. Addressing a different page clears the
    // one shown; a background reload of the same page keeps it.
    async loadPage (relPath, { background = false } = {}) {
      const path = String(relPath ?? '')
      const current = ++generations.page
      const samePage = get().pagePath === path && get().page
      if (!background || !samePage) {
        if (samePage) set({ pagePath: path, pageError: null })
        else set({ pagePath: path, page: null, pageStatus: 'loading', pageError: null })
      }
      try {
        const page = await call('wiki.get', { path: fullPathOf(wiki, path) })
        if (current !== generations.page || get().pagePath !== path) return
        set({ page, pageStatus: 'loaded', pageError: null })
      } catch (error) {
        if (current !== generations.page || get().pagePath !== path) return
        set({ pageStatus: 'error', pageError: messageOf(error, FALLBACK.page) })
      }
    },

    // The addressed page's records: the first fetch, in the order asked
    // (`reverse` reads a log newest first). A background reload refetches
    // as many as are shown, in the same order.
    async loadData (relPath = get().pagePath ?? '', { limit, reverse, background = false } = {}) {
      const path = String(relPath ?? '')
      const current = ++generations.data
      const shown = get().pagePath === path ? get().data.length : 0
      const size = limit ?? (background ? Math.max(pageSize, shown) : pageSize)
      const order = reverse ?? (background ? get().dataReverse : false)
      if (!background) set({ pagePath: get().pagePath ?? path, data: [], dataCursor: null, dataReverse: order, dataStatus: 'loading', dataError: null })
      try {
        const result = await call('wiki.data', { path: fullPathOf(wiki, path), limit: size, reverse: order })
        if (current !== generations.data) return
        set({ data: result.records ?? [], dataCursor: result.cursor ?? null, dataReverse: order, dataStatus: 'loaded', dataError: null })
      } catch (error) {
        if (current !== generations.data) return
        set({ dataStatus: 'error', dataError: messageOf(error, FALLBACK.data) })
      }
    },

    // The next fetch of records, appended. Nothing without a cursor; a
    // reload that lands meanwhile wins, so the list never doubles up.
    async loadMoreData () {
      const { pagePath: path, dataCursor: cursor, dataReverse: reverse } = get()
      if (path === null || !cursor) return
      const current = ++generations.data
      try {
        const result = await call('wiki.data', { path: fullPathOf(wiki, path), limit: pageSize, reverse, cursor })
        if (current !== generations.data || get().pagePath !== path) return
        set({ data: [...get().data, ...(result.records ?? [])], dataCursor: result.cursor ?? null })
      } catch (error) {
        if (current !== generations.data || get().pagePath !== path) return
        set({ dataError: messageOf(error, FALLBACK.data) })
      }
    },

    async loadHistory (relPath = get().pagePath ?? '', { limit = HISTORY_LIMIT, background = false } = {}) {
      const path = String(relPath ?? '')
      const current = ++generations.history
      if (!background) set({ history: [], historyStatus: 'loading', historyError: null })
      try {
        const history = await call('wiki.history', { path: fullPathOf(wiki, path), limit })
        if (current !== generations.history) return
        set({ history, historyStatus: 'loaded', historyError: null })
      } catch (error) {
        if (current !== generations.history) return
        set({ historyStatus: 'error', historyError: messageOf(error, FALLBACK.history) })
      }
    },

    async search (query, { limit = SEARCH_LIMIT } = {}) {
      const text = String(query ?? '').trim()
      const current = ++generations.search
      if (text === '') {
        set({ query: '', results: [], searchStatus: 'idle', searchError: null })
        return
      }
      set({ query: text, searchStatus: 'loading', searchError: null })
      try {
        const results = await call('wiki.search', { path: wiki, query: text, limit })
        if (current !== generations.search) return
        set({ results, searchStatus: 'loaded', searchError: null })
      } catch (error) {
        if (current !== generations.search) return
        set({ searchStatus: 'error', searchError: messageOf(error, FALLBACK.search) })
      }
    },

    // Write a record. Refusals (a schema the value fails, a version that
    // moved) throw, as the caller is the one to answer them. The shown
    // records follow in the background when the page is the addressed one.
    async put (relPath, value, { ts, ifVersion } = {}) {
      const path = String(relPath ?? '')
      const result = await call('wiki.put', { path: fullPathOf(wiki, path), value, ...(ts !== undefined ? { ts } : {}), ...(ifVersion !== undefined ? { ifVersion } : {}) })
      if (get().pagePath === path) void get().loadData(path, { background: true })
      return result.record
    },

    async del (relPath, key) {
      const path = String(relPath ?? '')
      const result = await call('wiki.del', { path: fullPathOf(wiki, path), key })
      if (get().pagePath === path) void get().loadData(path, { background: true })
      return result.record
    },

    // Everything shown, again, without a flash: the tree, the addressed
    // page and its records. For a consumer polling in place of watch.
    async refresh () {
      const { pagePath } = get()
      await Promise.all([
        get().loadTree({ background: true }),
        pagePath === null ? null : get().loadPage(pagePath, { background: true }),
        pagePath === null ? null : get().loadData(pagePath, { background: true })
      ])
    }
  }))
}

// A methodry result carries `response` and `refused`; a plain client
// returns the value. Either way the value comes out and a refusal
// throws with the refusal attached.
function unwrap (result) {
  if (result && typeof result === 'object' && 'refused' in result && 'response' in result) {
    if (result.refused) {
      const error = new Error(result.refused.message || 'refused')
      error.refused = result.refused
      throw error
    }
    return result.response
  }
  return result
}

function messageOf (error, fallback) {
  return error?.refused?.message || error?.message || fallback
}
