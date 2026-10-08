/**
 * wiki/session — signing someone in to a browser app with Known, as a
 * zustand vanilla store beside `wiki/store` (roadmap.plans.wiki-api-access
 * in the unknown wiki).
 *
 * OAuth 2.0's authorization code flow with PKCE, for a public client:
 * `signIn()` sends the person to Known's sign-in page; `start()`, on the
 * page they come back to, swaps the code for tokens and cleans the
 * address; `getToken()` hands out the access token, refreshing it when
 * it is about to lapse; `signOut()` revokes the sign-in.
 *
 * The state is what a view renders: `status` ('idle', 'checking',
 * 'signed-in', 'signed-out', 'redirecting', or 'unreachable' — a
 * sign-in is kept but Known could not be asked; `start()` again), the
 * wikis the sign-in was granted, and the last `error`. Select from it with zustand's
 * `useStore(session, selector)` or `session.subscribe`. The access token
 * is not in the state, so it never reaches devtools, a persisted
 * snapshot, or a re-render; ask `getToken()` for it.
 *
 * The refresh token is kept in localStorage, so a sign-in outlives a
 * reload. Each refresh token works once, and presenting a spent one ends
 * the sign-in; two tabs refreshing together would do that, so a refresh
 * takes a Web Lock and reads the newest token from storage inside it.
 * A tab that sees another sign the person out follows.
 */

import { createStore } from 'zustand/vanilla'

// Refresh this long before the access token lapses, so a call never
// leaves with a token that expires on the way.
const REFRESH_EARLY_MS = 60 * 1000
const VERIFIER_BYTES = 32
const STATE_BYTES = 16
const KEY_PREFIX = 'known.session.'
// Query parameters a return from sign-in adds, cleaned from the address.
const RETURN_PARAMS = ['code', 'state', 'error', 'error_description', 'error_uri', 'iss']

const STATUS = Object.freeze({
  idle: 'idle',
  checking: 'checking',
  signedIn: 'signed-in',
  signedOut: 'signed-out',
  redirecting: 'redirecting',
  unreachable: 'unreachable'
})

/** A sign-in that Known refused, or that ended: `code` is OAuth's (`invalid_grant`, `access_denied`, …). */
export class SessionError extends Error {
  constructor (code, message) {
    super(message || code)
    this.name = 'SessionError'
    this.code = code
  }
}

/**
 * The rpc host's own document, `GET <baseUrl>/rpc`: its methods, and
 * `signIn` — Known's sign-in page and token endpoints — where apps can
 * sign people in.
 */
export async function discoverHost ({ baseUrl, fetch: fetchImpl = globalThis.fetch } = {}) {
  if (!baseUrl) throw new Error('discoverHost requires baseUrl')
  const response = await fetchImpl(`${String(baseUrl).replace(/\/+$/, '')}/rpc`, { headers: { accept: 'application/json' } })
  if (!response.ok) throw new Error(`discovery failed with ${response.status}`)
  return response.json()
}

/**
 * The scope that asks for read access to wikis, by address:
 * `scopeFor('acme_deals', 'acme_labs')`.
 */
export function scopeFor (...wikis) {
  return wikis.flat().filter(Boolean).map((wiki) => `wiki:${wiki}:read`).join(' ')
}

/** The wikis a granted scope names, by address. */
export function wikisOf (scope) {
  return String(scope ?? '').split(' ').map((entry) => /^wiki:([^:]+):[a-z]+$/.exec(entry)?.[1]).filter(Boolean)
    .filter((wiki, index, all) => all.indexOf(wiki) === index)
}

/**
 * Methodry's auth options from a session: every call carries the
 * current access token, and a 401 asks the session for a fresh one
 * before methodry retries. Spread into `createClient(url, null, …)`.
 */
export function methodryAuth (session) {
  return {
    authHeader: () => ({}),
    headers: async () => {
      const token = await session.getState().getToken()
      return token ? { authorization: `Bearer ${token}` } : {}
    },
    reauthenticate: async () => {
      try {
        return await session.getState().getToken({ force: true })
      } catch {
        return null
      }
    }
  }
}

/**
 * The session store for one app. `clientId` and `redirectUri` are the
 * app's, exactly as registered in Known; `signIn` is the host
 * document's `signIn` (or `authorizeUrl`, `tokenUrl`, `revokeUrl`
 * given one by one); `scope` asks for wikis (`scopeFor`). The browser's
 * pieces default to the globals and can be handed in, for tests or
 * another runtime.
 */
export function createSessionStore ({
  clientId,
  redirectUri,
  scope = '',
  signIn: endpoints = null,
  authorizeUrl = endpoints?.authorize,
  tokenUrl = endpoints?.token,
  revokeUrl = endpoints?.revoke ?? null,
  storage = globalThis.localStorage,
  pendingStorage = globalThis.sessionStorage,
  fetch: fetchImpl = globalThis.fetch?.bind(globalThis),
  location = globalThis.location,
  history = globalThis.history,
  crypto = globalThis.crypto,
  locks = globalThis.navigator?.locks ?? null,
  events = globalThis,
  now = Date.now
} = {}) {
  if (!clientId) throw new Error('createSessionStore requires the app\'s clientId')
  if (!redirectUri) throw new Error('createSessionStore requires the app\'s redirectUri')
  if (!authorizeUrl || !tokenUrl) throw new Error('createSessionStore requires Known\'s sign-in endpoints (signIn from the host document)')

  const refreshKey = `${KEY_PREFIX}${clientId}.refresh`
  const pendingKey = `${KEY_PREFIX}${clientId}.pending`
  const lockName = `${KEY_PREFIX}${clientId}`

  // The access token and when it lapses: this tab's alone, never state.
  // The refresh token is kept in storage, and here too for a tab whose
  // storage refuses (a private window): the sign-in then lasts the tab.
  let access = null
  let kept = null
  let inflight = null

  const readRefresh = () => read(storage, refreshKey) ?? kept
  const keepRefresh = (token) => { kept = token; write(storage, refreshKey, token) }
  const dropRefresh = () => { kept = null; remove(storage, refreshKey) }

  const initial = { status: STATUS.idle, scope: '', wikis: [], error: null }

  return createStore((set, get) => {
    function signedIn (answer) {
      access = { token: answer.access_token, expiresAt: now() + Number(answer.expires_in ?? 0) * 1000 }
      if (answer.refresh_token) keepRefresh(answer.refresh_token)
      const granted = typeof answer.scope === 'string' ? answer.scope : get().scope
      set({ status: STATUS.signedIn, scope: granted, wikis: wikisOf(granted), error: null })
    }

    function signedOut (error = null) {
      access = null
      dropRefresh()
      if (get().status !== STATUS.signedOut || error !== get().error) set({ status: STATUS.signedOut, scope: '', wikis: [], error })
    }

    async function post (url, fields) {
      const response = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: new URLSearchParams(fields).toString()
      })
      const text = await response.text()
      const body = text ? safeJson(text) : null
      if (response.ok) return body ?? {}
      // invalid_grant and friends end the sign-in; anything else (Known
      // unreachable, a 503) leaves it standing, to try again.
      const error = new SessionError(body?.error ?? 'server_error', body?.error_description ?? `the sign-in endpoint answered ${response.status}`)
      error.status = response.status
      throw error
    }

    // One refresh at a time, in this tab and across the app's tabs: the
    // newest refresh token is read inside the lock, so a token another
    // tab already rotated is never presented again.
    async function refresh () {
      inflight ??= withLock(locks, lockName, async () => {
        const token = readRefresh()
        if (!token) {
          signedOut()
          return null
        }
        try {
          const answer = await post(tokenUrl, { grant_type: 'refresh_token', refresh_token: token, client_id: clientId })
          signedIn(answer)
          return access.token
        } catch (error) {
          if (error instanceof SessionError && error.status >= 400 && error.status < 500) {
            signedOut({ code: error.code, message: error.message })
            return null
          }
          throw error
        }
      }).finally(() => { inflight = null })
      return inflight
    }

    // Another tab signed the person out: so does this one.
    events?.addEventListener?.('storage', (event) => {
      if (event.key === refreshKey && event.newValue === null && get().status === STATUS.signedIn) {
        access = null
        kept = null
        set({ status: STATUS.signedOut, scope: '', wikis: [], error: null })
      }
    })

    return {
      ...initial,

      /**
       * Where the page starts. Back from sign-in (`code` and the state
       * this tab sent) it swaps the code; back with an error it says so;
       * otherwise it resumes a sign-in kept from before, or reports none.
       * The address is cleaned of what sign-in added. Answers
       * `{ returnTo }`, whatever `signIn` was given to come back to.
       */
      async start () {
        set({ status: STATUS.checking, error: null })
        const url = new URL(location.href)
        const returned = url.searchParams.get('state')
        const pending = readJson(pendingStorage, pendingKey)
        if (returned !== null && pending && returned === pending.state) {
          remove(pendingStorage, pendingKey)
          const code = url.searchParams.get('code')
          const refused = { code: url.searchParams.get('error') ?? 'invalid_request', message: url.searchParams.get('error_description') ?? 'sign-in did not finish' }
          clean(url)
          if (!code) {
            signedOut(refused)
            return { returnTo: pending.returnTo ?? null }
          }
          try {
            const answer = await post(tokenUrl, { grant_type: 'authorization_code', code, code_verifier: pending.verifier, client_id: clientId, redirect_uri: redirectUri })
            signedIn(answer)
          } catch (error) {
            signedOut({ code: error.code ?? 'server_error', message: error.message })
          }
          return { returnTo: pending.returnTo ?? null }
        }
        if (readRefresh()) {
          try {
            await refresh()
          } catch (error) {
            // Known could not be asked; the sign-in stands for a retry.
            set({ status: STATUS.unreachable, error: { code: error.code ?? 'temporarily_unavailable', message: error.message } })
          }
        } else {
          set({ status: STATUS.signedOut })
        }
        return { returnTo: null }
      },

      /**
       * Send the person to Known's sign-in. `returnTo` is anything the
       * app wants back from `start()` when they return (a route, a hash).
       */
      async signIn ({ returnTo = null } = {}) {
        const verifier = random(crypto, VERIFIER_BYTES)
        const state = random(crypto, STATE_BYTES)
        const challenge = base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))))
        writeJson(pendingStorage, pendingKey, { verifier, state, returnTo })
        const url = new URL(authorizeUrl)
        url.search = new URLSearchParams({
          response_type: 'code',
          client_id: clientId,
          redirect_uri: redirectUri,
          scope,
          state,
          code_challenge: challenge,
          code_challenge_method: 'S256'
        }).toString()
        set({ status: STATUS.redirecting, error: null })
        location.assign(url.toString())
      },

      /**
       * The access token, refreshed first when it is about to lapse (or
       * when `force`d, after a 401). Null when no one is signed in;
       * throws when Known cannot be reached to refresh.
       */
      async getToken ({ force = false } = {}) {
        if (!force && access && access.expiresAt - REFRESH_EARLY_MS > now()) return access.token
        if (get().status === STATUS.redirecting) return null
        if (!readRefresh()) {
          signedOut()
          return null
        }
        return refresh()
      },

      /** Sign out of the app: the sign-in is revoked at Known, then forgotten here. */
      async signOut () {
        const token = readRefresh()
        signedOut()
        if (token && revokeUrl) {
          try {
            await post(revokeUrl, { token, client_id: clientId })
          } catch {
            // forgotten here either way; it lapses at Known unused
          }
        }
      }
    }
  })

  function clean (url) {
    for (const name of RETURN_PARAMS) url.searchParams.delete(name)
    history?.replaceState?.(history.state ?? null, '', url.toString())
  }
}

async function withLock (locks, name, work) {
  if (!locks?.request) return work()
  return locks.request(name, work)
}

function random (crypto, bytes) {
  return base64url(crypto.getRandomValues(new Uint8Array(bytes)))
}

function base64url (bytes) {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function safeJson (text) {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

// Storage can be missing or refuse (a private window): the sign-in then
// lasts as long as the tab, and nothing breaks.
function read (storage, key) {
  try {
    return storage?.getItem(key) ?? null
  } catch {
    return null
  }
}

function write (storage, key, value) {
  try {
    storage?.setItem(key, value)
  } catch {}
}

function remove (storage, key) {
  try {
    storage?.removeItem(key)
  } catch {}
}

function readJson (storage, key) {
  const value = read(storage, key)
  return value ? safeJson(value) : null
}

function writeJson (storage, key, value) {
  write(storage, key, JSON.stringify(value))
}
