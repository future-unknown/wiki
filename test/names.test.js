import should from 'should'
import Database from 'better-sqlite3'
import { createWikiKit, NotFoundError } from '../lib/kit/index.js'
import { createWikiMethods } from '../lib/api/index.js'

const principal = { actor: { type: 'human', id: 'user_1', onBehalfOf: null } }

// Addresses carry an owner's slug in front of each stored name, the way
// a multi-tenant host might: `acme` is the stored `general`, `acme_labs`
// the stored `labs`. Anything else is no wiki of this caller's.
function namesFor (owner) {
  return {
    stored: (slug) => slug === owner ? 'general' : slug.startsWith(owner + '_') ? slug.slice(owner.length + 1) : null,
    addressed: (slug) => slug === 'general' ? owner : `${owner}_${slug}`
  }
}

async function setup () {
  const kit = createWikiKit({ db: new Database(':memory:') })
  await kit.migrate()
  return { kit, as: (owner) => createWikiMethods({ kit, names: namesFor(owner) }) }
}

describe('addressed and stored names', () => {
  it('stores a first write under the stored name and answers with the addressed one', async () => {
    const { kit, as } = await setup()
    const acme = as('acme')
    const written = await acme['wiki.set'](principal, { path: 'acme.docs.intro', content: 'Hi' })
    written.node.fullPath.should.equal('acme.docs.intro')
    ;(await kit.listWikis()).map((wiki) => wiki.slug).should.deepEqual(['general'])
    await acme['wiki.set'](principal, { path: 'acme_labs', content: 'Labs' })
    ;(await kit.listWikis()).map((wiki) => wiki.slug).sort().should.deepEqual(['general', 'labs'])
  })

  it('reads, lists, trees, logs and revisions all speak the addressed slug, the root included', async () => {
    const { as } = await setup()
    const acme = as('acme')
    await acme['wiki.set'](principal, { path: 'acme', content: 'Home' })
    const page = await acme['wiki.set'](principal, { path: 'acme.docs', content: 'Docs' })
    const root = await acme['wiki.get'](principal, { path: 'acme' })
    root.slug.should.equal('acme')
    root.fullPath.should.equal('acme')
    ;(await acme['wiki.list'](principal, {})).map((wiki) => [wiki.slug, wiki.fullPath]).should.deepEqual([['acme', 'acme']])
    ;(await acme['wiki.tree'](principal, { path: 'acme' })).children[0].fullPath.should.equal('acme.docs')
    ;(await acme['wiki.log'](principal, { path: 'acme' }))[0].changes[0].fullPath.should.equal('acme.docs')
    const revision = await acme['wiki.revision'](principal, { wiki: 'acme', revisionId: root.revisionId })
    revision.slug.should.equal('acme')
    const snapshot = await acme['wiki.snapshot'](principal, { wiki: 'acme', commitId: page.node.commitId })
    snapshot.nodes.find((node) => node.path === '').slug.should.equal('acme')
  })

  it('a renamed owner finds the same wiki under its new address, and the old address finds nothing', async () => {
    const { as } = await setup()
    await as('acme')['wiki.set'](principal, { path: 'acme.docs', content: 'Docs' })
    ;(await as('acme-inc')['wiki.get'](principal, { path: 'acme-inc.docs' })).fullPath.should.equal('acme-inc.docs')
    await as('acme-inc')['wiki.get'](principal, { path: 'acme.docs' }).should.be.rejectedWith(NotFoundError)
  })

  it('an address the mapping does not know is no wiki, and never bootstraps one', async () => {
    const { kit, as } = await setup()
    await as('acme')['wiki.set'](principal, { path: 'globex.docs', content: 'x' }).should.be.rejectedWith(NotFoundError)
    await as('acme')['wiki.get'](principal, { path: 'general' }).should.be.rejectedWith(NotFoundError)
    ;(await kit.listWikis()).should.deepEqual([])
  })
})
