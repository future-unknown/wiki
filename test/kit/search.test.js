import should from 'should'
import { ValidationError } from '../../lib/kit/index.js'
import { createTestKit, seedAcme, human } from './helpers.js'

describe('search', () => {
  it('finds nodes by content', async () => {
    const { kit } = await createTestKit()
    const { wikiId } = await seedAcme(kit)
    const results = await kit.search({ wikiId, query: 'foo' })
    results.length.should.equal(1)
    results[0].path.should.equal('about.foo')
    results[0].excerpt.should.containEql('[foo]')
  })

  it('finds nodes by title and path', async () => {
    const { kit } = await createTestKit()
    const { wikiId } = await seedAcme(kit)
    await kit.setNode({ wikiId, path: 'about.foo', title: 'Authentication Guide', actor: human })
    const byTitle = await kit.search({ wikiId, query: 'authentication' })
    byTitle.map((result) => result.path).should.containEql('about.foo')
    const byPath = await kit.search({ wikiId, query: 'baz' })
    byPath.map((result) => result.path).should.containEql('about.baz')
  })

  it('scopes search to a subtree', async () => {
    const { kit } = await createTestKit()
    const { wikiId } = await seedAcme(kit)
    await kit.setNode({ wikiId, path: 'sales.pitch', content: 'foo appears here too', actor: human })
    const all = await kit.search({ wikiId, query: 'foo' })
    all.length.should.equal(2)
    const scoped = await kit.search({ wikiId, path: 'about', query: 'foo' })
    scoped.length.should.equal(1)
    scoped[0].path.should.equal('about.foo')
  })

  it('reflects content updates', async () => {
    const { kit } = await createTestKit()
    const { wikiId } = await seedAcme(kit)
    await kit.setNode({ wikiId, path: 'about.bar', content: 'now about zebras', actor: human })
    const zebras = await kit.search({ wikiId, query: 'zebras' })
    zebras.map((result) => result.path).should.deepEqual(['about.bar'])
    const stale = await kit.search({ wikiId, query: 'bar' })
    // path still matches "bar"; old content must not
    stale.every((result) => result.path === 'about.bar').should.be.true()
  })

  it('keeps indexed paths accurate after a move', async () => {
    const { kit } = await createTestKit()
    const { wikiId } = await seedAcme(kit)
    await kit.setNode({ wikiId, path: 'archive', content: 'archive', actor: human })
    await kit.moveNode({ wikiId, fromPath: 'about.foo', toPath: 'archive.foo', actor: human })
    const results = await kit.search({ wikiId, query: 'foo' })
    results.map((result) => result.path).should.deepEqual(['archive.foo'])
    const scoped = await kit.search({ wikiId, path: 'archive', query: 'foo' })
    scoped.length.should.equal(1)
  })

  it('removes deleted nodes from results', async () => {
    const { kit } = await createTestKit()
    const { wikiId } = await seedAcme(kit)
    await kit.deleteNode({ wikiId, path: 'about', recursive: true, actor: human })
    const results = await kit.search({ wikiId, query: 'foo' })
    results.length.should.equal(0)
  })

  it('does not leak results across wikis', async () => {
    const { kit } = await createTestKit()
    const { wikiId } = await seedAcme(kit)
    const other = await kit.createWiki({ slug: 'other', content: 'foo lives here too', actor: human })
    const results = await kit.search({ wikiId, query: 'foo' })
    results.length.should.equal(1)
    const otherResults = await kit.search({ wikiId: other.id, query: 'foo' })
    otherResults.length.should.equal(1)
    otherResults[0].path.should.equal('')
  })

  it('treats FTS syntax in queries as literal text', async () => {
    const { kit } = await createTestKit()
    const { wikiId } = await seedAcme(kit)
    const results = await kit.search({ wikiId, query: 'foo AND "bar' })
    results.should.be.an.Array()
  })

  it('rejects an empty query', async () => {
    const { kit } = await createTestKit()
    const { wikiId } = await seedAcme(kit)
    await kit.search({ wikiId, query: '   ' }).should.be.rejectedWith(ValidationError)
  })
})

describe('getTree (current)', () => {
  it('builds the full tree with sorted children', async () => {
    const { kit } = await createTestKit()
    const { wikiId } = await seedAcme(kit)
    const tree = await kit.getTree({ wikiId })
    tree.path.should.equal('')
    tree.children.length.should.equal(1)
    tree.children[0].children.map((child) => child.slug).should.deepEqual(['bar', 'baz', 'foo'])
  })

  it('supports subtree roots and depth limits', async () => {
    const { kit } = await createTestKit()
    const { wikiId } = await seedAcme(kit)
    await kit.setNode({ wikiId, path: 'about.foo.deep', content: 'deep', actor: human })
    const shallow = await kit.getTree({ wikiId, depth: 1 })
    shallow.children[0].children.length.should.equal(0)
    const about = await kit.getTree({ wikiId, path: 'about', depth: 1 })
    about.path.should.equal('about')
    about.children.length.should.equal(3)
    about.children.find((child) => child.slug === 'foo').children.length.should.equal(0)
  })
})
