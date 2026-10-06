import should from 'should'
import { ValidationError, NotFoundError, parseLinks, recordLinks, recordTitle } from '../../lib/kit/index.js'
import { openRecordStore } from '../../lib/api/index.js'
import { createTestKit, seedAcme, human, agent } from './helpers.js'
import { startDynoxide, uniqueTable } from '../dynoxide.js'

describe('links, record search, and version retention', () => {
  let dynoxide

  before(async () => {
    dynoxide = await startDynoxide()
  })

  after(() => {
    dynoxide.stop()
  })

  async function createLinkKit () {
    const records = openRecordStore({ endpoint: dynoxide.endpoint, table: uniqueTable() })
    const { kit, db } = await createTestKit({ records })
    const { wikiId } = await seedAcme(kit)
    await kit.setNode({ wikiId, path: 'crm', content: 'CRM', actor: human })
    await kit.setNode({ wikiId, path: 'crm.contacts', content: 'People', metadata: { key: 'id' }, actor: human })
    await kit.setNode({ wikiId, path: 'crm.pipeline', content: 'Deals', metadata: { key: 'id' }, actor: human })
    await kit.setNode({ wikiId, path: 'crm.calls', content: 'A log of calls', actor: human })
    return { kit, db, records, wikiId }
  }

  const contact = (kit, wikiId, value) => kit.putRecord({ wikiId, path: 'crm.contacts', value, actor: agent })
  const deal = (kit, wikiId, value) => kit.putRecord({ wikiId, path: 'crm.pipeline', value, actor: agent })
  const linksTo = async (kit, wikiId, path, key) =>
    (await kit.getLinks({ wikiId, path, key })).links.map((link) => [link.path, link.key])

  describe('the link grammar', () => {
    it('reads page and record links, labels and embeds alike', () => {
      parseLinks('see [[about.team]], [[about.team|the team]] and ![[usage.daily]]').should.deepEqual([
        { path: 'about.team', key: null },
        { path: 'about.team', key: null },
        { path: 'usage.daily', key: null }
      ])
      parseLinks('[[crm.contacts/jo@acme.com]] or [[crm.contacts/a b.c|Jo]]').should.deepEqual([
        { path: 'crm.contacts', key: 'jo@acme.com' },
        { path: 'crm.contacts', key: 'a b.c' }
      ])
      parseLinks('[[Not A Path]] [[crm/]] plain text').should.deepEqual([])
      parseLinks(null).should.deepEqual([])
    })

    it('collects every link a record carries, once, and never from stamps', () => {
      recordLinks({
        person: '[[crm.contacts/jo]]',
        seen: ['[[crm.calls]]', '[[crm.contacts/jo]]'],
        nested: { about: 'met via [[crm.contacts/sam|Sam]]' },
        _actor: { id: '[[crm.contacts/ghost]]' }
      }).should.deepEqual([
        { path: 'crm.contacts', key: 'jo' },
        { path: 'crm.calls', key: null },
        { path: 'crm.contacts', key: 'sam' }
      ])
    })

    it('heads a record by its title, else its name, else its key', () => {
      recordTitle({ title: 'Acme', name: 'Jo' }, 'k').should.equal('Acme')
      recordTitle({ name: 'Jo Smith' }, 'k').should.equal('Jo Smith')
      recordTitle({ title: '  ', name: 7 }, 'k').should.equal('k')
    })
  })

  describe('what links here', () => {
    it('finds the records and pages that link to a record, each linking record with it', async () => {
      const { kit, wikiId } = await createLinkKit()
      await contact(kit, wikiId, { id: 'jo', name: 'Jo Smith' })
      await deal(kit, wikiId, { id: 'd-1', stage: 'proposal', person: '[[crm.contacts/jo]]' })
      await kit.putRecord({ wikiId, path: 'crm.calls', value: { summary: 'Called [[crm.contacts/jo|Jo]]' }, actor: agent })
      await kit.setNode({ wikiId, path: 'about.foo', content: 'Our champion is [[crm.contacts/jo]].', actor: human })

      const { links } = await kit.getLinks({ wikiId, path: 'crm.contacts', key: 'jo' })
      links.map((link) => [link.path, link.key === null ? null : link.key.split('#')[0]]).should.deepEqual([
        ['about.foo', null],
        ['crm.calls', links[1].key.split('#')[0]],
        ['crm.pipeline', 'd-1']
      ])
      should(links[0].title).be.null() // the page has no title
      should(links[0].record).be.undefined()
      links[2].record.stage.should.equal('proposal')
      links[2].title.should.equal('d-1')
      links[1].record.summary.should.startWith('Called')

      // A link to the page is not a link to its records, and back.
      ;(await linksTo(kit, wikiId, 'crm.contacts')).should.deepEqual([])
    })

    it('follows writes: a rewrite replaces a record’s links, a delete removes them', async () => {
      const { kit, wikiId } = await createLinkKit()
      await deal(kit, wikiId, { id: 'd-1', person: '[[crm.contacts/jo]]' })
      ;(await linksTo(kit, wikiId, 'crm.contacts', 'jo')).should.deepEqual([['crm.pipeline', 'd-1']])

      await deal(kit, wikiId, { id: 'd-1', person: '[[crm.contacts/sam]]' })
      ;(await linksTo(kit, wikiId, 'crm.contacts', 'jo')).should.deepEqual([])
      ;(await linksTo(kit, wikiId, 'crm.contacts', 'sam')).should.deepEqual([['crm.pipeline', 'd-1']])

      await kit.deleteRecord({ wikiId, path: 'crm.pipeline', key: 'd-1', actor: human })
      ;(await linksTo(kit, wikiId, 'crm.contacts', 'sam')).should.deepEqual([])
    })

    it('follows page content, and forgets a deleted page’s links and its records’', async () => {
      const { kit, wikiId } = await createLinkKit()
      await kit.setNode({ wikiId, path: 'about.foo', content: 'see [[crm]]', actor: human })
      ;(await linksTo(kit, wikiId, 'crm')).should.deepEqual([['about.foo', null]])
      await kit.setNode({ wikiId, path: 'about.foo', content: 'see nothing', actor: human })
      ;(await linksTo(kit, wikiId, 'crm')).should.deepEqual([])

      await deal(kit, wikiId, { id: 'd-1', person: '[[crm.contacts/jo]]' })
      await kit.setNode({ wikiId, path: 'about.foo', content: 'see [[crm.contacts/jo]]', actor: human })
      await kit.deleteNode({ wikiId, path: 'crm.pipeline', actor: human })
      await kit.deleteNode({ wikiId, path: 'about.foo', actor: human })
      ;(await linksTo(kit, wikiId, 'crm.contacts', 'jo')).should.deepEqual([])
    })

    it('lets a logged record’s links lapse with the record', async () => {
      const { kit, db, wikiId } = await createLinkKit()
      await kit.mergeMetadata({ wikiId, path: 'crm.calls', metadata: { retain: { days: 1 } }, actor: human })
      await kit.putRecord({ wikiId, path: 'crm.calls', value: { who: '[[crm.contacts/jo]]' }, ts: '2020-01-01T00:00:00Z', actor: agent })
      await kit.putRecord({ wikiId, path: 'crm.calls', value: { who: '[[crm.contacts/jo]]' }, actor: agent })
      db.prepare('SELECT COUNT(*) AS n FROM links WHERE target_key = ?').get('jo').n.should.equal(2)
      ;(await linksTo(kit, wikiId, 'crm.contacts', 'jo')).length.should.equal(1)
    })

    it('validates its address and options', async () => {
      const { kit, wikiId } = await createLinkKit()
      await kit.getLinks({ wikiId, path: 'nope' }).should.be.rejectedWith(NotFoundError)
      await kit.getLinks({ wikiId, path: 'crm', key: '' }).should.be.rejectedWith(ValidationError)
      await kit.getLinks({ wikiId, path: 'crm', limit: 0 }).should.be.rejectedWith(ValidationError)
    })
  })

  describe('record search', () => {
    it('finds table records by any text they carry, headed by title or name', async () => {
      const { kit, wikiId } = await createLinkKit()
      await contact(kit, wikiId, { id: 'jo', name: 'Jo Smith', content: 'Wants single sign-on before signing.' })
      await contact(kit, wikiId, { id: 'sam', name: 'Sam Lee', roles: ['investor', 'advisor'] })
      await kit.setNode({ wikiId, path: 'about.sso', content: 'Our single sign-on story.', actor: human })

      const hits = await kit.search({ wikiId, query: 'sign-on' })
      hits.map((hit) => [hit.kind, hit.path, hit.key ?? null]).should.containDeep([
        ['record', 'crm.contacts', 'jo'],
        ['page', 'about.sso', null]
      ])
      const jo = hits.find((hit) => hit.kind === 'record')
      jo.title.should.equal('Jo Smith')
      jo.excerpt.should.match(/\[sign-on\]/)
      jo.should.not.have.property('rank')

      // Arrays and the heading count; the scope narrows to a subtree.
      ;(await kit.search({ wikiId, query: 'advisor' })).map((hit) => hit.key).should.deepEqual(['sam'])
      ;(await kit.search({ wikiId, query: 'Sam' })).map((hit) => hit.key).should.deepEqual(['sam'])
      ;(await kit.search({ wikiId, path: 'about', query: 'advisor' })).should.deepEqual([])
    })

    it('searches current values only, and never logs', async () => {
      const { kit, wikiId } = await createLinkKit()
      await contact(kit, wikiId, { id: 'jo', note: 'prefers phone' })
      await contact(kit, wikiId, { id: 'jo', note: 'prefers email' })
      ;(await kit.search({ wikiId, query: 'phone' })).should.deepEqual([])
      ;(await kit.search({ wikiId, query: 'email' })).map((hit) => hit.key).should.deepEqual(['jo'])

      await kit.putRecord({ wikiId, path: 'crm.calls', value: { summary: 'quarterly email review' }, actor: agent })
      ;(await kit.search({ wikiId, query: 'quarterly' })).should.deepEqual([])

      await kit.deleteRecord({ wikiId, path: 'crm.contacts', key: 'jo', actor: human })
      ;(await kit.search({ wikiId, query: 'email' })).should.deepEqual([])
    })
  })

  describe('retain.versions', () => {
    it('keeps only the newest versions of each record, and says what came before is unknown', async () => {
      const { kit, wikiId } = await createLinkKit()
      await kit.mergeMetadata({ wikiId, path: 'crm.contacts', metadata: { retain: { versions: 2 } }, actor: human })
      const before = new Date().toISOString()
      await new Promise((resolve) => setTimeout(resolve, 5))
      for (let n = 1; n <= 4; n += 1) await contact(kit, wikiId, { id: 'jo', n })

      const { versions } = await kit.getRecordHistory({ wikiId, path: 'crm.contacts', key: 'jo' })
      versions.map((version) => version._v).should.deepEqual([4, 3])
      const then = await kit.getRecords({ wikiId, path: 'crm.contacts', at: before })
      then.unknown.should.deepEqual(['jo'])
    })

    it('trims what a higher cap kept once the cap is lowered', async () => {
      const { kit, wikiId } = await createLinkKit()
      for (let n = 1; n <= 5; n += 1) await contact(kit, wikiId, { id: 'jo', n })
      await kit.mergeMetadata({ wikiId, path: 'crm.contacts', metadata: { retain: { versions: 1 } }, actor: human })
      await contact(kit, wikiId, { id: 'jo', n: 6 })
      const { versions } = await kit.getRecordHistory({ wikiId, path: 'crm.contacts', key: 'jo' })
      versions.map((version) => version._v).should.deepEqual([6])

      // A deletion is a version too: it is kept, and the cap applies.
      await kit.deleteRecord({ wikiId, path: 'crm.contacts', key: 'jo', actor: human })
      const gone = await kit.getRecordHistory({ wikiId, path: 'crm.contacts', key: 'jo' })
      gone.versions.map((version) => [version._v, version._change]).should.deepEqual([[7, 'deleted']])
    })
  })

  describe('indexing what predates the indexes, on migrate', () => {
    it('indexes every page’s links and every record once', async () => {
      const { kit, db, wikiId } = await createLinkKit()
      await kit.setNode({ wikiId, path: 'about.foo', content: 'see [[crm.contacts/jo]]', actor: human })
      await contact(kit, wikiId, { id: 'jo', name: 'Jo Smith', content: 'champion' })
      await deal(kit, wikiId, { id: 'd-1', person: '[[crm.contacts/jo]]' })
      await kit.putRecord({ wikiId, path: 'crm.calls', value: { who: '[[crm.contacts/jo]]' }, actor: agent })

      // An upgrade finds content and records with no index.
      db.exec('DELETE FROM links; DELETE FROM records_fts; DELETE FROM record_search;')
      db.exec("INSERT INTO pending_backfills (id) VALUES ('page-links'), ('record-index')")
      await kit.migrate()

      ;(await linksTo(kit, wikiId, 'crm.contacts', 'jo')).map(([path]) => path)
        .should.deepEqual(['about.foo', 'crm.calls', 'crm.pipeline'])
      ;(await kit.search({ wikiId, query: 'champion' })).map((hit) => hit.key).should.deepEqual(['jo'])
      db.prepare('SELECT COUNT(*) AS n FROM pending_backfills').get().n.should.equal(0)

      // Once: a second migrate does not index again.
      db.exec('DELETE FROM links')
      await kit.migrate()
      db.prepare('SELECT COUNT(*) AS n FROM links').get().n.should.equal(0)
    })

    it('leaves record indexing pending while there is no record store', async () => {
      const { db } = await createTestKit()
      db.prepare('SELECT id FROM pending_backfills').all().map((row) => row.id).should.deepEqual(['record-index'])
    })
  })
})
