import should from 'should'
import { LeafPageError, ValidationError } from '../../lib/kit/index.js'
import { openRecordStore } from '../../lib/api/records.js'
import { createTestKit, seedAcme, human, agent } from './helpers.js'
import { startDynoxide, uniqueTable } from '../dynoxide.js'

// A page that holds records (a table or a log) is a leaf: no page sits
// under it, and a page with pages under it does not come to hold records.
describe('a page that holds records is a leaf', () => {
  let dynoxide

  before(async () => {
    dynoxide = await startDynoxide()
  })

  after(() => {
    dynoxide.stop()
  })

  async function seeded () {
    const records = openRecordStore({ endpoint: dynoxide.endpoint, table: uniqueTable() })
    const { kit, db } = await createTestKit({ records })
    const { wikiId } = await seedAcme(kit)
    // about.foo a table, about.bar a log, about.baz a plain page
    await kit.mergeMetadata({ wikiId, path: 'about.foo', metadata: { key: 'id' }, actor: human })
    await kit.putRecord({ wikiId, path: 'about.bar', value: { n: 1 }, actor: agent })
    return { kit, db, wikiId }
  }

  it('refuses a page under a table, and says where it goes instead', async () => {
    const { kit, wikiId } = await seeded()
    const error = await kit.setNode({ wikiId, path: 'about.foo.notes', content: 'x', actor: human })
      .should.be.rejectedWith(LeafPageError)
    error.should.be.instanceof(ValidationError)
    error.code.should.equal('LEAF_PAGE')
    error.message.should.match(/^about\.foo holds records/)
    error.message.should.match(/beside it/)
    error.details.should.deepEqual({ path: 'about.foo.notes', holder: 'about.foo' })
  })

  it('refuses a page under a table that has no records yet', async () => {
    const { kit, wikiId } = await seeded()
    ;(await kit.getRecords({ wikiId, path: 'about.foo' })).records.should.deepEqual([])
    await kit.setNode({ wikiId, path: 'about.foo.notes', content: 'x', actor: human })
      .should.be.rejectedWith(LeafPageError)
  })

  it('refuses a page under a log', async () => {
    const { kit, wikiId } = await seeded()
    await kit.setNode({ wikiId, path: 'about.bar.notes', content: 'x', actor: human })
      .should.be.rejectedWith(LeafPageError)
  })

  it('refuses a page deeper under one, making none of the parents between', async () => {
    const { kit, db, wikiId } = await seeded()
    const before = db.prepare('SELECT COUNT(*) AS n FROM commits').get().n
    await kit.setNode({ wikiId, path: 'about.foo.a.b', content: 'x', actor: human })
      .should.be.rejectedWith(LeafPageError)
    db.prepare("SELECT COUNT(*) AS n FROM nodes WHERE path LIKE 'about.foo.%'").get().n.should.equal(0)
    db.prepare('SELECT COUNT(*) AS n FROM commits').get().n.should.equal(before)
  })

  it('refuses a move under a table or a log, a page or a subtree alike', async () => {
    const { kit, wikiId } = await seeded()
    await kit.setNode({ wikiId, path: 'guides.setup', content: 'x', actor: human })
    await kit.moveNode({ wikiId, fromPath: 'about.baz', toPath: 'about.foo.baz', actor: human })
      .should.be.rejectedWith(LeafPageError)
    await kit.moveNode({ wikiId, fromPath: 'guides', toPath: 'about.bar.guides', actor: human })
      .should.be.rejectedWith(LeafPageError)
    ;(await kit.getNode({ wikiId, path: 'about.baz' })).path.should.equal('about.baz')
    ;(await kit.getNode({ wikiId, path: 'guides.setup' })).path.should.equal('guides.setup')
  })

  it('moves a table as any page moves, and beside another', async () => {
    const { kit, wikiId } = await seeded()
    const moved = await kit.moveNode({ wikiId, fromPath: 'about.foo', toPath: 'about.baz.foo', actor: human })
    moved.path.should.equal('about.baz.foo')
  })

  it('refuses a key on a page with pages under it', async () => {
    const { kit, wikiId } = await seeded()
    const error = await kit.mergeMetadata({ wikiId, path: 'about', metadata: { key: 'id' }, actor: human })
      .should.be.rejectedWith(LeafPageError)
    error.message.should.match(/^about has pages under it/)
    error.message.should.match(/cannot become a table/)
    error.details.should.deepEqual({ path: 'about', childCount: 3 })
    await kit.setNode({ wikiId, path: 'about', metadata: { key: 'id' }, actor: human })
      .should.be.rejectedWith(LeafPageError)
    should((await kit.getNode({ wikiId, path: 'about' })).metadata.key).be.undefined()
  })

  it('refuses a first record on a page with pages under it, the root among them', async () => {
    const { kit, wikiId } = await seeded()
    await kit.putRecord({ wikiId, path: 'about', value: { n: 1 }, actor: agent })
      .should.be.rejectedWith(LeafPageError)
    const error = await kit.putRecord({ wikiId, path: '', value: { n: 1 }, actor: agent })
      .should.be.rejectedWith(LeafPageError)
    error.message.should.match(/^the wiki's root page has pages under it/)
    ;(await kit.getRecords({ wikiId, path: 'about' })).records.should.deepEqual([])
  })

  it('takes pages again once its records and key are gone', async () => {
    const { kit, wikiId } = await seeded()
    await kit.mergeMetadata({ wikiId, path: 'about.foo', metadata: { key: null }, actor: human })
    await kit.setNode({ wikiId, path: 'about.foo.notes', content: 'x', actor: human })
    ;(await kit.getNode({ wikiId, path: 'about.foo.notes' })).content.should.equal('x')
  })

  it('leaves a table that already has pages under it readable and writable', async () => {
    const { kit, db, wikiId } = await seeded()
    // as an older store may hold it: a page put under a table directly
    const table = await kit.getNode({ wikiId, path: 'about.foo' })
    await kit.setNode({ wikiId, path: 'about.baz.old', content: 'kept', actor: human })
    db.prepare("UPDATE nodes SET parent_id = ?, path = 'about.foo.old' WHERE path = 'about.baz.old'").run(table.id)

    const record = await kit.putRecord({ wikiId, path: 'about.foo', value: { id: 'a', n: 1 }, actor: agent })
    record.n.should.equal(1)
    await kit.setNode({ wikiId, path: 'about.foo', content: 'edited', actor: human })
    await kit.setNode({ wikiId, path: 'about.foo.old', content: 'edited too', actor: human })
    // and its pages move out
    const moved = await kit.moveNode({ wikiId, fromPath: 'about.foo.old', toPath: 'about.old', actor: human })
    moved.path.should.equal('about.old')
  })
})
