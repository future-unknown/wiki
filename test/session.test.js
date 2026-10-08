import should from 'should'
import { createHash } from 'node:crypto'
import { createSessionStore, methodryAuth, scopeFor, wikisOf } from '../lib/session/index.js'

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
  it('scopes name wikis to read, and a granted scope names them back', () => {
    scopeFor('acme_deals', ['acme_labs']).should.equal('wiki:acme_deals:read wiki:acme_labs:read')
    wikisOf('wiki:acme_deals:read wiki:acme_labs:read wiki:acme_deals:read').should.eql(['acme_deals', 'acme_labs'])
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
    Object.fromEntries(url.searchParams).should.containEql({ response_type: 'code', client_id: CLIENT, redirect_uri: REDIRECT, scope: 'wiki:acme_deals:read', code_challenge_method: 'S256' })
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
    tab.state().should.containEql({ status: 'signed-in', scope: 'wiki:acme_deals:read', wikis: ['acme_deals'], error: null })
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
