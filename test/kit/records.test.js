import should from 'should'
import { randomUUID } from 'node:crypto'
import {
  ValidationError,
  NotFoundError,
  RevisionConflictError,
  RecordsUnavailableError
} from '../../lib/kit/index.js'
import { openRecordStore } from '../../lib/api/index.js'
import { createTestKit, seedAcme, human, agent, commitCount, revisionCount } from './helpers.js'
import { startDynoxide, uniqueTable } from '../dynoxide.js'

describe('records', () => {
  let dynoxide

  before(async () => {
    dynoxide = await startDynoxide()
  })

  after(() => {
    dynoxide.stop()
  })

  async function createRecordsKit () {
    const records = openRecordStore({ endpoint: dynoxide.endpoint, table: uniqueTable() })
    return createTestKit({ records })
  }

  describe('unkeyed pages (append)', () => {
    it('appends a record without creating a commit or revision', async () => {
      const { kit, db } = await createRecordsKit()
      const { wikiId } = await seedAcme(kit)
      const before = commitCount(db, wikiId)
      const page = await kit.getNode({ wikiId, path: 'about.foo' })

      const record = await kit.putRecord({
        wikiId, path: 'about.foo', value: { requests: 1042 }, actor: agent
      })
      record.requests.should.equal(1042)
      record._actor.should.deepEqual({ type: 'agent', id: 'agent_test', onBehalfOf: 'user_test' })
      record._ts.should.be.a.String()
      record._v.should.equal(1)
      record._id.should.startWith(record._ts)

      commitCount(db, wikiId).should.equal(before)
      revisionCount(db, page.id).should.equal(1)
    })

    it('reads ascending by time; latest returns only the newest', async () => {
      const { kit } = await createRecordsKit()
      const { wikiId } = await seedAcme(kit)
      await kit.putRecord({ wikiId, path: 'about.foo', value: { n: 2 }, ts: '2026-01-02T00:00:00Z', actor: agent })
      await kit.putRecord({ wikiId, path: 'about.foo', value: { n: 3 }, ts: '2026-01-03T00:00:00Z', actor: agent })
      await kit.putRecord({ wikiId, path: 'about.foo', value: { n: 1 }, ts: '2026-01-01T00:00:00Z', actor: agent })

      const { records } = await kit.getRecords({ wikiId, path: 'about.foo' })
      records.map((record) => record.n).should.deepEqual([1, 2, 3])

      const latest = await kit.getRecords({ wikiId, path: 'about.foo', latest: true })
      latest.records.length.should.equal(1)
      latest.records[0].n.should.equal(3)

      const empty = await kit.getRecords({ wikiId, path: 'about.bar', latest: true })
      empty.records.should.deepEqual([])
    })

    it('bounds ranges with since/until, caps with limit, continues with cursor', async () => {
      const { kit } = await createRecordsKit()
      const { wikiId } = await seedAcme(kit)
      for (let day = 1; day <= 5; day += 1) {
        await kit.putRecord({
          wikiId, path: 'about.foo', value: { day }, ts: `2026-01-0${day}T00:00:00Z`, actor: agent
        })
      }

      const bounded = await kit.getRecords({
        wikiId, path: 'about.foo', since: '2026-01-02T00:00:00Z', until: '2026-01-04T00:00:00Z'
      })
      bounded.records.map((record) => record.day).should.deepEqual([2, 3, 4])

      const first = await kit.getRecords({ wikiId, path: 'about.foo', limit: 2 })
      first.records.map((record) => record.day).should.deepEqual([1, 2])
      should(first.cursor).be.a.String()

      const rest = await kit.getRecords({ wikiId, path: 'about.foo', cursor: first.cursor })
      rest.records.map((record) => record.day).should.deepEqual([3, 4, 5])
      should(rest.cursor).be.undefined()

      // a limit the records meet exactly reports no continuation
      const exact = await kit.getRecords({ wikiId, path: 'about.foo', cursor: first.cursor, limit: 3 })
      exact.records.map((record) => record.day).should.deepEqual([3, 4, 5])
      should(exact.cursor).be.undefined()
    })

    it('reads in reverse — newest first — and pages on from there', async () => {
      const { kit } = await createRecordsKit()
      const { wikiId } = await seedAcme(kit)
      for (let day = 1; day <= 5; day += 1) {
        await kit.putRecord({
          wikiId, path: 'about.foo', value: { day }, ts: `2026-01-0${day}T00:00:00Z`, actor: agent
        })
      }

      const first = await kit.getRecords({ wikiId, path: 'about.foo', reverse: true, limit: 2 })
      first.records.map((record) => record.day).should.deepEqual([5, 4])
      should(first.cursor).be.a.String()

      const rest = await kit.getRecords({ wikiId, path: 'about.foo', reverse: true, cursor: first.cursor })
      rest.records.map((record) => record.day).should.deepEqual([3, 2, 1])
      should(rest.cursor).be.undefined()

      const bounded = await kit.getRecords({
        wikiId, path: 'about.foo', reverse: true, since: '2026-01-02T00:00:00Z', until: '2026-01-04T00:00:00Z'
      })
      bounded.records.map((record) => record.day).should.deepEqual([4, 3, 2])

      await kit.getRecords({ wikiId, path: 'about.foo', latest: true, reverse: true })
        .should.be.rejectedWith(ValidationError)
      await kit.getRecords({ wikiId, path: 'about.foo', reverse: 'yes' })
        .should.be.rejectedWith(ValidationError)
    })

    it('normalizes backfilled timestamps to canonical ISO form', async () => {
      const { kit } = await createRecordsKit()
      const { wikiId } = await seedAcme(kit)
      const record = await kit.putRecord({
        wikiId, path: 'about.foo', value: { n: 1 }, ts: '2026-01-01T05:00:00+05:00', actor: agent
      })
      record._ts.should.equal('2026-01-01T00:00:00.000Z')
    })

    it('stamps an expiry from metadata.retain.days', async () => {
      const { kit } = await createRecordsKit()
      const { wikiId } = await seedAcme(kit)
      await kit.setNode({
        wikiId, path: 'usage', content: '', metadata: { retain: { days: 30 } }, actor: human
      })
      const ts = '2026-01-01T00:00:00Z'
      const record = await kit.putRecord({ wikiId, path: 'usage', value: { n: 1 }, ts, actor: agent })
      record._expires.should.equal(Math.floor(Date.parse(ts) / 1000) + 30 * 86400)

      // Non-conforming policies read as absent rather than failing.
      await kit.setNode({ wikiId, path: 'usage', content: '', metadata: { retain: 'junk' }, actor: human })
      const unexpiring = await kit.putRecord({ wikiId, path: 'usage', value: { n: 2 }, actor: agent })
      should(unexpiring._expires).be.undefined()
    })

    it('rejects ifVersion on an unkeyed page', async () => {
      const { kit } = await createRecordsKit()
      const { wikiId } = await seedAcme(kit)
      await kit.putRecord({ wikiId, path: 'about.foo', value: { n: 1 }, ifVersion: 1, actor: agent })
        .should.be.rejectedWith(ValidationError)
    })
  })

  describe('keyed pages (upsert)', () => {
    async function seedTasks (kit, wikiId) {
      await kit.setNode({
        wikiId, path: 'tasks', content: '', metadata: { key: 'id' }, actor: human
      })
    }

    it('upserts by the key field, moving the version', async () => {
      const { kit } = await createRecordsKit()
      const { wikiId } = await seedAcme(kit)
      await seedTasks(kit, wikiId)

      const first = await kit.putRecord({
        wikiId, path: 'tasks', value: { id: 't-1', status: 'todo' }, actor: agent
      })
      first._id.should.equal('t-1')
      first._v.should.equal(1)

      const second = await kit.putRecord({
        wikiId, path: 'tasks', value: { id: 't-1', status: 'done' }, actor: agent
      })
      second._v.should.equal(2)

      // The record is replaced whole, like content.
      const read = await kit.getRecords({ wikiId, path: 'tasks', key: 't-1' })
      read.record.status.should.equal('done')
      read.record._v.should.equal(2)
    })

    it('reads one record by key and combines key with nothing else', async () => {
      const { kit } = await createRecordsKit()
      const { wikiId } = await seedAcme(kit)
      await seedTasks(kit, wikiId)
      await kit.putRecord({ wikiId, path: 'tasks', value: { id: 't-1' }, actor: agent })

      const { record } = await kit.getRecords({ wikiId, path: 'tasks', key: 't-1' })
      record._id.should.equal('t-1')

      await kit.getRecords({ wikiId, path: 'tasks', key: 'nope' })
        .should.be.rejectedWith(NotFoundError)
      await kit.getRecords({ wikiId, path: 'tasks', key: 't-1', latest: true })
        .should.be.rejectedWith(ValidationError)
      await kit.getRecords({ wikiId, path: 'tasks', key: 't-1', limit: 5 })
        .should.be.rejectedWith(ValidationError)
    })

    it('makes ifVersion a compare-and-swap with one winner', async () => {
      const { kit } = await createRecordsKit()
      const { wikiId } = await seedAcme(kit)
      await seedTasks(kit, wikiId)
      await kit.putRecord({ wikiId, path: 'tasks', value: { id: 't-1', status: 'todo' }, actor: agent })

      const winner = await kit.putRecord({
        wikiId, path: 'tasks', value: { id: 't-1', status: 'claimed', by: 'a' }, ifVersion: 1, actor: agent
      })
      winner._v.should.equal(2)

      await kit.putRecord({
        wikiId, path: 'tasks', value: { id: 't-1', status: 'claimed', by: 'b' }, ifVersion: 1, actor: agent
      }).should.be.rejectedWith(RevisionConflictError)

      const { record } = await kit.getRecords({ wikiId, path: 'tasks', key: 't-1' })
      record.by.should.equal('a')
    })

    it('requires the key field and refuses ts', async () => {
      const { kit } = await createRecordsKit()
      const { wikiId } = await seedAcme(kit)
      await seedTasks(kit, wikiId)

      await kit.putRecord({ wikiId, path: 'tasks', value: { status: 'todo' }, actor: agent })
        .should.be.rejectedWith(ValidationError)
      await kit.putRecord({ wikiId, path: 'tasks', value: { id: '' }, actor: agent })
        .should.be.rejectedWith(ValidationError)
      await kit.putRecord({
        wikiId, path: 'tasks', value: { id: 't-1' }, ts: '2026-01-01T00:00:00Z', actor: agent
      }).should.be.rejectedWith(ValidationError)

      // Numeric keys address as their string form.
      const numeric = await kit.putRecord({ wikiId, path: 'tasks', value: { id: 41 }, actor: agent })
      numeric._id.should.equal('41')
    })

    it('deletes one record by key and returns it', async () => {
      const { kit } = await createRecordsKit()
      const { wikiId } = await seedAcme(kit)
      await seedTasks(kit, wikiId)
      await kit.putRecord({ wikiId, path: 'tasks', value: { id: 't-1', status: 'todo' }, actor: agent })

      const { record } = await kit.deleteRecord({ wikiId, path: 'tasks', key: 't-1', actor: human })
      record.status.should.equal('todo')

      await kit.getRecords({ wikiId, path: 'tasks', key: 't-1' })
        .should.be.rejectedWith(NotFoundError)
      await kit.deleteRecord({ wikiId, path: 'tasks', key: 't-1', actor: human })
        .should.be.rejectedWith(NotFoundError)
    })

    it('deletes an unkeyed record by its _id stamp', async () => {
      const { kit } = await createRecordsKit()
      const { wikiId } = await seedAcme(kit)
      const record = await kit.putRecord({ wikiId, path: 'about.foo', value: { n: 1 }, actor: agent })
      await kit.deleteRecord({ wikiId, path: 'about.foo', key: record._id, actor: human })
      const { records } = await kit.getRecords({ wikiId, path: 'about.foo' })
      records.should.deepEqual([])
    })
  })

  describe('record summary', () => {
    it('tells the tree how many records a page carries and the latest stamp', async () => {
      const { kit } = await createRecordsKit()
      const { wikiId } = await seedAcme(kit)
      await kit.setNode({ wikiId, path: 'about.tasks', content: 'tasks', metadata: { key: 'id' }, actor: agent })

      const summaryOf = async (path) => {
        const tree = await kit.getTree({ wikiId, path: '' })
        const find = (node) => (node.path === path ? node : node.children.map(find).find(Boolean))
        return find(tree).records
      }

      // nothing yet: null, not zero
      should(await summaryOf('about.foo')).be.null()

      await kit.putRecord({ wikiId, path: 'about.foo', value: { n: 1 }, ts: '2026-01-02T00:00:00Z', actor: agent })
      await kit.putRecord({ wikiId, path: 'about.foo', value: { n: 2 }, ts: '2026-01-01T00:00:00Z', actor: agent })
      ;(await summaryOf('about.foo')).should.deepEqual({ count: 2, latestTs: '2026-01-02T00:00:00.000Z' })

      // a keyed page counts keys, not writes
      await kit.putRecord({ wikiId, path: 'about.tasks', value: { id: 't-1', s: 'open' }, actor: agent })
      await kit.putRecord({ wikiId, path: 'about.tasks', value: { id: 't-1', s: 'done' }, actor: agent })
      await kit.putRecord({ wikiId, path: 'about.tasks', value: { id: 't-2', s: 'open' }, actor: agent, ifVersion: undefined })
      ;(await summaryOf('about.tasks')).count.should.equal(2)
      const versioned = await kit.getRecords({ wikiId, path: 'about.tasks', key: 't-2' })
      await kit.putRecord({ wikiId, path: 'about.tasks', value: { id: 't-2', s: 'done' }, actor: agent, ifVersion: versioned.record._v })
      ;(await summaryOf('about.tasks')).count.should.equal(2)

      // deletion counts down; history carries no summary
      await kit.deleteRecord({ wikiId, path: 'about.tasks', key: 't-1', actor: agent })
      ;(await summaryOf('about.tasks')).count.should.equal(1)
      const past = await kit.getTree({ wikiId, path: '', commitId: 1 })
      should(past.records).be.undefined()
    })

    it('builds the summary for an existing store on migrate, once', async () => {
      const { kit, db } = await createRecordsKit()
      const { wikiId } = await seedAcme(kit)
      await kit.putRecord({ wikiId, path: 'about.foo', value: { n: 1 }, ts: '2026-01-01T00:00:00Z', actor: agent })
      await kit.putRecord({ wikiId, path: 'about.foo', value: { n: 2 }, ts: '2026-01-02T00:00:00Z', actor: agent })
      await kit.putRecord({ wikiId, path: 'about', value: { n: 3 }, ts: '2026-01-03T00:00:00Z', actor: agent })

      // an upgrade finds records but no projection
      db.prepare('DELETE FROM node_records').run()
      await kit.migrate()
      const rows = db.prepare('SELECT count, latest_ts FROM node_records ORDER BY count').all()
      rows.should.deepEqual([
        { count: 1, latest_ts: '2026-01-03T00:00:00.000Z' },
        { count: 2, latest_ts: '2026-01-02T00:00:00.000Z' }
      ])

      // a populated projection is not rebuilt
      db.prepare('UPDATE node_records SET count = 7').run()
      await kit.migrate()
      db.prepare('SELECT MIN(count) AS c FROM node_records').get().c.should.equal(7)
    })

    it('reports when a wiki last changed and by whom, with own changes set aside', async () => {
      const { kit } = await createRecordsKit()
      const { wikiId } = await seedAcme(kit)
      const seeded = await kit.getWikiActivity({ wikiId })
      seeded.authored.actor.id.should.equal(human.id)
      should(seeded.recorded).be.null()
      seeded.at.should.equal(seeded.authored.at)

      const other = { type: 'agent', id: 'agent_other', onBehalfOf: null }
      await kit.putRecord({ wikiId, path: 'about.foo', value: { n: 1 }, actor: other })
      const afterPut = await kit.getWikiActivity({ wikiId })
      afterPut.recorded.actor.id.should.equal(other.id)
      afterPut.at.should.equal(afterPut.recorded.at)
      afterPut.othersAt.should.equal(afterPut.at)

      // one's own writes are not news to oneself; everyone else's still are
      const forOther = await kit.getWikiActivity({ wikiId, except: other.id })
      forOther.othersAt.should.equal(seeded.authored.at)
      const forHuman = await kit.getWikiActivity({ wikiId, except: human.id })
      forHuman.othersAt.should.equal(afterPut.recorded.at)

      // work done on someone's behalf is theirs too (the test agent acts for the human)
      await kit.setNode({ wikiId, path: 'about.bar', content: 'bar', actor: agent })
      await kit.putRecord({ wikiId, path: 'about.bar', value: { n: 2 }, actor: agent })
      const stillForHuman = await kit.getWikiActivity({ wikiId, except: human.id })
      stillForHuman.othersAt.should.equal(afterPut.recorded.at)
      const latest = await kit.getWikiActivity({ wikiId })
      latest.at.should.be.above(afterPut.at)

      await kit.getWikiActivity({ wikiId: 'nope' }).should.be.rejectedWith(NotFoundError)

      // reading is not activity: a full read re-syncs the summary but moves nothing,
      // and a read of a page with no records leaves no trace at all
      const before = await kit.getWikiActivity({ wikiId })
      await kit.getRecords({ wikiId, path: 'about.foo' })
      await kit.getRecords({ wikiId, path: 'about' })
      const afterRead = await kit.getWikiActivity({ wikiId })
      afterRead.should.deepEqual(before)
      const tree = await kit.getTree({ wikiId, path: '' })
      should(tree.children.find((node) => node.path === 'about').records).be.null()
    })

    it('counts the week’s commits, by day, and the people behind them', async () => {
      const { kit } = await createRecordsKit()
      const { wikiId } = await seedAcme(kit)
      const seeded = await kit.getWikiActivity({ wikiId })
      seeded.commits.week.should.be.above(0)
      seeded.commits.day.should.equal(seeded.commits.week)
      seeded.commits.days.should.have.length(7)
      seeded.commits.days[6].should.equal(seeded.commits.week)
      seeded.commits.days.slice(0, 6).should.deepEqual([0, 0, 0, 0, 0, 0])
      seeded.people.week.should.equal(1)

      // the agent acts for the human: still one person; a stranger makes two
      await kit.setNode({ wikiId, path: 'about.bar', content: 'bar', actor: agent })
      const other = { type: 'agent', id: 'agent_other', onBehalfOf: null }
      await kit.setNode({ wikiId, path: 'about.baz', content: 'baz', actor: other })
      const later = await kit.getWikiActivity({ wikiId })
      later.commits.week.should.equal(seeded.commits.week + 2)
      later.people.week.should.equal(2)

      // records are stamped, not committed: a put moves nothing here
      await kit.putRecord({ wikiId, path: 'about.foo', value: { n: 1 }, actor: other })
      const afterPut = await kit.getWikiActivity({ wikiId })
      afterPut.commits.should.deepEqual(later.commits)
    })

    it('never counts a summary row without a writer as someone else’s activity', async () => {
      const { kit, db } = await createRecordsKit()
      const { wikiId } = await seedAcme(kit)
      await kit.putRecord({ wikiId, path: 'about.foo', value: { n: 1 }, actor: agent })
      db.prepare('UPDATE node_records SET last_actor = NULL').run()
      // the human's own commits and a record of unknown authorship: nothing is news to the human
      const activity = await kit.getWikiActivity({ wikiId, except: human.id })
      should(activity.recorded).not.be.null()
      should(activity.othersAt).be.null()
      // to anyone else, the human's commits still are
      const other = await kit.getWikiActivity({ wikiId, except: 'someone_else' })
      other.othersAt.should.equal(other.authored.at)
    })

    it('learns write times and writers for rows that predate them, on migrate', async () => {
      const { kit, db } = await createRecordsKit()
      const { wikiId } = await seedAcme(kit)
      const other = { type: 'agent', id: 'agent_other', onBehalfOf: null }
      await kit.putRecord({ wikiId, path: 'about.foo', value: { n: 1 }, ts: '2026-01-01T00:00:00Z', actor: agent })
      await kit.putRecord({ wikiId, path: 'about.foo', value: { n: 2 }, ts: '2026-01-02T00:00:00Z', actor: other })
      // as an upgraded store looks: summary rows without the newer columns
      db.prepare('UPDATE node_records SET written_at = NULL, last_actor = NULL').run()
      should((await kit.getWikiActivity({ wikiId })).recorded).be.null()

      await kit.migrate()
      const activity = await kit.getWikiActivity({ wikiId })
      activity.recorded.at.should.equal('2026-01-02T00:00:00.000Z')
      activity.recorded.actor.id.should.equal(other.id)
    })

    it('re-syncs the summary from a full read', async () => {
      const { kit, db } = await createRecordsKit()
      const { wikiId } = await seedAcme(kit)
      await kit.putRecord({ wikiId, path: 'about.foo', value: { n: 1 }, actor: agent })
      await kit.putRecord({ wikiId, path: 'about.foo', value: { n: 2 }, actor: agent })
      // drift, as retention expiry in the store would cause
      db.prepare('UPDATE node_records SET count = 9').run()

      // a bounded read is not the whole truth
      await kit.getRecords({ wikiId, path: 'about.foo', limit: 1 })
      db.prepare('SELECT count FROM node_records').get().count.should.equal(9)

      // a full read is
      await kit.getRecords({ wikiId, path: 'about.foo' })
      db.prepare('SELECT count FROM node_records').get().count.should.equal(2)
    })
  })

  describe('schema enforcement', () => {
    it('validates records against metadata.schema on put', async () => {
      const { kit } = await createRecordsKit()
      const { wikiId } = await seedAcme(kit)
      await kit.setNode({
        wikiId,
        path: 'leads',
        content: '',
        metadata: {
          key: 'email',
          schema: {
            type: 'object',
            required: ['email', 'status'],
            properties: {
              email: { type: 'string' },
              status: { enum: ['new', 'active', 'closed'] }
            }
          }
        },
        actor: human
      })

      const good = await kit.putRecord({
        wikiId, path: 'leads', value: { email: 'a@b.co', status: 'new' }, actor: agent
      })
      good._id.should.equal('a@b.co')

      await kit.putRecord({
        wikiId, path: 'leads', value: { email: 'a@b.co', status: 'bogus' }, actor: agent
      }).should.be.rejectedWith(ValidationError, { message: /schema/ })
      await kit.putRecord({
        wikiId, path: 'leads', value: { email: 'a@b.co' }, actor: agent
      }).should.be.rejectedWith(ValidationError)
    })

    it('reports a schema that does not compile instead of writing', async () => {
      const { kit } = await createRecordsKit()
      const { wikiId } = await seedAcme(kit)
      await kit.setNode({
        wikiId, path: 'bad', content: '', metadata: { schema: { type: 'nonsense' } }, actor: human
      })
      await kit.putRecord({ wikiId, path: 'bad', value: { n: 1 }, actor: agent })
        .should.be.rejectedWith(ValidationError, { message: /does not compile/ })
    })
  })

  describe('record and read validation', () => {
    it('rejects non-object records and reserved field names', async () => {
      const { kit } = await createRecordsKit()
      const { wikiId } = await seedAcme(kit)
      for (const value of [42, 'text', [1], null, undefined]) {
        await kit.putRecord({ wikiId, path: 'about.foo', value, actor: agent })
          .should.be.rejectedWith(ValidationError)
      }
      for (const value of [{ _v: 2 }, { _custom: 1 }, { pk: 'x' }, { sk: 'y' }]) {
        await kit.putRecord({ wikiId, path: 'about.foo', value, actor: agent })
          .should.be.rejectedWith(ValidationError)
      }
    })

    it('validates timestamps, limits, and cursors', async () => {
      const { kit } = await createRecordsKit()
      const { wikiId } = await seedAcme(kit)
      await kit.putRecord({ wikiId, path: 'about.foo', value: { n: 1 }, ts: 'yesterday', actor: agent })
        .should.be.rejectedWith(ValidationError)
      await kit.getRecords({ wikiId, path: 'about.foo', latest: true, limit: 5 })
        .should.be.rejectedWith(ValidationError)
      await kit.getRecords({ wikiId, path: 'about.foo', limit: 0 })
        .should.be.rejectedWith(ValidationError)
      await kit.getRecords({ wikiId, path: 'about.foo', cursor: '%%%' })
        .should.be.rejectedWith(ValidationError)
      await kit.putRecord({ wikiId, path: 'nope', value: { n: 1 }, actor: agent })
        .should.be.rejectedWith(NotFoundError)
    })

    it('refuses record operations when no store is configured', async () => {
      const { kit } = await createTestKit()
      const { wikiId } = await seedAcme(kit)
      await kit.putRecord({ wikiId, path: 'about.foo', value: { n: 1 }, actor: agent })
        .should.be.rejectedWith(RecordsUnavailableError)
      await kit.getRecords({ wikiId, path: 'about.foo' })
        .should.be.rejectedWith(RecordsUnavailableError)
      await kit.deleteRecord({ wikiId, path: 'about.foo', key: 'x', actor: human })
        .should.be.rejectedWith(RecordsUnavailableError)
    })
  })

  describe('records and the authored plane', () => {
    it('never lets a put conflict with a conditional content edit', async () => {
      const { kit } = await createRecordsKit()
      const { wikiId } = await seedAcme(kit)
      const page = await kit.getNode({ wikiId, path: 'about.foo' })
      await kit.putRecord({ wikiId, path: 'about.foo', value: { n: 1 }, actor: agent })
      const result = await kit.setNode({
        wikiId, path: 'about.foo', content: 'edited', expectedRevisionId: page.revisionId, actor: human
      })
      result.changed.should.be.true()
    })

    it('keeps records attached across moves', async () => {
      const { kit } = await createRecordsKit()
      const { wikiId } = await seedAcme(kit)
      await kit.putRecord({ wikiId, path: 'about.foo', value: { n: 1 }, actor: agent })
      await kit.moveNode({ wikiId, fromPath: 'about.foo', toPath: 'about.bar.foo', actor: human })
      const { records } = await kit.getRecords({ wikiId, path: 'about.bar.foo' })
      records.length.should.equal(1)
    })

    it('drains the legacy data channel into the record store on migrate', async () => {
      const records = openRecordStore({ endpoint: dynoxide.endpoint, table: uniqueTable() })
      const { kit, db } = await createTestKit({ records })
      const { wikiId } = await seedAcme(kit)
      const page = await kit.getNode({ wikiId, path: 'about.foo' })
      const insert = db.prepare(`
        INSERT INTO node_data
          (id, wiki_id, node_id, ts, actor_type, actor_id, actor_on_behalf_of, payload, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      insert.run(randomUUID(), wikiId, page.id, '2026-01-01T00:00:00.000Z', 'agent', 'meter', null, '{"requests":7}', '2026-01-01T00:00:00.000Z')
      insert.run(randomUUID(), wikiId, page.id, '2026-01-02T00:00:00.000Z', 'agent', 'meter', null, '42', '2026-01-02T00:00:00.000Z')

      await kit.migrate()
      await kit.migrate() // idempotent

      const { records: drained } = await kit.getRecords({ wikiId, path: 'about.foo' })
      drained.length.should.equal(2)
      drained[0].requests.should.equal(7)
      drained[1].value.should.equal(42) // non-object payloads wrap
      drained[0]._actor.id.should.equal('meter')
      db.prepare('SELECT COUNT(*) AS n FROM node_data').get().n.should.equal(0)
    })
  })

  describe('mergeMetadata', () => {
    it('merges fields, removes nulls, and commits like any authored change', async () => {
      const { kit, db } = await createRecordsKit()
      const { wikiId } = await seedAcme(kit)
      await kit.setNode({
        wikiId, path: 'about.foo', content: 'body', metadata: { type: 'markdown', order: 3 }, actor: human
      })
      const before = commitCount(db, wikiId)

      const merged = await kit.mergeMetadata({
        wikiId, path: 'about.foo', metadata: { key: 'id', order: null }, actor: human, message: 'declare key'
      })
      merged.changed.should.be.true()
      merged.node.metadata.should.deepEqual({ type: 'markdown', key: 'id' })
      merged.node.content.should.equal('body')
      commitCount(db, wikiId).should.equal(before + 1)

      const replaced = await kit.mergeMetadata({
        wikiId, path: 'about.foo', metadata: { retain: { days: 7 } }, replace: true, actor: human
      })
      replaced.node.metadata.should.deepEqual({ retain: { days: 7 } })

      const unchanged = await kit.mergeMetadata({
        wikiId, path: 'about.foo', metadata: { retain: { days: 7 } }, actor: human
      })
      unchanged.changed.should.be.false()
    })

    it('honors expectedRevisionId and requires metadata', async () => {
      const { kit } = await createRecordsKit()
      const { wikiId } = await seedAcme(kit)
      await kit.mergeMetadata({
        wikiId, path: 'about.foo', metadata: { key: 'id' }, expectedRevisionId: 'stale', actor: human
      }).should.be.rejectedWith(RevisionConflictError)
      await kit.mergeMetadata({ wikiId, path: 'about.foo', actor: human })
        .should.be.rejectedWith(ValidationError)
      await kit.mergeMetadata({ wikiId, path: 'nope', metadata: {}, actor: human })
        .should.be.rejectedWith(NotFoundError)
    })
  })
})
