import should from 'should'
import { ValidationError, NotFoundError } from '../../lib/kit/index.js'
import { createTestKit, seedAcme, human, agent, commitCount, revisionCount } from './helpers.js'

describe('data channel', () => {
  it('appends an observation without creating a commit or revision', async () => {
    const { kit, db } = await createTestKit()
    const { wikiId } = await seedAcme(kit)
    const before = commitCount(db, wikiId)
    const page = await kit.getNode({ wikiId, path: 'about.foo' })

    const datum = await kit.pushData({
      wikiId, path: 'about.foo', payload: { requests: 1042 }, actor: agent
    })
    datum.payload.should.deepEqual({ requests: 1042 })
    datum.actor.should.deepEqual({ type: 'agent', id: 'agent_test', onBehalfOf: 'user_test' })
    datum.ts.should.be.a.String()

    commitCount(db, wikiId).should.equal(before)
    revisionCount(db, page.id).should.equal(1)
    const after = await kit.getNode({ wikiId, path: 'about.foo' })
    after.revisionId.should.equal(page.revisionId)
  })

  it('accepts any JSON value as a payload', async () => {
    const { kit } = await createTestKit()
    const { wikiId } = await seedAcme(kit)
    await kit.pushData({ wikiId, path: 'about.foo', payload: 42, actor: agent })
    await kit.pushData({ wikiId, path: 'about.foo', payload: [1, 2, 3], actor: agent })
    await kit.pushData({ wikiId, path: 'about.foo', payload: null, actor: agent })
    const rows = await kit.getData({ wikiId, path: 'about.foo' })
    rows.map((row) => row.payload).should.deepEqual([42, [1, 2, 3], null])
  })

  it('reads ascending by observation time; latest returns the newest', async () => {
    const { kit } = await createTestKit()
    const { wikiId } = await seedAcme(kit)
    await kit.pushData({ wikiId, path: 'about.foo', payload: 2, ts: '2026-01-02T00:00:00Z', actor: agent })
    await kit.pushData({ wikiId, path: 'about.foo', payload: 3, ts: '2026-01-03T00:00:00Z', actor: agent })
    await kit.pushData({ wikiId, path: 'about.foo', payload: 1, ts: '2026-01-01T00:00:00Z', actor: agent })

    const rows = await kit.getData({ wikiId, path: 'about.foo' })
    rows.map((row) => row.payload).should.deepEqual([1, 2, 3])

    const latest = await kit.getData({ wikiId, path: 'about.foo', latest: true })
    latest.length.should.equal(1)
    latest[0].payload.should.equal(3)

    const empty = await kit.getData({ wikiId, path: 'about.bar', latest: true })
    empty.should.deepEqual([])
  })

  it('bounds ranges with since/until and caps with limit', async () => {
    const { kit } = await createTestKit()
    const { wikiId } = await seedAcme(kit)
    for (let day = 1; day <= 5; day += 1) {
      await kit.pushData({
        wikiId, path: 'about.foo', payload: day, ts: `2026-01-0${day}T00:00:00Z`, actor: agent
      })
    }

    const since = await kit.getData({ wikiId, path: 'about.foo', since: '2026-01-03T00:00:00Z' })
    since.map((row) => row.payload).should.deepEqual([3, 4, 5])

    const bounded = await kit.getData({
      wikiId, path: 'about.foo', since: '2026-01-02T00:00:00Z', until: '2026-01-04T00:00:00Z'
    })
    bounded.map((row) => row.payload).should.deepEqual([2, 3, 4])

    const capped = await kit.getData({ wikiId, path: 'about.foo', limit: 2 })
    capped.map((row) => row.payload).should.deepEqual([1, 2])
  })

  it('normalizes backfilled timestamps to canonical ISO form', async () => {
    const { kit } = await createTestKit()
    const { wikiId } = await seedAcme(kit)
    const datum = await kit.pushData({
      wikiId, path: 'about.foo', payload: 1, ts: '2026-08-01T02:00:00+02:00', actor: agent
    })
    datum.ts.should.equal('2026-08-01T00:00:00.000Z')
  })

  it('trims to the newest rows when metadata.data.retain.rows is set', async () => {
    const { kit } = await createTestKit()
    const { wikiId } = await seedAcme(kit)
    await kit.setNode({
      wikiId, path: 'about.foo', metadata: { data: { retain: { rows: 2 } } }, actor: human
    })
    for (let day = 1; day <= 4; day += 1) {
      await kit.pushData({
        wikiId, path: 'about.foo', payload: day, ts: `2026-01-0${day}T00:00:00Z`, actor: agent
      })
    }
    const rows = await kit.getData({ wikiId, path: 'about.foo' })
    rows.map((row) => row.payload).should.deepEqual([3, 4])
  })

  it('trims observations older than metadata.data.retain.days', async () => {
    const { kit } = await createTestKit()
    const { wikiId } = await seedAcme(kit)
    await kit.setNode({
      wikiId, path: 'about.foo', metadata: { data: { retain: { days: 30 } } }, actor: human
    })
    // An old backfilled observation is stored and reported, then trimmed
    // by the same push's retention pass.
    const stale = await kit.pushData({
      wikiId, path: 'about.foo', payload: 'old', ts: '2000-01-01T00:00:00Z', actor: agent
    })
    stale.payload.should.equal('old')
    const kept = await kit.pushData({ wikiId, path: 'about.foo', payload: 'new', actor: agent })
    const rows = await kit.getData({ wikiId, path: 'about.foo' })
    rows.map((row) => row.payload).should.deepEqual(['new'])
    kept.ts.should.equal(rows[0].ts)
  })

  it('ignores non-conforming retention policies instead of failing pushes', async () => {
    const { kit } = await createTestKit()
    const { wikiId } = await seedAcme(kit)
    await kit.setNode({
      wikiId, path: 'about.foo', metadata: { data: { retain: { rows: 'lots', days: -1 } } }, actor: human
    })
    await kit.pushData({ wikiId, path: 'about.foo', payload: 1, ts: '2000-01-01T00:00:00Z', actor: agent })
    await kit.pushData({ wikiId, path: 'about.foo', payload: 2, actor: agent })
    const rows = await kit.getData({ wikiId, path: 'about.foo' })
    rows.length.should.equal(2)
  })

  it('validates payloads, timestamps, and read options', async () => {
    const { kit } = await createTestKit()
    const { wikiId } = await seedAcme(kit)

    await kit.pushData({ wikiId, path: 'about.foo', actor: agent })
      .should.be.rejectedWith(ValidationError)
    const cyclic = {}
    cyclic.self = cyclic
    await kit.pushData({ wikiId, path: 'about.foo', payload: cyclic, actor: agent })
      .should.be.rejectedWith(ValidationError)
    await kit.pushData({ wikiId, path: 'about.foo', payload: 'x'.repeat(16385), actor: agent })
      .should.be.rejectedWith(ValidationError)
    await kit.pushData({ wikiId, path: 'about.foo', payload: 1, ts: 'yesterday', actor: agent })
      .should.be.rejectedWith(ValidationError)
    await kit.pushData({ wikiId, path: 'about.nope', payload: 1, actor: agent })
      .should.be.rejectedWith(NotFoundError)

    await kit.getData({ wikiId, path: 'about.foo', latest: true, limit: 5 })
      .should.be.rejectedWith(ValidationError)
    await kit.getData({ wikiId, path: 'about.foo', since: 'nope' })
      .should.be.rejectedWith(ValidationError)
    await kit.getData({ wikiId, path: 'about.foo', limit: 0 })
      .should.be.rejectedWith(ValidationError)
    await kit.getData({ wikiId, path: 'about.foo', limit: 10001 })
      .should.be.rejectedWith(ValidationError)
    await kit.getData({ wikiId, path: 'about.nope' })
      .should.be.rejectedWith(NotFoundError)
  })

  it('never lets a push conflict with a conditional content edit', async () => {
    const { kit } = await createTestKit()
    const { wikiId } = await seedAcme(kit)
    const page = await kit.getNode({ wikiId, path: 'about.foo' })
    await kit.pushData({ wikiId, path: 'about.foo', payload: 1, actor: agent })
    const result = await kit.setNode({
      wikiId, path: 'about.foo', content: 'edited after a push', expectedRevisionId: page.revisionId, actor: human
    })
    result.changed.should.be.true()
  })

  it('summarizes which pages carry observations, scoped to a subtree', async () => {
    const { kit } = await createTestKit()
    const { wikiId } = await seedAcme(kit)
    await kit.pushData({ wikiId, path: 'about.foo', payload: 1, ts: '2026-01-01T00:00:00Z', actor: agent })
    await kit.pushData({ wikiId, path: 'about.foo', payload: 2, ts: '2026-01-03T00:00:00Z', actor: agent })
    await kit.pushData({ wikiId, path: 'about.bar', payload: 3, ts: '2026-01-02T00:00:00Z', actor: agent })
    await kit.setNode({ wikiId, path: 'elsewhere', content: 'x', actor: human })
    await kit.pushData({ wikiId, path: 'elsewhere', payload: 4, actor: agent })

    // whole wiki from the root
    const all = await kit.getDataSummary({ wikiId, path: '' })
    all.map((entry) => [entry.path, entry.count]).should.deepEqual([
      ['about.bar', 1],
      ['about.foo', 2],
      ['elsewhere', 1]
    ])
    all[1].latestTs.should.equal('2026-01-03T00:00:00.000Z')

    // subtree scoping; pages without observations do not appear
    const scoped = await kit.getDataSummary({ wikiId, path: 'about' })
    scoped.map((entry) => entry.path).should.deepEqual(['about.bar', 'about.foo'])

    await kit.getDataSummary({ wikiId, path: 'about.nope' })
      .should.be.rejectedWith(NotFoundError)
  })

  it('keeps summaries true across moves and deletions', async () => {
    const { kit } = await createTestKit()
    const { wikiId } = await seedAcme(kit)
    await kit.pushData({ wikiId, path: 'about.foo', payload: 1, actor: agent })
    await kit.pushData({ wikiId, path: 'about.baz', payload: 2, actor: agent })

    await kit.moveNode({ wikiId, fromPath: 'about.foo', toPath: 'about.renamed', actor: human })
    await kit.deleteNode({ wikiId, path: 'about.baz', actor: human })

    const summary = await kit.getDataSummary({ wikiId, path: '' })
    summary.map((entry) => entry.path).should.deepEqual(['about.renamed'])
  })

  it('keeps data attached across moves and drops it with deletion', async () => {
    const { kit } = await createTestKit()
    const { wikiId } = await seedAcme(kit)
    await kit.pushData({ wikiId, path: 'about.foo', payload: 'sticky', actor: agent })
    await kit.moveNode({ wikiId, fromPath: 'about.foo', toPath: 'about.renamed', actor: human })
    const rows = await kit.getData({ wikiId, path: 'about.renamed' })
    rows.map((row) => row.payload).should.deepEqual(['sticky'])

    await kit.pushData({ wikiId, path: 'about.baz', payload: 'doomed', actor: agent })
    await kit.deleteNode({ wikiId, path: 'about.baz', actor: human })
    await kit.getData({ wikiId, path: 'about.baz' })
      .should.be.rejectedWith(NotFoundError)
    // Recreating the path makes a fresh page with an empty channel.
    await kit.setNode({ wikiId, path: 'about.baz', content: 'reborn', actor: human })
    const reborn = await kit.getData({ wikiId, path: 'about.baz' })
    reborn.should.deepEqual([])
  })
})
