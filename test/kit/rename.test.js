import should from 'should'
import { AlreadyExistsError, NotFoundError, ValidationError } from '../../lib/kit/index.js'
import { createTestKit, seedAcme, human } from './helpers.js'

describe('renameWiki', () => {
  it('stores a wiki under a new slug without a commit, its history reading the same', async () => {
    const { kit } = await createTestKit()
    const { wikiId } = await seedAcme(kit)
    const before = await kit.getNodeHistory({ wikiId, path: 'about.foo' })
    const log = await kit.getLog({ wikiId })

    const root = await kit.renameWiki({ wikiId, slug: 'general' })
    root.slug.should.equal('general')
    root.id.should.equal(wikiId)
    ;(await kit.resolveWikiBySlug({ slug: 'general' })).id.should.equal(wikiId)
    should(await kit.resolveWikiBySlug({ slug: 'acme' })).be.null()
    ;(await kit.getLog({ wikiId })).length.should.equal(log.length)
    ;(await kit.getNodeHistory({ wikiId, path: 'about.foo' })).should.deepEqual(before)
    ;(await kit.getNode({ wikiId, path: 'about.foo' })).content.should.equal('This is all about foo')
    ;(await kit.renameWiki({ wikiId, slug: 'general' })).slug.should.equal('general')
  })

  it('refuses a slug another wiki holds, a bad slug, and a wiki that does not exist', async () => {
    const { kit } = await createTestKit()
    const { wikiId } = await seedAcme(kit)
    await kit.createWiki({ slug: 'labs', content: 'l', actor: human })
    await kit.renameWiki({ wikiId, slug: 'labs' }).should.be.rejectedWith(AlreadyExistsError)
    await kit.renameWiki({ wikiId, slug: 'Bad Slug' }).should.be.rejectedWith(ValidationError)
    await kit.renameWiki({ wikiId: 'nope', slug: 'x' }).should.be.rejectedWith(NotFoundError)
  })
})
