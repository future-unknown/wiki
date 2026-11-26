import should from 'should'
import Database from 'better-sqlite3'
import { migrations, migrate } from '../../lib/kit/schema.js'
import { ValidationError, NotFoundError, RecordLimitError } from '../../lib/kit/index.js'
import { openRecordStore } from '../../lib/api/index.js'
import { createTestKit, seedAcme, human } from './helpers.js'
import { startDynoxide, uniqueTable } from '../dynoxide.js'

const dana = { type: 'human', id: 'user_dana', onBehalfOf: null }
const eli = { type: 'human', id: 'user_eli', onBehalfOf: null }

describe('personal tables', () => {
  let dynoxide

  before(async () => {
    dynoxide = await startDynoxide()
  })

  after(() => {
    dynoxide.stop()
  })

  async function personalKit (declaration = { key: 'id', personal: true }) {
    const records = openRecordStore({ endpoint: dynoxide.endpoint, table: uniqueTable() })
    const { kit, db } = await createTestKit({ records })
    const { wikiId } = await seedAcme(kit)
    await kit.setNode({ wikiId, path: 'progress', content: 'Progress', metadata: declaration, actor: human })
    const put = (actor, value) => kit.putRecord({ wikiId, path: 'progress', value, actor, owner: actor.id })
    const rows = (owner) => kit.getRecords({ wikiId, path: 'progress', owner })
    return { kit, db, wikiId, records, put, rows }
  }

  describe('declaring', () => {
    it('refuses a personal declaration without a key', async () => {
      const { kit, wikiId } = await personalKit()
      await kit.setNode({ wikiId, path: 'loose', metadata: { personal: true }, actor: human })
        .should.be.rejectedWith(ValidationError, { message: /only a table can be personal/ })
      await kit.mergeMetadata({ wikiId, path: 'about', metadata: { personal: true }, actor: human })
        .should.be.rejectedWith(ValidationError, { message: /only a table can be personal/ })
    })

    it('lets an empty table become personal, and a personal one shared', async () => {
      const { kit, wikiId } = await personalKit({ key: 'id' })
      await kit.mergeMetadata({ wikiId, path: 'progress', metadata: { personal: true }, actor: human })
      await kit.mergeMetadata({ wikiId, path: 'progress', metadata: { personal: null }, actor: human })
      const page = await kit.getNode({ wikiId, path: 'progress' })
      should(page.metadata.personal).be.undefined()
    })

    it('refuses to change a table that holds rows between shared and personal', async () => {
      const { kit, wikiId, put } = await personalKit()
      await put(dana, { id: 'a', n: 1 })
      await kit.mergeMetadata({ wikiId, path: 'progress', metadata: { personal: null }, actor: human })
        .should.be.rejectedWith(ValidationError, { message: /cannot change between shared and personal/ })

      await kit.setNode({ wikiId, path: 'shared', metadata: { key: 'id' }, actor: human })
      await kit.putRecord({ wikiId, path: 'shared', value: { id: 'a' }, actor: human })
      await kit.mergeMetadata({ wikiId, path: 'shared', metadata: { personal: true }, actor: human })
        .should.be.rejectedWith(ValidationError, { message: /cannot change between shared and personal/ })
    })

    it('still takes other metadata changes once it holds rows', async () => {
      const { kit, wikiId, put } = await personalKit()
      await put(dana, { id: 'a', n: 1 })
      const result = await kit.mergeMetadata({ wikiId, path: 'progress', metadata: { order: 3 }, actor: human })
      result.changed.should.be.true()
    })
  })

  describe('one set of rows per person', () => {
    it('keeps each person\'s rows apart under the same key', async () => {
      const { put, rows } = await personalKit()
      await put(dana, { id: 'lesson-1', done: true })
      await put(eli, { id: 'lesson-1', done: false })
      await put(eli, { id: 'lesson-2', done: true })

      const danas = await rows('user_dana')
      danas.records.map((record) => [record._id, record.done, record._owner])
        .should.deepEqual([['lesson-1', true, 'user_dana']])
      const elis = await rows('user_eli')
      elis.records.map((record) => record._id).should.deepEqual(['lesson-1', 'lesson-2'])
      elis.records[0].done.should.be.false()
    })

    it('answers nobody\'s rows to a person with none', async () => {
      const { put, rows } = await personalKit()
      await put(dana, { id: 'a' })
      const none = await rows('user_nobody')
      none.records.should.deepEqual([])
    })

    it('refuses a call that names no person', async () => {
      const { kit, wikiId, put } = await personalKit()
      await put(dana, { id: 'a' })
      await kit.getRecords({ wikiId, path: 'progress' })
        .should.be.rejectedWith(ValidationError, { message: /names no person/ })
      await kit.putRecord({ wikiId, path: 'progress', value: { id: 'b' }, actor: human })
        .should.be.rejectedWith(ValidationError, { message: /names no person/ })
      await kit.deleteRecord({ wikiId, path: 'progress', key: 'a', actor: human })
        .should.be.rejectedWith(ValidationError, { message: /names no person/ })
      await kit.getRecordHistory({ wikiId, path: 'progress', key: 'a' })
        .should.be.rejectedWith(ValidationError, { message: /names no person/ })
    })

    it('refuses an owner that could reach another range', async () => {
      const { kit, wikiId } = await personalKit()
      for (const owner of ['a#b', 'a~b', '', 'a b', 7]) {
        await kit.getRecords({ wikiId, path: 'progress', owner })
          .should.be.rejectedWith(ValidationError, { message: /owner must be an id/ })
      }
    })

    it('reads one row by key as its owner, and not as anyone else', async () => {
      const { kit, wikiId, put } = await personalKit()
      await put(dana, { id: 'a', n: 1 })
      const mine = await kit.getRecords({ wikiId, path: 'progress', key: 'a', owner: 'user_dana' })
      mine.record.n.should.equal(1)
      await kit.getRecords({ wikiId, path: 'progress', key: 'a', owner: 'user_eli' })
        .should.be.rejectedWith(NotFoundError)
    })

    it('updates and versions a row within its owner\'s rows', async () => {
      const { kit, wikiId, put } = await personalKit()
      await put(dana, { id: 'a', n: 1 })
      await put(eli, { id: 'a', n: 10 })
      const second = await put(dana, { id: 'a', n: 2 })
      second._v.should.equal(2)

      const history = await kit.getRecordHistory({ wikiId, path: 'progress', key: 'a', owner: 'user_dana' })
      history.versions.map((version) => [version._v, version.n, version._owner])
        .should.deepEqual([[2, 2, 'user_dana'], [1, 1, 'user_dana']])
      const elis = await kit.getRecordHistory({ wikiId, path: 'progress', key: 'a', owner: 'user_eli' })
      elis.versions.map((version) => version.n).should.deepEqual([10])

      const pair = await kit.getRecordVersion({ wikiId, path: 'progress', key: 'a', version: 2, owner: 'user_dana' })
      pair.version.n.should.equal(2)
      pair.previous.n.should.equal(1)
    })

    it('guards a write on the version its owner read', async () => {
      const { kit, wikiId, put } = await personalKit()
      await put(dana, { id: 'a', n: 1 })
      await put(eli, { id: 'a', n: 1 })
      await put(eli, { id: 'a', n: 2 })
      const written = await kit.putRecord({
        wikiId, path: 'progress', value: { id: 'a', n: 5 }, ifVersion: 1, actor: dana, owner: 'user_dana'
      })
      written._v.should.equal(2)
    })

    it('deletes one person\'s row and leaves the other\'s', async () => {
      const { kit, wikiId, put, rows } = await personalKit()
      await put(dana, { id: 'a' })
      await put(eli, { id: 'a' })
      await kit.deleteRecord({ wikiId, path: 'progress', key: 'a', actor: dana, owner: 'user_dana' })
      ;(await rows('user_dana')).records.should.deepEqual([])
      ;(await rows('user_eli')).records.length.should.equal(1)
    })

    it('reads a person\'s rows as they stood at a moment', async () => {
      const { kit, wikiId, put } = await personalKit()
      await put(dana, { id: 'a', n: 1 })
      await put(eli, { id: 'a', n: 9 })
      const then = new Date().toISOString()
      await new Promise((resolve) => setTimeout(resolve, 5))
      await put(dana, { id: 'a', n: 2 })
      const was = await kit.getRecords({ wikiId, path: 'progress', at: then, owner: 'user_dana' })
      was.records.map((record) => record.n).should.deepEqual([1])
    })

    it('keeps ten versions of a row unless the table says otherwise', async () => {
      const { kit, wikiId, put } = await personalKit()
      for (let n = 1; n <= 14; n += 1) await put(dana, { id: 'a', n })
      const history = await kit.getRecordHistory({ wikiId, path: 'progress', key: 'a', owner: 'user_dana' })
      history.versions.length.should.equal(10)
      history.versions[0].n.should.equal(14)
    })
  })

  describe('everyone', () => {
    it('reads every person\'s rows, by person then key, each saying whose it is', async () => {
      const { kit, wikiId, put } = await personalKit()
      await put(eli, { id: 'b' })
      await put(dana, { id: 'b' })
      await put(dana, { id: 'a' })
      const all = await kit.getRecords({ wikiId, path: 'progress', everyone: true })
      all.records.map((record) => [record._owner, record._id])
        .should.deepEqual([['user_dana', 'a'], ['user_dana', 'b'], ['user_eli', 'b']])
    })

    it('pages through everyone\'s rows', async () => {
      const { kit, wikiId, put } = await personalKit()
      await put(dana, { id: 'a' })
      await put(dana, { id: 'b' })
      await put(eli, { id: 'a' })
      const first = await kit.getRecords({ wikiId, path: 'progress', everyone: true, limit: 2 })
      first.records.length.should.equal(2)
      const rest = await kit.getRecords({ wikiId, path: 'progress', everyone: true, limit: 2, cursor: first.cursor })
      rest.records.map((record) => [record._owner, record._id]).should.deepEqual([['user_eli', 'a']])
      should(rest.cursor).be.undefined()
    })

    it('reads one row, a moment or the latest for a person only', async () => {
      const { kit, wikiId, put } = await personalKit()
      await put(dana, { id: 'a' })
      for (const extra of [{ key: 'a' }, { latest: true }, { at: new Date().toISOString() }]) {
        await kit.getRecords({ wikiId, path: 'progress', everyone: true, ...extra })
          .should.be.rejectedWith(ValidationError, { message: /name the person/ })
      }
      await kit.getRecords({ wikiId, path: 'progress', everyone: true, owner: 'user_dana' })
        .should.be.rejectedWith(ValidationError, { message: /takes no owner/ })
    })

    it('does not reach a personal table through the page\'s own range', async () => {
      const { wikiId, put, records, kit } = await personalKit()
      await put(dana, { id: 'a' })
      const page = await kit.getNode({ wikiId, path: 'progress' })
      const { items } = await records.query({ pk: wikiId, from: `${page.id}#`, to: `${page.id}#￿`, limit: 10 })
      items.should.deepEqual([])
    })

    it('names the people a table holds rows for', async () => {
      const { kit, wikiId, put } = await personalKit()
      await put(dana, { id: 'a' })
      await put(dana, { id: 'b' })
      await put(eli, { id: 'a' })
      await kit.deleteRecord({ wikiId, path: 'progress', key: 'a', actor: eli, owner: 'user_eli' })
      const { owners, total } = await kit.getRecordOwners({ wikiId, path: 'progress' })
      total.should.equal(1)
      owners.map((entry) => [entry.owner, entry.count]).should.deepEqual([['user_dana', 2]])
      ;(await kit.getRecordOwners({ wikiId, path: 'about' })).should.deepEqual({ owners: [], total: 0 })
    })
  })

  describe('clearing one person', () => {
    it('removes their rows and every version kept of them, and leaves everyone else\'s', async () => {
      const { kit, db, wikiId, records, put, rows } = await personalKit()
      await put(dana, { id: 'a', note: 'saffron' })
      await put(dana, { id: 'a', note: 'saffron again' })
      await put(dana, { id: 'b' })
      await put(eli, { id: 'a', note: 'saffron' })
      await kit.deleteRecord({ wikiId, path: 'progress', key: 'b', actor: dana, owner: 'user_dana' })

      const cleared = await kit.clearOwnerRecords({ wikiId, path: 'progress', owner: 'user_dana', actor: human })
      cleared.should.deepEqual({ owner: 'user_dana', rows: 1, versions: 4 })

      ;(await rows('user_dana')).records.should.have.length(0)
      await kit.getRecordHistory({ wikiId, path: 'progress', key: 'a', owner: 'user_dana' })
        .should.be.rejectedWith(NotFoundError, { message: /no history/ })
      ;(await rows('user_eli')).records.map((record) => record._id).should.deepEqual(['a'])
      ;(await kit.getRecordHistory({ wikiId, path: 'progress', key: 'a', owner: 'user_eli' })).versions.should.have.length(1)

      const { items } = await records.query({ pk: wikiId, from: '', to: '\uffff' })
      items.filter((item) => item.sk.includes('~user_dana#')).should.have.length(0)
      const { owners } = await kit.getRecordOwners({ wikiId, path: 'progress' })
      owners.map((entry) => [entry.owner, entry.count]).should.deepEqual([['user_eli', 1]])
      db.prepare('SELECT owner FROM record_search').all().map((row) => row.owner).should.deepEqual(['user_eli'])
      ;(await kit.search({ wikiId, query: 'saffron', everyone: true })).filter((hit) => hit.kind === 'record').map((hit) => hit.owner).should.deepEqual(['user_eli'])

      // again, and for someone who holds nothing: nothing to do
      ;(await kit.clearOwnerRecords({ wikiId, path: 'progress', owner: 'user_dana', actor: human })).should.deepEqual({ owner: 'user_dana', rows: 0, versions: 0 })
    })

    it('clears more rows than one transaction holds', async () => {
      const { kit, wikiId, put, rows } = await personalKit()
      for (let at = 0; at < 120; at += 1) await put(dana, { id: `k${at}` })
      const cleared = await kit.clearOwnerRecords({ wikiId, path: 'progress', owner: 'user_dana', actor: human })
      cleared.should.deepEqual({ owner: 'user_dana', rows: 120, versions: 120 })
      ;(await rows('user_dana')).records.should.have.length(0)
    })

    it('is for personal tables alone', async () => {
      const { kit, wikiId } = await personalKit()
      await kit.setNode({ wikiId, path: 'shared', content: '', metadata: { key: 'id' }, actor: human })
      await kit.clearOwnerRecords({ wikiId, path: 'shared', owner: 'user_dana', actor: human })
        .should.be.rejectedWith(ValidationError, { message: /only a personal table/ })
    })
  })

  describe('a shared table', () => {
    it('ignores an owner and everyone', async () => {
      const { kit, wikiId } = await personalKit()
      await kit.setNode({ wikiId, path: 'shared', metadata: { key: 'id' }, actor: human })
      const written = await kit.putRecord({ wikiId, path: 'shared', value: { id: 'a' }, actor: dana, owner: 'user_dana' })
      should(written._owner).be.undefined()
      const asEli = await kit.getRecords({ wikiId, path: 'shared', owner: 'user_eli' })
      asEli.records.map((record) => record._id).should.deepEqual(['a'])
      const all = await kit.getRecords({ wikiId, path: 'shared', everyone: true })
      all.records.length.should.equal(1)
    })
  })

  describe('limits', () => {
    it('refuses the row past a person\'s cap, and takes updates and other people', async () => {
      const { kit, wikiId, put } = await personalKit({ key: 'id', personal: { rows: 2 } })
      await put(dana, { id: 'a' })
      await put(dana, { id: 'b' })
      await put(dana, { id: 'c' }).should.be.rejectedWith(RecordLimitError, { code: 'RECORD_LIMIT' })
      await put(dana, { id: 'a', n: 2 })
      await put(eli, { id: 'a' })
      await kit.deleteRecord({ wikiId, path: 'progress', key: 'b', actor: dana, owner: 'user_dana' })
      await put(dana, { id: 'c' })
    })
  })

  describe('what the wiki shows of it', () => {
    it('keeps personal writes out of the change list and the activity tally', async () => {
      const { kit, db, wikiId, put } = await personalKit()
      await put(dana, { id: 'a' })
      await put(dana, { id: 'a', n: 2 })
      await kit.deleteRecord({ wikiId, path: 'progress', key: 'a', actor: dana, owner: 'user_dana' })
      db.prepare('SELECT COUNT(*) AS n FROM record_changes').get().n.should.equal(0)
      db.prepare('SELECT COUNT(*) AS n FROM record_writes').get().n.should.equal(0)
      const changes = await kit.getChanges({ wikiId, records: true })
      changes.filter((entry) => entry.records).should.deepEqual([])
    })

    it('names no writer on the table\'s summary', async () => {
      const { db, put } = await personalKit()
      await put(dana, { id: 'a' })
      const row = db.prepare('SELECT count, last_actor FROM node_records').get()
      row.count.should.equal(1)
      should(row.last_actor).be.null()
    })

    it('counts a reader\'s own rows in the tree, and everyone\'s when asked', async () => {
      const { kit, wikiId, put } = await personalKit()
      await put(dana, { id: 'a' })
      await put(dana, { id: 'b' })
      await put(eli, { id: 'a' })
      const count = async (options) => {
        const tree = await kit.getTree({ wikiId, path: 'progress', ...options })
        return tree.records?.count ?? null
      }
      ;(await count({ owner: 'user_dana' })).should.equal(2)
      ;(await count({ owner: 'user_eli' })).should.equal(1)
      should(await count({ owner: 'user_nobody' })).be.null()
      should(await count({})).be.null()
      ;(await count({ everyone: true })).should.equal(3)
    })

    it('finds a person\'s rows in their own search, and everyone\'s when asked', async () => {
      const { kit, wikiId, put } = await personalKit()
      await put(dana, { id: 'a', note: 'saffron harvest' })
      await put(eli, { id: 'a', note: 'saffron prices' })
      // The store keeps a row's fields in no order, so the excerpt is
      // matched by the words around the hit.
      const keys = (hits) => hits.filter((hit) => hit.kind === 'record').map((hit) => [hit.owner, hit.key, hit.excerpt.match(/\[saffron\] \w+/)?.[0]])
      const danas = await kit.search({ wikiId, query: 'saffron', owner: 'user_dana' })
      keys(danas).should.deepEqual([['user_dana', 'a', '[saffron] harvest']])
      const nobody = await kit.search({ wikiId, query: 'saffron' })
      keys(nobody).should.deepEqual([])
      const all = await kit.search({ wikiId, query: 'saffron', everyone: true })
      keys(all).map(([owner]) => owner).sort().should.deepEqual(['user_dana', 'user_eli'])
    })

    it('drops a deleted row from search', async () => {
      const { kit, wikiId, put } = await personalKit()
      await put(dana, { id: 'a', note: 'saffron' })
      await put(eli, { id: 'a', note: 'saffron' })
      await kit.deleteRecord({ wikiId, path: 'progress', key: 'a', actor: dana, owner: 'user_dana' })
      const all = await kit.search({ wikiId, query: 'saffron', everyone: true })
      all.filter((hit) => hit.kind === 'record').map((hit) => hit.owner).should.deepEqual(['user_eli'])
    })

    it('indexes no links from a personal row, and checks none to one', async () => {
      const { kit, db, wikiId, put } = await personalKit()
      await put(dana, { id: 'a', note: 'see [[about.foo]]' })
      db.prepare("SELECT COUNT(*) AS n FROM links WHERE source_key != ''").get().n.should.equal(0)
      const { links } = await kit.getLinks({ wikiId, path: 'about.foo' })
      links.should.deepEqual([])
      const checked = await kit.checkLinks({ wikiId, path: 'about', links: [{ wiki: null, path: 'progress', key: 'a' }] })
      checked.problems.should.deepEqual([])
    })
  })

  describe('beside shared tables', () => {
    it('still finds a shared table\'s rows for any reader', async () => {
      const { kit, wikiId } = await personalKit()
      await kit.setNode({ wikiId, path: 'shared', metadata: { key: 'id' }, actor: human })
      await kit.putRecord({ wikiId, path: 'shared', value: { id: 'a', note: 'cardamom' }, actor: human })
      const hits = await kit.search({ wikiId, query: 'cardamom' })
      hits.filter((hit) => hit.kind === 'record').map((hit) => [hit.key, hit.owner]).should.deepEqual([['a', undefined]])
    })
  })

  describe('upgrading', () => {
    it('carries the search rows a file already has, at their rowids, as shared', async () => {
      const db = new Database(':memory:')
      for (const migration of migrations) {
        if (migration.id === '016-personal-tables') break
        db.exec(migration.sql)
      }
      db.exec(`CREATE TABLE schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL)`)
      const applied = db.prepare('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)')
      for (const migration of migrations) {
        if (migration.id === '016-personal-tables') break
        applied.run(migration.id, new Date().toISOString())
      }
      db.prepare('INSERT INTO record_search (rowid, wiki_id, node_id, record_key, title) VALUES (7, ?, ?, ?, ?)').run('w', 'n', 'a', 'Cardamom')
      db.prepare('INSERT INTO records_fts (rowid, title, body) VALUES (7, ?, ?)').run('Cardamom', 'green pods')

      migrate(db)

      const found = db.prepare(`
        SELECT s.rowid, s.owner, s.record_key FROM records_fts
        JOIN record_search s ON s.rowid = records_fts.rowid WHERE records_fts MATCH 'pods'
      `).all()
      found.should.deepEqual([{ rowid: 7, owner: '', record_key: 'a' }])
      db.prepare('INSERT INTO record_search (wiki_id, node_id, owner, record_key, title) VALUES (?, ?, ?, ?, ?)').run('w', 'n', 'user_dana', 'a', 'Hers')
      db.close()
    })
  })
})
