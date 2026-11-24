import should from 'should'
import { NotFoundError, ValidationError } from '../../lib/kit/index.js'
import { openRecordStore } from '../../lib/api/index.js'
import { createTestKit, seedAcme, human, agent } from './helpers.js'
import { startDynoxide, uniqueTable } from '../dynoxide.js'

const other = { type: 'human', id: 'user_other', onBehalfOf: null }

describe('record changes', () => {
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

  // The acme wiki with a table at crm.people, keyed by id.
  async function seedTable (kit) {
    const { wikiId } = await seedAcme(kit)
    await kit.setNode({ wikiId, path: 'crm', content: 'crm', actor: human })
    await kit.setNode({ wikiId, path: 'crm.people', content: 'people', metadata: { key: 'id' }, actor: human })
    return { wikiId }
  }

  const batchesOf = (entries) => entries.filter((entry) => entry.records)

  it('leaves changes as they were unless records are asked for', async () => {
    const { kit } = await createRecordsKit()
    const { wikiId } = await seedTable(kit)
    await kit.putRecord({ wikiId, path: 'crm.people', value: { id: 'jo', name: 'Jo' }, actor: human })
    const plain = await kit.getChanges({ wikiId })
    plain.every((entry) => Number.isInteger(entry.id) && Array.isArray(entry.pages)).should.be.true()
  })

  it('lists a run of writes to a table as one batch, above the commit it followed', async () => {
    const { kit } = await createRecordsKit()
    const { wikiId } = await seedTable(kit)
    await kit.putRecord({ wikiId, path: 'crm.people', value: { id: 'jo', name: 'Jo' }, actor: human })
    await kit.putRecord({ wikiId, path: 'crm.people', value: { id: 'al', name: 'Al' }, actor: human })
    await kit.putRecord({ wikiId, path: 'crm.people', value: { id: 'jo', name: 'Joanne' }, actor: human })
    await kit.deleteRecord({ wikiId, path: 'crm.people', key: 'al', actor: human })

    const entries = await kit.getChanges({ wikiId, records: true })
    const [first, second] = entries
    should(first.id).be.undefined()
    first.after.should.equal(second.id)
    first.actor.should.deepEqual({ type: 'human', id: 'user_test', onBehalfOf: null })
    first.records.should.containEql({ path: 'crm.people', writes: 4, count: 2, created: 2, updated: 1, deleted: 1 })
    should(first.records.key).be.undefined()
    first.createdAt.should.be.aboveOrEqual(first.since)
    batchesOf(entries).length.should.equal(1)
  })

  it('names the record when a batch wrote one, and the version when it wrote once', async () => {
    const { kit } = await createRecordsKit()
    const { wikiId } = await seedTable(kit)
    await kit.putRecord({ wikiId, path: 'crm.people', value: { id: 'jo', name: 'Jo' }, actor: human })
    const [batch] = batchesOf(await kit.getChanges({ wikiId, records: true }))
    batch.records.should.containEql({ key: 'jo', version: 1, writes: 1, count: 1 })
  })

  it('starts a batch for another writer, after a commit, and after a long pause', async () => {
    const { kit, db } = await createRecordsKit()
    const { wikiId } = await seedTable(kit)
    await kit.putRecord({ wikiId, path: 'crm.people', value: { id: 'a' }, actor: human })
    await kit.putRecord({ wikiId, path: 'crm.people', value: { id: 'b' }, actor: agent })
    await kit.putRecord({ wikiId, path: 'crm.people', value: { id: 'c' }, actor: human })
    batchesOf(await kit.getChanges({ wikiId, records: true })).length.should.equal(2)

    await kit.setNode({ wikiId, path: 'about.foo', content: 'changed', actor: human })
    await kit.putRecord({ wikiId, path: 'crm.people', value: { id: 'd' }, actor: human })
    const entries = await kit.getChanges({ wikiId, records: true })
    batchesOf(entries).length.should.equal(3)
    // The newest batch sits above the commit that came before it.
    entries[0].records.key.should.equal('d')
    entries[1].pages[0].path.should.equal('about.foo')

    // A write long after the writer's last starts a batch of its own.
    db.prepare("UPDATE record_changes SET at = '2020-01-01T00:00:00.000Z' WHERE key = 'd'").run()
    await kit.putRecord({ wikiId, path: 'crm.people', value: { id: 'e' }, actor: human })
    batchesOf(await kit.getChanges({ wikiId, records: true })).length.should.equal(4)
  })

  it('keeps a log out of it', async () => {
    const { kit } = await createRecordsKit()
    const { wikiId } = await seedTable(kit)
    await kit.putRecord({ wikiId, path: 'about.foo', value: { n: 1 }, actor: human })
    batchesOf(await kit.getChanges({ wikiId, records: true })).length.should.equal(0)
  })

  it('scopes batches to the path asked for', async () => {
    const { kit } = await createRecordsKit()
    const { wikiId } = await seedTable(kit)
    await kit.putRecord({ wikiId, path: 'crm.people', value: { id: 'jo' }, actor: human })
    batchesOf(await kit.getChanges({ wikiId, path: 'crm', records: true })).length.should.equal(1)
    batchesOf(await kit.getChanges({ wikiId, path: 'about', records: true })).length.should.equal(0)
  })

  it('passes every batch once when paged by commit', async () => {
    const { kit } = await createRecordsKit()
    const { wikiId } = await seedTable(kit)
    await kit.putRecord({ wikiId, path: 'crm.people', value: { id: 'a' }, actor: human })
    await kit.setNode({ wikiId, path: 'about.foo', content: 'one', actor: human })
    await kit.putRecord({ wikiId, path: 'crm.people', value: { id: 'b' }, actor: human })
    await kit.setNode({ wikiId, path: 'about.foo', content: 'two', actor: human })
    await kit.putRecord({ wikiId, path: 'crm.people', value: { id: 'c' }, actor: human })

    const seen = []
    let before
    for (let page = 0; page < 20; page += 1) {
      const entries = await kit.getChanges({ wikiId, records: true, limit: 2, before })
      seen.push(...batchesOf(entries).map((entry) => entry.records.key))
      const commits = entries.filter((entry) => !entry.records)
      if (commits.length < 2) break
      before = commits[commits.length - 1].id
    }
    seen.should.deepEqual(['c', 'b', 'a'])
  })

  it('reads a batch with its writes, newest first, a page at a time', async () => {
    const { kit } = await createRecordsKit()
    const { wikiId } = await seedTable(kit)
    await kit.putRecord({ wikiId, path: 'crm.people', value: { id: 'jo', name: 'Jo' }, actor: human })
    await kit.putRecord({ wikiId, path: 'crm.people', value: { id: 'jo', name: 'Joanne' }, actor: human })
    await kit.deleteRecord({ wikiId, path: 'crm.people', key: 'jo', actor: human })
    const [{ batch }] = batchesOf(await kit.getChanges({ wikiId, records: true }))

    const read = await kit.getRecordChanges({ wikiId, batch })
    read.records.should.containEql({ path: 'crm.people', writes: 3, count: 1 })
    read.writes.map(({ key, version, change }) => ({ key, version, change })).should.deepEqual([
      { key: 'jo', version: 3, change: 'deleted' },
      { key: 'jo', version: 2, change: 'updated' },
      { key: 'jo', version: 1, change: 'created' }
    ])
    should(read.next).be.undefined()

    const first = await kit.getRecordChanges({ wikiId, batch, limit: 2 })
    first.writes.length.should.equal(2)
    const rest = await kit.getRecordChanges({ wikiId, batch, limit: 2, before: first.next })
    rest.writes.map((write) => write.version).should.deepEqual([1])

    await kit.getRecordChanges({ wikiId, batch: 9999 }).should.be.rejectedWith(NotFoundError)
    await kit.getRecordChanges({ wikiId, batch: 0 }).should.be.rejectedWith(ValidationError)
  })

  it('counts a batch by others as one change', async () => {
    const { kit } = await createRecordsKit()
    const { wikiId } = await seedTable(kit)
    const before = await kit.countChanges({ wikiId, except: human.id })
    await kit.putRecord({ wikiId, path: 'crm.people', value: { id: 'a' }, actor: other })
    await kit.putRecord({ wikiId, path: 'crm.people', value: { id: 'b' }, actor: other })
    await kit.putRecord({ wikiId, path: 'crm.people', value: { id: 'c' }, actor: human })
    await kit.putRecord({ wikiId, path: 'crm.people', value: { id: 'd' }, actor: agent })
    // The reader's own writes, and their agent's, are not news to them.
    ;(await kit.countChanges({ wikiId, except: human.id })).should.equal(before + 1)
    ;(await kit.countChanges({ wikiId, except: human.id, since: new Date(Date.now() + 1000).toISOString() })).should.equal(0)
  })

  it('journals the versions tables kept before the journal', async () => {
    const { kit, db } = await createRecordsKit()
    const { wikiId } = await seedTable(kit)
    await kit.putRecord({ wikiId, path: 'crm.people', value: { id: 'jo', name: 'Jo' }, actor: human })
    await kit.putRecord({ wikiId, path: 'crm.people', value: { id: 'jo', name: 'Joanne' }, actor: human })
    await kit.putRecord({ wikiId, path: 'crm.people', value: { id: 'al' }, actor: other })
    await kit.deleteRecord({ wikiId, path: 'crm.people', key: 'al', actor: other })
    const live = batchesOf(await kit.getChanges({ wikiId, records: true }))

    db.prepare('DELETE FROM record_changes').run()
    db.prepare("INSERT INTO pending_backfills (id) VALUES ('record-changes')").run()
    await kit.migrate()
    db.prepare('SELECT COUNT(*) AS n FROM pending_backfills').get().n.should.equal(0)

    const read = batchesOf(await kit.getChanges({ wikiId, records: true }))
    const told = (batches) => batches.map(({ actor, after, createdAt, records }) => ({
      actor, after, createdAt, writes: records.writes, count: records.count, deleted: records.deleted
    }))
    told(read).should.deepEqual(told(live))

    // Again changes nothing: a version is journaled once.
    db.prepare("INSERT INTO pending_backfills (id) VALUES ('record-changes')").run()
    await kit.migrate()
    db.prepare('SELECT COUNT(*) AS n FROM record_changes').get().n.should.equal(4)
  })
})
