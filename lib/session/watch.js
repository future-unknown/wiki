/**
 * wiki/session's live updates — a site's one connection to Known, as a
 * zustand vanilla store beside the session (roadmap.plans.live-sites in
 * the unknown wiki).
 *
 * `createWatchStore({ session, baseUrl })` holds the rpc host's
 * `app.watch` stream for the person signed in: one stream for every
 * wiki the site reads for them, and one per browser, not per tab. The
 * tab that takes a Web Lock holds the stream and passes what it hears
 * to the app's other tabs over a BroadcastChannel; when it closes,
 * another tab takes over. Without either (an old browser, a test) each
 * tab holds its own.
 *
 * The state is what a view renders: `status` ('idle', 'connecting',
 * 'live', 'polling' — the plan has no live updates, so it checks once a
 * minute instead — 'signed-out', or 'stopped' with an `error`), `role`
 * ('leader' holds the stream, 'follower' hears it from the tab that
 * does), the `wikis` it covers, and `lastChange`. Select from it with
 * zustand's `useStore(watch, selector)`.
 *
 * Changes arrive as `{ type, wiki, path, action }`: `change` for one
 * page (`path` relative to the wiki, null for its root) or its records,
 * and `resync` when anything in the wiki may have changed unseen —
 * after a reconnect, a takeover, or a poll. Hear them with
 * `onChange(listener)`, or hand the wiki stores to `followChanges`.
 */

import { createStore } from 'zustand/vanilla'

const STATUS = Object.freeze({
  idle: 'idle',
  connecting: 'connecting',
  live: 'live',
  polling: 'polling',
  signedOut: 'signed-out',
  stopped: 'stopped'
})

const NAME_PREFIX = 'known.watch.'
// Reconnects back off from a second to half a minute, with jitter so
// a host's restart does not bring every tab back at once.
const BACKOFF_INITIAL_MS = 1000
const BACKOFF_MAX_MS = 30 * 1000
// A cap reached is someone else's stream still holding on: wait longer.
const CAP_WAIT_MS = 60 * 1000
// Without live updates on the plan: a resync once a minute, and another
// try at live every quarter hour, in case the plan changed.
const POLL_MS = 60 * 1000
const RETRY_LIVE_MS = 15 * 60 * 1000

/**
 * The watch store for one site. `session` is its `createSessionStore`;
 * `baseUrl` the rpc host. The browser's pieces default to the globals
 * and can be handed in, for tests or another runtime.
 */
export function createWatchStore ({
  session,
  baseUrl,
  fetch: fetchImpl = globalThis.fetch?.bind(globalThis),
  locks = globalThis.navigator?.locks ?? null,
  BroadcastChannel: Channel = globalThis.BroadcastChannel ?? null,
  sleep = wait,
  random = Math.random,
  now = Date.now
} = {}) {
  if (!session?.getState) throw new Error('createWatchStore requires the session store')
  if (!baseUrl) throw new Error('createWatchStore requires the rpc host\'s baseUrl')
  const url = `${String(baseUrl).replace(/\/+$/, '')}/rpc`
  const name = `${NAME_PREFIX}${session.getState().clientId ?? 'app'}`
  // Tabs agree on one holder only when they can both elect it and hear it.
  const shared = Boolean(locks?.request && Channel)

  const listeners = new Set()
  let seq = 0
  let running = null

  const initial = { status: STATUS.idle, role: null, wikis: [], lastChange: null, error: null }

  return createStore((set, get) => {
    // A change, to this tab's listeners and state.
    function deliver (change) {
      const heard = { ...change, seq: ++seq, at: now() }
      set({ lastChange: heard })
      for (const listener of listeners) {
        try {
          listener(heard)
        } catch {
          // one listener's failure is its own
        }
      }
    }

    function begin () {
      const controller = new AbortController()
      const { signal } = controller
      const channel = shared ? new Channel(name) : null
      const run = { controller, channel }

      // What the holder says, everyone hears; a follower takes its state
      // and changes from there.
      const announce = (fields) => {
        set(fields)
        channel?.postMessage({ kind: 'status', status: get().status, wikis: get().wikis, error: get().error })
      }
      const emit = (change) => {
        deliver(change)
        channel?.postMessage({ kind: 'change', change })
      }

      if (channel) {
        // Whether another tab held the stream while this one followed:
        // taking over from it, this tab may have missed something.
        let followed = false
        channel.onmessage = ({ data }) => {
          if (signal.aborted || !data) return
          if (get().role === 'leader') {
            if (data.kind === 'hello') announce({})
            return
          }
          if (data.kind === 'status' || data.kind === 'change') followed = true
          if (data.kind === 'status') set({ status: data.status, wikis: data.wikis ?? [], error: data.error ?? null })
          if (data.kind === 'change') deliver(data.change)
        }
        set({ status: STATUS.connecting, role: 'follower', error: null })
        channel.postMessage({ kind: 'hello' })
        locks.request(name, { signal }, async () => {
          if (signal.aborted) return
          set({ role: 'leader' })
          await lead({ signal, announce, emit, resync: followed })
        }).catch(() => {})
      } else {
        set({ status: STATUS.connecting, role: 'leader', error: null })
        void lead({ signal, announce, emit, resync: false })
      }
      return run
    }

    // The holder's loop: connect, hear, reconnect — or poll, when the
    // plan says no — until stopped.
    async function lead ({ signal, announce, emit, resync: resyncFirst }) {
      let attempt = 0
      let resync = resyncFirst
      let polling = false
      const resyncAll = () => {
        for (const wiki of get().wikis.length ? get().wikis : session.getState().wikis ?? []) emit({ type: 'resync', wiki, path: null, action: null })
      }

      while (!signal.aborted) {
        if (session.getState().status !== 'signed-in') {
          announce({ status: STATUS.signedOut, wikis: [], error: null })
          await untilSignedIn(session, signal)
          resync = true
          continue
        }

        if (polling) {
          announce({ status: STATUS.polling, wikis: session.getState().wikis ?? [], error: null })
          for (let waited = 0; waited < RETRY_LIVE_MS && !signal.aborted && session.getState().status === 'signed-in'; waited += POLL_MS) {
            await sleep(POLL_MS, signal)
            if (!signal.aborted) resyncAll()
          }
          polling = false
          continue
        }

        announce({ status: get().status === STATUS.live ? STATUS.live : STATUS.connecting })
        const outcome = await connect({
          signal,
          onReady (wikis) {
            attempt = 0
            announce({ status: STATUS.live, wikis, error: null })
            if (resync) resyncAll()
            resync = false
          },
          onChange: emit
        })
        if (signal.aborted) break
        // Signed out mid-stream: the top of the loop says so and waits.
        if (session.getState().status !== 'signed-in') continue

        if (outcome.kind === 'plan') {
          polling = true
          continue
        }
        if (outcome.kind === 'stopped') {
          announce({ status: STATUS.stopped, wikis: [], error: outcome.error })
          await untilSessionChanges(session, signal)
          continue
        }
        // Whatever ended it, the next stream may have missed something.
        resync = true
        if (outcome.kind === 'expired') continue
        if (outcome.kind === 'unauthorized') await session.getState().getToken({ force: true }).catch(() => null)
        const base = outcome.kind === 'cap' ? CAP_WAIT_MS : Math.min(BACKOFF_MAX_MS, BACKOFF_INITIAL_MS * 2 ** attempt)
        attempt += 1
        announce({ status: STATUS.connecting, error: outcome.error ?? null })
        await sleep(Math.round(base * (0.5 + random() / 2)), signal)
      }
    }

    // One stream, read to its end: `{ kind }` says how it ended —
    // expired, plan, stopped, unauthorized, cap, or dropped.
    async function connect ({ signal, onReady, onChange }) {
      const local = new AbortController()
      const abort = () => local.abort()
      signal.addEventListener('abort', abort, { once: true })
      // Signing out ends the stream at once.
      const unsubscribe = session.subscribe((state) => { if (state.status !== 'signed-in') abort() })
      try {
        const token = await session.getState().getToken().catch(() => null)
        if (!token) return { kind: 'unauthorized' }
        const response = await fetchImpl(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'text/event-stream', authorization: `Bearer ${token}` },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'app.watch', params: {} }),
          signal: local.signal
        })
        if (response.status === 401) return { kind: 'unauthorized' }
        if (!response.ok) return { kind: 'dropped', error: { code: 'unavailable', message: `the host answered ${response.status}` } }
        if (!String(response.headers.get('content-type') ?? '').startsWith('text/event-stream')) {
          const body = await response.json().catch(() => null)
          return refused(body?.error)
        }
        for await (const message of frames(response.body)) {
          if (message.error) return refused(message.error)
          const event = message.result
          if (event?.type === 'ready') onReady(event.wikis ?? [])
          else if (event?.type === 'change') onChange({ type: 'change', wiki: event.wiki, path: event.path ?? null, action: event.action ?? null })
          else if (event?.type === 'expired') return { kind: 'expired' }
          else if (event?.type === 'revoked') return refused({ message: 'live updates ended', data: { reason: event.reason } })
        }
        return { kind: 'dropped' }
      } catch (error) {
        return { kind: 'dropped', error: { code: 'unreachable', message: error?.message ?? 'the host could not be reached' } }
      } finally {
        unsubscribe()
        signal.removeEventListener('abort', abort)
      }
    }

    return {
      ...initial,

      /** Hold the stream (or follow the tab that does). Starting twice is starting once. */
      start () {
        if (running) return
        running = begin()
      },

      /** Let go: this tab's stream closes, and another tab may take it. */
      stop () {
        if (!running) return
        running.controller.abort()
        running.channel?.close()
        running = null
        set({ ...initial, lastChange: get().lastChange })
      },

      /** Hear every change: `listener(change)`. Answers the way to stop hearing. */
      onChange (listener) {
        listeners.add(listener)
        return () => listeners.delete(listener)
      }
    }
  })
}

/**
 * Keep wiki stores (`wiki/store`) current from a watch: each change
 * goes to every store's `applyChange`, which reloads what it shows of
 * that wiki. Answers the way to stop.
 */
export function followChanges (watch, ...stores) {
  return watch.getState().onChange((change) => {
    for (const store of stores.flat()) store.getState().applyChange?.(change)
  })
}

// A refusal as the loop reads it: no live updates on the plan means
// polling; a cap is a wait; the rest stop until the sign-in changes.
function refused (error) {
  const reason = error?.data?.reason ?? null
  if (reason === 'plan_feature') return { kind: 'plan' }
  if (reason === 'too_many_streams') return { kind: 'cap', error: { code: reason, message: error.message } }
  return { kind: 'stopped', error: { code: reason ?? 'refused', message: error?.message ?? 'live updates were refused' } }
}

// The JSON-RPC messages of an event stream, in order, until `[DONE]`.
async function * frames (body) {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) return
      buffer += decoder.decode(value, { stream: true })
      let at
      while ((at = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, at)
        buffer = buffer.slice(at + 2)
        const data = frame.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n')
        if (!data) continue
        if (data === '[DONE]') return
        try {
          yield JSON.parse(data)
        } catch {
          // a frame that is not JSON is not ours to read
        }
      }
    }
  } finally {
    reader.releaseLock?.()
    body.cancel?.().catch?.(() => {})
  }
}

function untilSignedIn (session, signal) {
  return new Promise((resolve) => {
    if (signal.aborted || session.getState().status === 'signed-in') return resolve()
    const done = () => { unsubscribe(); signal.removeEventListener('abort', done); resolve() }
    const unsubscribe = session.subscribe((state) => { if (state.status === 'signed-in') done() })
    signal.addEventListener('abort', done, { once: true })
  })
}

// A stopped watch waits for the sign-in to change (someone signs in
// again, or out) before it tries again.
function untilSessionChanges (session, signal) {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve()
    const before = session.getState().scope
    const done = () => { unsubscribe(); signal.removeEventListener('abort', done); resolve() }
    const unsubscribe = session.subscribe((state, previous) => {
      if (state.status !== previous.status || state.scope !== before) done()
    })
    signal.addEventListener('abort', done, { once: true })
  })
}

function wait (ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve()
    const timer = setTimeout(done, ms)
    signal?.addEventListener('abort', done, { once: true })
    function done () {
      clearTimeout(timer)
      signal?.removeEventListener('abort', done)
      resolve()
    }
  })
}
