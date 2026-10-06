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
    it('stamps the org a writer acted from, on the record and the page summary', async () => {
      const { kit } = await createRecordsKit()
      const { wikiId } = await seedAcme(kit)
      const guest = { type: 'human', id: 'user_guest', onBehalfOf: null, org: 'org_guest', via: 'web' }
      const record = await kit.putRecord({ wikiId, path: 'about.foo', value: { n: 1 }, actor: guest })
      record._actor.should.deepEqual({ type: 'human', id: 'user_guest', onBehalfOf: null, org: 'org_guest' })
      const activity = await kit.getWikiActivity({ wikiId })
      activity.recorded.actor.org.should.equal('org_guest')
    })

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

    it('counts commits since a moment, setting one actor’s own work aside', async () => {
      const { kit } = await createRecordsKit()
      const { wikiId } = await seedAcme(kit)
      const all = await kit.countCommits({ wikiId })
      all.should.be.above(0)
      const mark = new Date().toISOString()
      await new Promise((resolve) => setTimeout(resolve, 5))
      const other = { type: 'agent', id: 'agent_other', onBehalfOf: null }
      await kit.setNode({ wikiId, path: 'about.bar', content: 'bar', actor: agent }) // for the human
      await kit.setNode({ wikiId, path: 'about.baz', content: 'baz', actor: other })
      ;(await kit.countCommits({ wikiId })).should.equal(all + 2)
      ;(await kit.countCommits({ wikiId, since: mark })).should.equal(2)
      // the human's own work — the agent acted for them — is not news to the human
      ;(await kit.countCommits({ wikiId, since: mark, except: human.id })).should.equal(1)
      ;(await kit.countCommits({ wikiId, since: mark, except: other.id })).should.equal(1)
      ;(await kit.countCommits({ wikiId, since: new Date().toISOString() })).should.equal(0)
      await kit.countCommits({ wikiId, since: 'yesterday' }).should.be.rejectedWith(ValidationError)
      await kit.countCommits({ wikiId: 'nope' }).should.be.rejectedWith(NotFoundError)
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

  describe('record history', () => {
    async function createHistoryKit () {
      const records = openRecordStore({ endpoint: dynoxide.endpoint, table: uniqueTable() })
      const { kit, db } = await createTestKit({ records })
      const { wikiId } = await seedAcme(kit)
      await kit.setNode({ wikiId, path: 'tasks', content: '', metadata: { key: 'id' }, actor: human })
      return { kit, db, records, wikiId }
    }

    const put = (kit, wikiId, value, options = {}) =>
      kit.putRecord({ wikiId, path: 'tasks', value, actor: agent, ...options })

    it('keeps every version of a keyed record, newest first, beside the record', async () => {
      const { kit, wikiId } = await createHistoryKit()
      await put(kit, wikiId, { id: 't-1', status: 'todo' })
      await put(kit, wikiId, { id: 't-1', status: 'doing' }, { actor: human })
      await put(kit, wikiId, { id: 't-1', status: 'done' })

      const { versions, cursor } = await kit.getRecordHistory({ wikiId, path: 'tasks', key: 't-1' })
      should(cursor).be.undefined()
      versions.map((version) => [version._v, version._change, version.status]).should.deepEqual([
        [3, 'updated', 'done'],
        [2, 'updated', 'doing'],
        [1, 'created', 'todo']
      ])
      versions[0]._id.should.equal('t-1')
      versions[1]._actor.should.deepEqual({ type: 'human', id: 'user_test', onBehalfOf: null })
      versions[0]._ts.should.be.a.String()

      // The page reads its records as before: one record, no versions.
      const { records } = await kit.getRecords({ wikiId, path: 'tasks' })
      records.length.should.equal(1)
      records[0].should.not.have.property('_change')
      const tree = await kit.getTree({ wikiId, path: 'tasks' })
      tree.records.count.should.equal(1)
    })

    it('reads a version with the one before it, the pair a diff reads', async () => {
      const { kit, wikiId } = await createHistoryKit()
      await put(kit, wikiId, { id: 't-1', status: 'todo' })
      await put(kit, wikiId, { id: 't-1', status: 'done' })

      const second = await kit.getRecordVersion({ wikiId, path: 'tasks', key: 't-1', version: 2 })
      second.version.status.should.equal('done')
      second.previous.status.should.equal('todo')
      second.previous._v.should.equal(1)

      const first = await kit.getRecordVersion({ wikiId, path: 'tasks', key: 't-1', version: 1 })
      should(first.previous).be.null()

      await kit.getRecordVersion({ wikiId, path: 'tasks', key: 't-1', version: 3 })
        .should.be.rejectedWith(NotFoundError)
      await kit.getRecordVersion({ wikiId, path: 'tasks', key: 't-1', version: 0 })
        .should.be.rejectedWith(ValidationError)
    })

    it('restores a version by writing it back — a new version, not a rewind', async () => {
      const { kit, wikiId } = await createHistoryKit()
      await put(kit, wikiId, { id: 't-1', status: 'todo', owner: 'a' })
      await put(kit, wikiId, { id: 't-1', status: 'done' })

      const { version } = await kit.getRecordVersion({ wikiId, path: 'tasks', key: 't-1', version: 1 })
      const { _id, _v, _ts, _actor, _change, ...value } = version
      const restored = await put(kit, wikiId, value, { ifVersion: 2 })
      restored._v.should.equal(3)
      restored.owner.should.equal('a')

      const { versions } = await kit.getRecordHistory({ wikiId, path: 'tasks', key: 't-1' })
      versions.map((entry) => entry.status).should.deepEqual(['todo', 'done', 'todo'])
    })

    it('keeps a deletion as a version; a record written again continues its history', async () => {
      const { kit, wikiId } = await createHistoryKit()
      await put(kit, wikiId, { id: 't-1', status: 'todo' })
      await put(kit, wikiId, { id: 't-1', status: 'done' })
      await kit.deleteRecord({ wikiId, path: 'tasks', key: 't-1', actor: human })

      const gone = await kit.getRecordHistory({ wikiId, path: 'tasks', key: 't-1' })
      gone.versions[0].should.have.properties({ _v: 3, _change: 'deleted' })
      gone.versions[0].should.not.have.property('status')
      gone.versions[0]._actor.id.should.equal('user_test')

      const again = await put(kit, wikiId, { id: 't-1', status: 'reopened' })
      again._v.should.equal(4)
      const { versions } = await kit.getRecordHistory({ wikiId, path: 'tasks', key: 't-1' })
      versions.map((version) => version._change).should.deepEqual(['created', 'deleted', 'updated', 'created'])
    })

    it('keeps nothing from a write that loses its compare-and-swap', async () => {
      const { kit, wikiId } = await createHistoryKit()
      await put(kit, wikiId, { id: 't-1', status: 'todo' })
      await put(kit, wikiId, { id: 't-1', status: 'claimed', by: 'a' }, { ifVersion: 1 })
      await put(kit, wikiId, { id: 't-1', status: 'claimed', by: 'b' }, { ifVersion: 1 })
        .should.be.rejectedWith(RevisionConflictError)

      const { versions } = await kit.getRecordHistory({ wikiId, path: 'tasks', key: 't-1' })
      versions.map((version) => version.by ?? null).should.deepEqual(['a', null])
    })

    it('keeps one version per write when writers race', async () => {
      const { kit, wikiId } = await createHistoryKit()
      await put(kit, wikiId, { id: 't-1', n: 0 })
      const results = await Promise.allSettled(
        Array.from({ length: 6 }, (_, n) => put(kit, wikiId, { id: 't-1', n: n + 1 }))
      )
      const written = results.filter((result) => result.status === 'fulfilled').map((result) => result.value)
      const { versions } = await kit.getRecordHistory({ wikiId, path: 'tasks', key: 't-1' })
      // Every write that succeeded is exactly one version, and the
      // versions are dense.
      versions.length.should.equal(written.length + 1)
      versions.map((version) => version._v).should.deepEqual(
        Array.from({ length: versions.length }, (_, index) => versions.length - index)
      )
      const { record } = await kit.getRecords({ wikiId, path: 'tasks', key: 't-1' })
      record.n.should.equal(versions[0].n)
    })

    it('never mixes the histories of keys that share a prefix', async () => {
      const { kit, wikiId } = await createHistoryKit()
      await put(kit, wikiId, { id: 'a', n: 1 })
      await put(kit, wikiId, { id: 'a#5', n: 2 })
      await put(kit, wikiId, { id: 'a#0000000001', n: 3 })
      await put(kit, wikiId, { id: 'a b/ü', n: 4 })

      for (const [key, n] of [['a', 1], ['a#5', 2], ['a#0000000001', 3], ['a b/ü', 4]]) {
        const { versions } = await kit.getRecordHistory({ wikiId, path: 'tasks', key })
        versions.map((version) => [version._id, version.n]).should.deepEqual([[key, n]])
      }
    })

    it('pages a long history with limit and cursor', async () => {
      const { kit, wikiId } = await createHistoryKit()
      for (let n = 1; n <= 5; n += 1) await put(kit, wikiId, { id: 't-1', n })

      const first = await kit.getRecordHistory({ wikiId, path: 'tasks', key: 't-1', limit: 2 })
      first.versions.map((version) => version._v).should.deepEqual([5, 4])
      const second = await kit.getRecordHistory({ wikiId, path: 'tasks', key: 't-1', limit: 2, cursor: first.cursor })
      second.versions.map((version) => version._v).should.deepEqual([3, 2])
      const third = await kit.getRecordHistory({ wikiId, path: 'tasks', key: 't-1', limit: 2, cursor: second.cursor })
      third.versions.map((version) => version._v).should.deepEqual([1])
      should(third.cursor).be.undefined()

      await kit.getRecordHistory({ wikiId, path: 'tasks', key: 't-1', limit: 0 })
        .should.be.rejectedWith(ValidationError)
      await kit.getRecordHistory({ wikiId, path: 'tasks', key: '' })
        .should.be.rejectedWith(ValidationError)
    })

    it('keeps no versions on a log — a logged record is its own history', async () => {
      const { kit, wikiId } = await createHistoryKit()
      const record = await kit.putRecord({ wikiId, path: 'about.foo', value: { n: 1 }, actor: agent })
      await kit.getRecordHistory({ wikiId, path: 'about.foo', key: record._id })
        .should.be.rejectedWith(NotFoundError)
      await kit.deleteRecord({ wikiId, path: 'about.foo', key: record._id, actor: human })
      await kit.getRecordHistory({ wikiId, path: 'about.foo', key: record._id })
        .should.be.rejectedWith(NotFoundError)
    })

    it('starts history for records that predate it, on migrate, once', async () => {
      const { kit, db, records, wikiId } = await createHistoryKit()
      await put(kit, wikiId, { id: 't-1', status: 'todo' })
      await put(kit, wikiId, { id: 't-1', status: 'done' })
      await put(kit, wikiId, { id: 't-2', status: 'todo' })
      await kit.putRecord({ wikiId, path: 'about.foo', value: { n: 1 }, actor: agent })

      // An upgrade finds records with no kept versions.
      const { items } = await records.query({ pk: wikiId, from: 'h#', to: 'h#￿', limit: 100 })
      for (const item of items) await records.delete(item.pk, item.sk)
      db.prepare('UPDATE node_records SET versions_kept = 0').run()
      db.prepare("INSERT INTO pending_backfills (id) VALUES ('record-versions')").run()

      await kit.migrate()
      await kit.migrate() // once: a marked page is not read again
      const t1 = await kit.getRecordHistory({ wikiId, path: 'tasks', key: 't-1' })
      t1.versions.map((version) => [version._v, version._change, version.status]).should.deepEqual([[2, 'updated', 'done']])
      const t2 = await kit.getRecordHistory({ wikiId, path: 'tasks', key: 't-2' })
      t2.versions.map((version) => [version._v, version._change]).should.deepEqual([[1, 'created']])
      db.prepare('SELECT MIN(versions_kept) AS kept FROM node_records').get().kept.should.equal(1)

      // History continues from there.
      await put(kit, wikiId, { id: 't-1', status: 'reopened' })
      const next = await kit.getRecordVersion({ wikiId, path: 'tasks', key: 't-1', version: 3 })
      next.previous.status.should.equal('done')
    })

    it('keeps the rest of a batch when one of its versions was kept already', async () => {
      const { kit, db, records, wikiId } = await createHistoryKit()
      await put(kit, wikiId, { id: 't-1', status: 'todo' })
      await put(kit, wikiId, { id: 't-2', status: 'todo' })
      await put(kit, wikiId, { id: 't-2', status: 'done' })

      // t-2's current version is kept; t-1's is not.
      const { items } = await records.query({ pk: wikiId, from: 'h#', to: 'h#\uffff', limit: 100 })
      for (const item of items) {
        if (!(item._v === 2 && item.status === 'done')) await records.delete(item.pk, item.sk)
      }
      db.prepare('UPDATE node_records SET versions_kept = 0').run()
      db.prepare("INSERT INTO pending_backfills (id) VALUES ('record-versions')").run()
      await kit.migrate()

      const t1 = await kit.getRecordHistory({ wikiId, path: 'tasks', key: 't-1' })
      t1.versions.map((version) => version._v).should.deepEqual([1])
      const t2 = await kit.getRecordHistory({ wikiId, path: 'tasks', key: 't-2' })
      t2.versions.map((version) => [version._v, version.status]).should.deepEqual([[2, 'done']])
    })

    it('never counts kept versions as records when the summary is rebuilt', async () => {
      const { kit, db, wikiId } = await createHistoryKit()
      await put(kit, wikiId, { id: 't-1', status: 'todo' })
      await put(kit, wikiId, { id: 't-1', status: 'done' })
      await put(kit, wikiId, { id: 't-2', status: 'todo' })
      await kit.deleteRecord({ wikiId, path: 'tasks', key: 't-2', actor: human })

      db.prepare('DELETE FROM node_records').run()
      await kit.migrate()
      const tree = await kit.getTree({ wikiId, path: 'tasks' })
      tree.records.count.should.equal(1)
    })
  })

  describe('records as of a moment', () => {
    const pause = () => new Promise((resolve) => setTimeout(resolve, 5))
    // A moment strictly between the writes before it and after it.
    const moment = async () => {
      await pause()
      const at = new Date().toISOString()
      await pause()
      return at
    }

    async function createAsOfKit () {
      const records = openRecordStore({ endpoint: dynoxide.endpoint, table: uniqueTable() })
      const { kit, db } = await createTestKit({ records })
      const { wikiId } = await seedAcme(kit)
      await kit.setNode({ wikiId, path: 'tasks', content: '', metadata: { key: 'id' }, actor: human })
      return { kit, db, records, wikiId }
    }

    const put = (kit, wikiId, value) => kit.putRecord({ wikiId, path: 'tasks', value, actor: agent })
    const statuses = (records) => records.map((record) => [record._id, record.status])

    it('reads a keyed page as it stood at any moment, deletions included', async () => {
      const { kit, wikiId } = await createAsOfKit()
      const before = await moment()
      await put(kit, wikiId, { id: 't-1', status: 'todo' })
      await put(kit, wikiId, { id: 't-2', status: 'todo' })
      const first = await moment()
      await put(kit, wikiId, { id: 't-1', status: 'done' })
      await kit.deleteRecord({ wikiId, path: 'tasks', key: 't-2', actor: human })
      await put(kit, wikiId, { id: 't-3', status: 'todo' })
      const second = await moment()
      await put(kit, wikiId, { id: 't-2', status: 'reopened' })

      const empty = await kit.getRecords({ wikiId, path: 'tasks', at: before })
      empty.should.deepEqual({ at: before, records: [], unknown: [] })

      const then = await kit.getRecords({ wikiId, path: 'tasks', at: first })
      statuses(then.records).should.deepEqual([['t-1', 'todo'], ['t-2', 'todo']])
      then.unknown.should.deepEqual([])
      then.records[0]._v.should.equal(1)
      then.records[0].should.not.have.property('_change')

      const later = await kit.getRecords({ wikiId, path: 'tasks', at: second })
      statuses(later.records).should.deepEqual([['t-1', 'done'], ['t-3', 'todo']])

      // Now reads the same as the page itself.
      const now = await kit.getRecords({ wikiId, path: 'tasks', at: new Date().toISOString() })
      const { records } = await kit.getRecords({ wikiId, path: 'tasks' })
      statuses(now.records).should.deepEqual(statuses(records))
      now.records.map((record) => record._v).should.deepEqual(records.map((record) => record._v))
    })

    it('names the keys whose state at that moment was not kept', async () => {
      const { kit, db, records, wikiId } = await createAsOfKit()
      await put(kit, wikiId, { id: 't-1', status: 'todo' })
      const early = await moment()
      await put(kit, wikiId, { id: 't-1', status: 'doing' })
      await put(kit, wikiId, { id: 't-1', status: 'done' })
      const late = await moment()

      // An upgrade keeps only each record's current value.
      const { items } = await records.query({ pk: wikiId, from: 'h#', to: 'h#￿', limit: 100 })
      for (const item of items) await records.delete(item.pk, item.sk)
      db.prepare('UPDATE node_records SET versions_kept = 0').run()
      db.prepare("INSERT INTO pending_backfills (id) VALUES ('record-versions')").run()
      await kit.migrate()

      const unkept = await kit.getRecords({ wikiId, path: 'tasks', at: early })
      unkept.records.should.deepEqual([])
      unkept.unknown.should.deepEqual(['t-1'])

      // The kept version stands from its own write on.
      const kept = await kit.getRecords({ wikiId, path: 'tasks', at: late })
      statuses(kept.records).should.deepEqual([['t-1', 'done']])
      kept.unknown.should.deepEqual([])
    })

    it('stamps when the wiki got a logged record, apart from when it happened', async () => {
      const { kit, wikiId } = await createAsOfKit()
      const record = await kit.putRecord({
        wikiId, path: 'about.foo', value: { n: 1 }, ts: '2026-01-01T00:00:00Z', actor: agent
      })
      record._ts.should.equal('2026-01-01T00:00:00.000Z')
      record._written.should.be.a.String()
      ;(record._written > record._ts).should.be.true()

      const keyed = await put(kit, wikiId, { id: 't-1' })
      keyed.should.not.have.property('_written')
    })

    it('reads a log as it stood: what was written by then, not only observed', async () => {
      const { kit, records, wikiId } = await createAsOfKit()
      const log = (value, ts) => kit.putRecord({ wikiId, path: 'about.foo', value, ts, actor: agent })
      await log({ n: 1 })
      const first = await moment()
      await log({ n: 2 })
      // Backfilled to before the first moment, but written after it.
      await log({ n: 0 }, '2026-01-01T00:00:00Z')
      // Written before write stamps: counts as written when observed.
      await log({ n: -1 }, '2026-01-02T00:00:00Z')
      const { items } = await records.query({ pk: wikiId, from: '', to: 'h#', limit: 100 })
      const { _written, ...unstamped } = items.find((item) => item.n === -1)
      await records.put({ item: unstamped })
      const second = await moment()

      const then = await kit.getRecords({ wikiId, path: 'about.foo', at: first })
      then.records.map((record) => record.n).should.deepEqual([-1, 1])
      const later = await kit.getRecords({ wikiId, path: 'about.foo', at: second })
      later.records.map((record) => record.n).should.deepEqual([0, -1, 1, 2])

      // Pages like any read; a page may come back short of its limit.
      const head = await kit.getRecords({ wikiId, path: 'about.foo', at: first, limit: 1 })
      head.records.should.deepEqual([])
      const rest = await kit.getRecords({ wikiId, path: 'about.foo', at: first, limit: 1, cursor: head.cursor })
      rest.records.map((record) => record.n).should.deepEqual([-1])
      const newest = await kit.getRecords({ wikiId, path: 'about.foo', at: second, reverse: true, limit: 2 })
      newest.records.map((record) => record.n).should.deepEqual([2, 1])
    })

    it('validates the moment and what it combines with', async () => {
      const { kit, wikiId } = await createAsOfKit()
      const at = new Date().toISOString()
      await kit.getRecords({ wikiId, path: 'tasks', at: 'yesterday' })
        .should.be.rejectedWith(ValidationError)
      await kit.getRecords({ wikiId, path: 'tasks', at, key: 't-1' })
        .should.be.rejectedWith(ValidationError)
      await kit.getRecords({ wikiId, path: 'tasks', at, limit: 5 })
        .should.be.rejectedWith(ValidationError)
      await kit.getRecords({ wikiId, path: 'about.foo', at, since: at })
        .should.be.rejectedWith(ValidationError)
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
