import should from 'should'
import { createHash } from 'node:crypto'
import { PREVIEW_TOKEN_MESSAGE, createSessionStore, methodryAuth, previewOfPage, scopeFor, wikisOf } from '../lib/session/index.js'

/**
 * wiki/session against a stand-in for Known's sign-in: an authorize
 * page that issues codes for a PKCE challenge, and a token endpoint
 * that swaps them, rotates refresh tokens, and ends a sign-in whose
 * spent refresh token comes back — the rules knapi keeps.
 */

const CLIENT = 'app_capital'
const REDIRECT = 'https://capital.example/'
const ENDPOINTS = { authorize: 'https://known.example/authorize', token: 'https://rpc.known.example/oauth/token', revoke: 'https://rpc.known.example/oauth/revoke' }

function memoryStorage () {
  const map = new Map()
  return { map, getItem: (key) => (map.has(key) ? map.get(key) : null), setItem: (key, value) => map.set(key, String(value)), removeItem: (key) => map.delete(key) }
}

function fakeKnown ({ ttl = 3600 } = {}) {
  const codes = new Map()
  const live = new Map() // family → current refresh token
  const calls = []
  let serial = 0
  let down = false

  function authorize (url) {
    const params = new URL(url).searchParams
    const code = `code${++serial}`
    codes.set(code, { challenge: params.get('code_challenge'), redirectUri: params.get('redirect_uri'), scope: params.get('scope') })
    return { code, state: params.get('state'), params }
  }

  function issue (family, scope) {
    const refresh = `krt.${family}.${++serial}`
    live.set(family, refresh)
    return { access_token: `at${serial}`, token_type: 'Bearer', expires_in: ttl, refresh_token: refresh, scope }
  }

  async function fetch (url, init) {
    const body = Object.fromEntries(new URLSearchParams(init.body))
    calls.push({ url, body })
    if (down) throw new TypeError('fetch failed')
    const answer = (status, value) => ({ ok: status < 300, status, text: async () => (value ? JSON.stringify(value) : '') })
    if (url === ENDPOINTS.revoke) {
      live.delete(String(body.token).split('.')[1])
      return answer(200)
    }
    if (body.grant_type === 'authorization_code') {
      const code = codes.get(body.code)
      codes.delete(body.code)
      if (!code) return answer(400, { error: 'invalid_grant', error_description: 'the code is unknown or has expired' })
      const challenge = createHash('sha256').update(body.code_verifier).digest('base64url')
      if (challenge !== code.challenge || body.redirect_uri !== code.redirectUri || body.client_id !== CLIENT) {
        return answer(400, { error: 'invalid_grant', error_description: 'code_verifier does not match the code_challenge' })
      }
      return answer(200, issue(`f${++serial}`, code.scope))
    }
    if (body.grant_type === 'refresh_token') {
      const family = String(body.refresh_token).split('.')[1]
      if (!live.has(family)) return answer(400, { error: 'invalid_grant', error_description: 'the refresh token is unknown or has expired' })
      if (live.get(family) !== body.refresh_token) {
        live.delete(family)
        return answer(400, { error: 'invalid_grant', error_description: 'this refresh token was already used; sign in again' })
      }
      return answer(200, issue(family, 'wiki:acme_deals:read'))
    }
    return answer(400, { error: 'unsupported_grant_type' })
  }

  return { authorize, fetch, calls, live, goDown: (value = true) => { down = value } }
}

// One browser: shared storage, one lock manager; each `tab()` is a page
// with its own address, history and events.
function browser (known) {
  const storage = memoryStorage()
  const pending = memoryStorage()
  let clock = 1_000_000
  let chain = Promise.resolve()
  const locks = { request: (name, work) => { const run = chain.then(() => work()); chain = run.catch(() => {}); return run } }

  function tab ({ href = REDIRECT, withLocks = true } = {}) {
    const events = new EventTarget()
    const location = { href, assigned: null, assign (url) { this.assigned = url } }
    const history = { state: null, replaceState (state, title, url) { location.href = url } }
    const session = createSessionStore({
      clientId: CLIENT,
      redirectUri: REDIRECT,
      scope: scopeFor('acme_deals'),
      signIn: ENDPOINTS,
      storage,
      pendingStorage: pending,
      fetch: known.fetch,
      location,
      history,
      locks: withLocks ? locks : null,
      events,
      now: () => clock
    })
    return { session, location, events, state: () => session.getState() }
  }

  return { tab, storage, pending, tick: (ms) => { clock += ms } }
}

// Sign in from a fresh tab and come back: the page Known sends back to.
async function signedInTab (known, b, { returnTo = '#/deals' } = {}) {
  const first = b.tab()
  await first.state().signIn({ returnTo })
  const { code, state } = known.authorize(first.location.assigned)
  const back = b.tab({ href: `${REDIRECT}?code=${code}&state=${state}` })
  const started = await back.state().start()
  return { tab: back, started }
}

describe('wiki/session', () => {
  it('scopes name wikis, and a granted scope names them back in either form', () => {
    scopeFor('acme_deals', ['acme_labs']).should.equal('wiki:acme_deals wiki:acme_labs')
    wikisOf('wiki:acme_deals wiki:acme_labs wiki:acme_deals').should.eql(['acme_deals', 'acme_labs'])
    // the form sites asked in before writes, which Known answers them in still
    wikisOf('wiki:acme_deals:read wiki:acme_labs:read').should.eql(['acme_deals', 'acme_labs'])
    wikisOf('wiki:acme_deals:write openid').should.eql([])
    wikisOf('').should.eql([])
  })

  it('starts signed out, sends the person to Known with a PKCE challenge, and keeps only a hash of the verifier in the address', async () => {
    const known = fakeKnown()
    const b = browser(known)
    const tab = b.tab()
    await tab.state().start()
    tab.state().status.should.equal('signed-out')

    await tab.state().signIn({ returnTo: '#/deals' })
    tab.state().status.should.equal('redirecting')
    const url = new URL(tab.location.assigned)
    url.origin.should.equal('https://known.example')
    Object.fromEntries(url.searchParams).should.containEql({ response_type: 'code', client_id: CLIENT, redirect_uri: REDIRECT, scope: 'wiki:acme_deals', code_challenge_method: 'S256' })
    url.searchParams.get('code_challenge').should.match(/^[A-Za-z0-9_-]{43}$/)
    const kept = JSON.parse(b.pending.map.get(`known.session.${CLIENT}.pending`))
    kept.returnTo.should.equal('#/deals')
    tab.location.assigned.should.not.containEql(kept.verifier)
  })

  it('swaps the code on return, cleans the address, and hands out a token that refreshes before it lapses', async () => {
    const known = fakeKnown()
    const b = browser(known)
    const { tab, started } = await signedInTab(known, b)
    started.should.eql({ returnTo: '#/deals' })
    tab.state().should.containEql({ status: 'signed-in', scope: 'wiki:acme_deals', wikis: ['acme_deals'], error: null })
    tab.location.href.should.equal(REDIRECT)
    Object.keys(tab.state()).should.not.containEql('accessToken')
    should(b.pending.map.size).equal(0)

    const first = await tab.state().getToken()
    first.should.match(/^at/)
    ;(await tab.state().getToken()).should.equal(first)
    b.tick(3600 * 1000 - 30 * 1000)
    const next = await tab.state().getToken()
    next.should.not.equal(first)
    known.calls.filter((call) => call.body.grant_type === 'refresh_token').length.should.equal(1)
  })

  it('resumes a kept sign-in on the next page load', async () => {
    const known = fakeKnown()
    const b = browser(known)
    await signedInTab(known, b)
    const reloaded = b.tab()
    ;(await reloaded.state().start()).should.eql({ returnTo: null })
    reloaded.state().status.should.equal('signed-in')
    should(await reloaded.state().getToken()).be.a.String()
  })

  it('refreshes one tab at a time, so two tabs never present the same refresh token', async () => {
    const known = fakeKnown()
    const b = browser(known)
    await signedInTab(known, b)
    const one = b.tab()
    const two = b.tab()
    await Promise.all([one.state().getToken({ force: true }), two.state().getToken({ force: true })])
    one.state().status.should.equal('signed-in')
    two.state().status.should.equal('signed-in')
    known.live.size.should.equal(1)
  })

  it('without locks, two tabs racing a refresh end the sign-in — which is why it takes one', async () => {
    const known = fakeKnown()
    const b = browser(known)
    await signedInTab(known, b)
    const one = b.tab({ withLocks: false })
    const two = b.tab({ withLocks: false })
    await Promise.all([one.state().getToken({ force: true }), two.state().getToken({ force: true })])
    ;[one.state().status, two.state().status].should.containEql('signed-out')
  })

  it('a refused return, a foreign state, and a spent refresh token all leave the person signed out', async () => {
    const known = fakeKnown()
    const b = browser(known)
    const first = b.tab()
    await first.state().signIn()
    const { state } = known.authorize(first.location.assigned)
    const denied = b.tab({ href: `${REDIRECT}?error=access_denied&error_description=no&state=${state}` })
    await denied.state().start()
    denied.state().status.should.equal('signed-out')
    denied.state().error.should.eql({ code: 'access_denied', message: 'no' })
    denied.location.href.should.equal(REDIRECT)

    const foreign = b.tab({ href: `${REDIRECT}?code=x&state=not-ours` })
    await foreign.state().start()
    foreign.state().status.should.equal('signed-out')
    known.calls.length.should.equal(0)

    const { tab } = await signedInTab(known, b)
    known.live.clear()
    should(await tab.state().getToken({ force: true })).be.null()
    tab.state().status.should.equal('signed-out')
    tab.state().error.code.should.equal('invalid_grant')
    should(b.storage.map.get(`known.session.${CLIENT}.refresh`)).be.undefined()
  })

  it('keeps a sign-in when Known cannot be reached, for a retry', async () => {
    const known = fakeKnown()
    const b = browser(known)
    await signedInTab(known, b)
    known.goDown()
    const reloaded = b.tab()
    await reloaded.state().start()
    reloaded.state().status.should.equal('unreachable')
    known.goDown(false)
    await reloaded.state().start()
    reloaded.state().status.should.equal('signed-in')
  })

  it('signs out at Known, and every other tab follows', async () => {
    const known = fakeKnown()
    const b = browser(known)
    const { tab } = await signedInTab(known, b)
    const other = b.tab()
    await other.state().start()
    await tab.state().signOut()
    tab.state().status.should.equal('signed-out')
    known.calls.at(-1).url.should.equal(ENDPOINTS.revoke)
    known.live.size.should.equal(0)
    other.events.dispatchEvent(Object.assign(new Event('storage'), { key: `known.session.${CLIENT}.refresh`, newValue: null }))
    other.state().status.should.equal('signed-out')
    should(await other.state().getToken()).be.null()
  })

  it('gives methodry the token on every call and a fresh one after a 401', async () => {
    const known = fakeKnown()
    const b = browser(known)
    const { tab } = await signedInTab(known, b)
    const auth = methodryAuth(tab.session)
    auth.authHeader().should.eql({})
    const headers = await auth.headers()
    headers.authorization.should.match(/^Bearer at/)
    const fresh = await auth.reauthenticate()
    fresh.should.not.equal(headers.authorization.slice('Bearer '.length))
    await tab.state().signOut()
    ;(await auth.headers()).should.eql({})
    should(await auth.reauthenticate()).be.null()
  })
})

describe('wiki/session beside a wiki', () => {
  const KNOWN = 'https://known.example'

  // A page framed by Known: messages reach `answer`, and what it says comes
  // back from the parent. `from` overrides who it seems to come from.
  function framed (answer, { from = KNOWN, source = null } = {}) {
    const listeners = new Set()
    const events = {
      addEventListener: (type, fn) => { if (type === 'message') listeners.add(fn) },
      removeEventListener: (type, fn) => listeners.delete(fn)
    }
    const asked = []
    const parent = {
      postMessage (message, targetOrigin) {
        asked.push({ message, targetOrigin })
        const data = answer(message, asked.length)
        if (data === undefined) return
        queueMicrotask(() => { for (const fn of [...listeners]) fn({ origin: from, source: source ?? parent, data: { type: message.type, id: message.id, ...data } }) })
      }
    }
    const storage = memoryStorage()
    const assigned = []
    const store = createSessionStore({
      clientId: CLIENT,
      redirectUri: REDIRECT,
      signIn: ENDPOINTS,
      storage,
      pendingStorage: memoryStorage(),
      fetch: async () => { throw new Error('a framed page calls no token endpoint') },
      location: { href: REDIRECT, assign: (url) => assigned.push(url) },
      history: {},
      locks: null,
      events,
      preview: { parent: KNOWN },
      parent
    })
    return { store, asked, assigned, storage, listeners }
  }

  it('asks its parent for a token instead of signing in, by the origin its settings name', async () => {
    const { store, asked, assigned, storage } = framed(() => ({ accessToken: 'at1', expiresIn: 3600, wikis: ['capital', 'docs'] }))
    await store.getState().start()
    should(await store.getState().getToken()).equal('at1')
    should(asked[0].targetOrigin).equal(KNOWN)
    should(asked[0].message.type).equal(PREVIEW_TOKEN_MESSAGE)
    should(await store.getState().getToken()).equal('at1')
    should(store.getState().wikis).deepEqual(['capital', 'docs'])
    should(assigned).be.empty()
    should(storage.map.size).equal(0)
  })

  it('asks again when the token is about to lapse, one ask at a time', async () => {
    const { store, asked } = framed((message, count) => ({ accessToken: `at${count}`, expiresIn: 30, wikis: [] }))
    await store.getState().start()
    const [one, two] = await Promise.all([store.getState().getToken(), store.getState().getToken()])
    should(one).equal('at2')
    should(two).equal('at2')
    should(asked.length).equal(2)
  })

  it('hears nobody but the parent it names', async () => {
    const stranger = framed(() => ({ accessToken: 'stolen', expiresIn: 3600, wikis: [] }), { from: 'https://evil.example' })
    const other = framed(() => ({ accessToken: 'stolen', expiresIn: 3600, wikis: [] }), { source: { postMessage () {} } })
    for (const { store, listeners } of [stranger, other]) {
      const started = store.getState().start()
      await new Promise((resolve) => setTimeout(resolve, 5))
      should(store.getState().status).equal('checking')
      should(listeners.size).equal(1)
      for (const fn of listeners) fn({ origin: KNOWN, source: store, data: { type: 'other' } })
      started.catch(() => {})
    }
  })

  it('takes a refusal as signed out, and stays so until asked to sign in', async () => {
    let refuse = true
    const { store, asked, assigned } = framed(() => (refuse ? { error: { code: 'not_allowed', message: 'needs access to its wiki' } } : { accessToken: 'at2', expiresIn: 3600, wikis: ['docs'] }))
    await store.getState().start()
    should(store.getState().error.code).equal('not_allowed')
    should(await store.getState().getToken()).equal(null)
    should(asked.length).equal(1)

    refuse = false
    await store.getState().signIn()
    should(await store.getState().getToken()).equal('at2')
    should(assigned).be.empty()

    await store.getState().signOut()
    should(await store.getState().getToken()).equal(null)
  })

  it('is on only for a framed page whose settings say so', () => {
    const page = (text) => ({ getElementById: (id) => (id === 'known-site' && text !== null ? { textContent: text } : null) })
    const self = {}
    const parent = {}
    const settings = JSON.stringify({ clientId: 'app', preview: { parent: KNOWN } })
    should(previewOfPage({ document: page(settings), self, parent })).deepEqual({ parent: KNOWN })
    should(previewOfPage({ document: page(settings), self, parent: self })).equal(null)
    should(previewOfPage({ document: page(JSON.stringify({ clientId: 'app' })), self, parent })).equal(null)
    should(previewOfPage({ document: page('not json'), self, parent })).equal(null)
    should(previewOfPage({ document: page(null), self, parent })).equal(null)
    should(previewOfPage({ document: undefined, self, parent })).equal(null)
  })
})
