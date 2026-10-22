import should from 'should'
import { createStore } from 'zustand/vanilla'
import { createWatchStore, followChanges } from '../lib/session/index.js'

/**
 * wiki/session's watch against a stand-in rpc host: each `app.watch`
 * opens a stream the test writes events into, or a refusal the test
 * chose. Time is the test's: every wait the watch asks for is queued
 * until the test lets it pass.
 */

const BASE = 'https://rpc.known.example'

// The session as the watch reads it: status, wikis, a token.
function fakeSession ({ wikis = ['acme_deals', 'acme_labs'] } = {}) {
  let serial = 0
  const forced = []
  const store = createStore((set) => ({
    status: 'signed-in',
    scope: wikis.map((wiki) => `wiki:${wiki}:read`).join(' '),
    wikis,
    clientId: `app_${Math.random().toString(36).slice(2)}`,
    async getToken ({ force = false } = {}) {
      if (force) forced.push(serial)
      return store.getState().status === 'signed-in' ? `at${++serial}` : null
    },
    signOut: () => set({ status: 'signed-out', scope: '', wikis: [] }),
    signIn: () => set({ status: 'signed-in', scope: wikis.map((wiki) => `wiki:${wiki}:read`).join(' '), wikis })
  }))
  store.forced = forced
  return store
}

// The rpc host: `next` is what the next app.watch answers — 'stream'
// (the default), or a refusal's reason, or a status code.
function fakeHost () {
  const host = { calls: [], streams: [], next: [] }
  host.fetch = async (url, init) => {
    host.calls.push({ url, body: JSON.parse(init.body), authorization: init.headers.authorization })
    const answer = host.next.shift() ?? 'stream'
    if (typeof answer === 'number') return new Response('{}', { status: answer })
    if (answer !== 'stream') {
      return Response.json({ jsonrpc: '2.0', id: 1, error: { code: -32003, message: `refused: ${answer}`, data: { refused: true, reason: answer } } })
    }
    let controller
    const body = new ReadableStream({ start: (c) => { controller = c } })
    const encoder = new TextEncoder()
    const stream = {
      open: true,
      send (result) { controller.enqueue(encoder.encode(`data: ${JSON.stringify({ jsonrpc: '2.0', id: 1, result })}\n\n`)) },
      error (reason) { controller.enqueue(encoder.encode(`data: ${JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32003, message: reason, data: { refused: true, reason } } })}\n\n`)) },
      end () { stream.open = false; controller.enqueue(encoder.encode('data: [DONE]\n\n')); controller.close() }
    }
    init.signal?.addEventListener('abort', () => { stream.open = false; try { controller.error(new DOMException('aborted', 'AbortError')) } catch {} })
    host.streams.push(stream)
    return new Response(body, { headers: { 'content-type': 'text/event-stream; charset=utf-8' } })
  }
  return host
}

// Waits the watch asks for, released by the test.
function fakeTime () {
  const waits = []
  return {
    waits,
    sleep: (ms, signal) => new Promise((resolve) => {
      const entry = { ms, resolve }
      waits.push(entry)
      signal?.addEventListener('abort', resolve, { once: true })
    }),
    pass () { const entry = waits.shift(); entry?.resolve(); return entry }
  }
}

// Web Locks as the browser grants them: one holder per name, the rest
// queued; a request aborted before it is granted gives up.
function fakeLocks () {
  const queues = new Map()
  function grant (name) {
    const queue = queues.get(name)
    if (!queue?.length || queue.held) return
    const next = queue.shift()
    queue.held = true
    Promise.resolve().then(next.callback).then(next.resolve, next.reject).finally(() => { queue.held = false; grant(name) })
  }
  return {
    request (name, options, callback) {
      return new Promise((resolve, reject) => {
        if (!queues.has(name)) queues.set(name, [])
        const queue = queues.get(name)
        const entry = { callback, resolve, reject }
        queue.push(entry)
        options?.signal?.addEventListener('abort', () => {
          const at = queue.indexOf(entry)
          if (at !== -1) { queue.splice(at, 1); reject(new DOMException('aborted', 'AbortError')) }
        }, { once: true })
        grant(name)
      })
    }
  }
}

async function until (check, { timeout = 2000 } = {}) {
  const deadline = Date.now() + timeout
  while (!check()) {
    if (Date.now() > deadline) throw new Error('condition not met in time')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

function watchFor (session, host, time, extra = {}) {
  return createWatchStore({ session, baseUrl: BASE, fetch: host.fetch, sleep: time.sleep, random: () => 1, locks: null, BroadcastChannel: null, ...extra })
}

describe('wiki/session watch', () => {
  const started = []
  afterEach(() => {
    for (const watch of started.splice(0)) watch.getState().stop()
  })
  const start = (watch) => { started.push(watch); watch.getState().start(); return watch }

  it('holds one stream for every granted wiki, live once ready, and hands each change to its listeners, its state and the wiki stores', async () => {
    const session = fakeSession()
    const host = fakeHost()
    const watch = start(watchFor(session, host, fakeTime()))
    watch.getState().status.should.equal('connecting')
    await until(() => host.streams.length === 1)
    host.calls[0].url.should.equal(`${BASE}/rpc`)
    host.calls[0].body.method.should.equal('site.watch')
    host.calls[0].authorization.should.equal('Bearer at1')

    const heard = []
    watch.getState().onChange((change) => heard.push(change))
    const applied = []
    const store = createStore(() => ({ applyChange: (change) => applied.push(change) }))
    followChanges(watch, store)

    host.streams[0].send({ type: 'ready', wikis: ['acme_deals', 'acme_labs'] })
    await until(() => watch.getState().status === 'live')
    watch.getState().wikis.should.deepEqual(['acme_deals', 'acme_labs'])
    watch.getState().role.should.equal('leader')
    // the first stream has missed nothing: no resync
    heard.should.have.length(0)

    host.streams[0].send({ type: 'heartbeat' })
    host.streams[0].send({ type: 'change', wiki: 'acme_deals', path: 'q3', action: 'wiki.write' })
    await until(() => heard.length === 1)
    heard[0].should.containEql({ type: 'change', wiki: 'acme_deals', path: 'q3', action: 'wiki.write', seq: 1 })
    watch.getState().lastChange.should.containEql({ wiki: 'acme_deals', path: 'q3' })
    applied.should.have.length(1)
  })

  it('reconnects when a stream expires, and resyncs what the gap may have hidden', async () => {
    const session = fakeSession()
    const host = fakeHost()
    const watch = start(watchFor(session, host, fakeTime()))
    const heard = []
    watch.getState().onChange((change) => heard.push(change))
    await until(() => host.streams.length === 1)
    host.streams[0].send({ type: 'ready', wikis: ['acme_deals'] })
    host.streams[0].send({ type: 'expired', reason: 'token' })
    await until(() => host.streams.length === 2)
    // no flicker while it reconnects
    watch.getState().status.should.equal('live')
    host.streams[1].send({ type: 'ready', wikis: ['acme_deals'] })
    await until(() => heard.length === 1)
    heard[0].should.containEql({ type: 'resync', wiki: 'acme_deals', path: null })
  })

  it('backs off after a dropped stream or an unreachable host, asking for a fresh token after a 401', async () => {
    const session = fakeSession()
    const host = fakeHost()
    const time = fakeTime()
    const watch = start(watchFor(session, host, time))
    await until(() => host.streams.length === 1)
    host.streams[0].end()
    await until(() => time.waits.length === 1)
    time.waits[0].ms.should.equal(1000)
    watch.getState().status.should.equal('connecting')

    host.next.push(401)
    time.pass()
    await until(() => time.waits.length === 1)
    session.forced.should.have.length(1)
    time.waits[0].ms.should.equal(2000)

    time.pass()
    await until(() => host.streams.length === 2)
    host.streams[1].send({ type: 'ready', wikis: ['acme_deals'] })
    await until(() => watch.getState().status === 'live')
  })

  it('polls once a minute when the plan has no live updates, and tries live again after a while', async () => {
    const session = fakeSession({ wikis: ['acme_deals'] })
    const host = fakeHost()
    const time = fakeTime()
    host.next.push('plan_feature')
    const watch = start(watchFor(session, host, time))
    const heard = []
    watch.getState().onChange((change) => heard.push(change))
    await until(() => watch.getState().status === 'polling')
    watch.getState().wikis.should.deepEqual(['acme_deals'])
    await until(() => time.waits.length === 1)
    time.waits[0].ms.should.equal(60 * 1000)
    time.pass()
    await until(() => heard.length === 1)
    heard[0].should.containEql({ type: 'resync', wiki: 'acme_deals' })

    // a quarter of an hour of polls, then live again
    for (let i = 1; i < 15; i++) {
      await until(() => time.waits.length === 1)
      time.pass()
    }
    await until(() => host.calls.length === 2)
    await until(() => host.streams.length === 1)
  })

  it('stops when the person may no longer use the app, until the sign-in changes', async () => {
    const session = fakeSession()
    const host = fakeHost()
    const watch = start(watchFor(session, host, fakeTime()))
    await until(() => host.streams.length === 1)
    host.streams[0].send({ type: 'ready', wikis: ['acme_deals'] })
    host.streams[0].send({ type: 'revoked', reason: 'app_reach' })
    await until(() => watch.getState().status === 'stopped')
    watch.getState().error.code.should.equal('app_reach')
    await new Promise((resolve) => setTimeout(resolve, 20))
    host.calls.should.have.length(1)

    // signing out and in again tries once more
    session.getState().signOut()
    await until(() => watch.getState().status === 'signed-out')
    session.getState().signIn()
    await until(() => host.streams.length === 2)
  })

  it('closes the stream when the person signs out, and opens one when they sign back in', async () => {
    const session = fakeSession()
    const host = fakeHost()
    const watch = start(watchFor(session, host, fakeTime()))
    await until(() => host.streams.length === 1)
    host.streams[0].send({ type: 'ready', wikis: ['acme_deals'] })
    await until(() => watch.getState().status === 'live')
    session.getState().signOut()
    await until(() => watch.getState().status === 'signed-out')
    host.streams[0].open.should.be.false()
    watch.getState().wikis.should.deepEqual([])
    session.getState().signIn()
    await until(() => host.streams.length === 2)
  })

  it('a cap reached waits a minute before trying again', async () => {
    const session = fakeSession()
    const host = fakeHost()
    const time = fakeTime()
    start(watchFor(session, host, time))
    await until(() => host.streams.length === 1)
    host.streams[0].error('too_many_streams')
    await until(() => time.waits.length === 1)
    time.waits[0].ms.should.equal(60 * 1000)
  })

  it('one tab holds the stream for the browser; the others hear it, and one takes over when it lets go', async () => {
    const session = fakeSession()
    const host = fakeHost()
    const locks = fakeLocks()
    const tab = () => watchFor(session, host, fakeTime(), { locks, BroadcastChannel })
    const first = start(tab())
    await until(() => host.streams.length === 1)
    first.getState().role.should.equal('leader')
    const second = start(tab())
    await until(() => second.getState().role === 'follower')

    const heard = []
    second.getState().onChange((change) => heard.push(change))
    host.streams[0].send({ type: 'ready', wikis: ['acme_deals'] })
    await until(() => second.getState().status === 'live')
    second.getState().wikis.should.deepEqual(['acme_deals'])
    host.streams[0].send({ type: 'change', wiki: 'acme_deals', path: 'q3', action: 'wiki.write' })
    await until(() => heard.length === 1)
    heard[0].should.containEql({ type: 'change', path: 'q3' })
    // one connection for both tabs
    host.calls.should.have.length(1)

    // the holder closes: the other takes the lock, connects, and resyncs
    first.getState().stop()
    await until(() => host.streams.length === 2)
    second.getState().role.should.equal('leader')
    host.streams[1].send({ type: 'ready', wikis: ['acme_deals'] })
    await until(() => heard.some((change) => change.type === 'resync'))
  })
})
