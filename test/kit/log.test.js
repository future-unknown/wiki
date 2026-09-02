import should from 'should'
import { ValidationError } from '../../lib/kit/index.js'
import { createTestKit, seedAcme, human, agent } from './helpers.js'

describe('getLog', () => {
  it('lists commits newest first with what each did to which page', async () => {
    const { kit } = await createTestKit()
    const { wikiId } = await seedAcme(kit)
    await kit.setNode({ wikiId, path: 'about.foo', content: 'v2', actor: agent, message: 'second draft' })
    await kit.moveNode({ wikiId, fromPath: 'about.bar', toPath: 'bar', actor: human })
    await kit.deleteNode({ wikiId, path: 'about.baz', actor: human })

    const log = await kit.getLog({ wikiId })
    log.length.should.equal(8)
    log.map((entry) => entry.changes.map((change) => `${change.kind} ${change.path}`)).should.deepEqual([
      ['deleted about.baz'],
      ['moved bar'],
      ['updated about.foo'],
      ['created about.baz'],
      // moved nodes are named by where they are now
      ['created bar'],
      ['created about.foo'],
      ['created about'],
      ['created ']
    ])
    log[2].message.should.equal('second draft')
    log[2].actor.should.deepEqual(agent)
    log[0].actor.should.deepEqual(human)
    log[0].changes[0].slug.should.equal('baz')
    should(log[0].createdAt).be.a.String()
    log[0].id.should.be.above(log[1].id)
  })

  it('reads a node written again after deletion as created', async () => {
    const { kit } = await createTestKit()
    const { wikiId } = await seedAcme(kit)
    await kit.deleteNode({ wikiId, path: 'about.baz', actor: human })
    await kit.setNode({ wikiId, path: 'about.baz', content: 'back', actor: human })
    const [latest] = await kit.getLog({ wikiId, limit: 1 })
    latest.changes.map((change) => change.kind).should.deepEqual(['created'])
  })

  it('scopes to a subtree and pages with before', async () => {
    const { kit } = await createTestKit()
    const { wikiId } = await seedAcme(kit)
    await kit.setNode({ wikiId, path: 'other', content: 'elsewhere', actor: human })
    const about = await kit.getLog({ wikiId, path: 'about' })
    about.map((entry) => entry.changes[0].path).should.deepEqual(['about.baz', 'about.bar', 'about.foo', 'about'])

    const first = await kit.getLog({ wikiId, limit: 2 })
    first.length.should.equal(2)
    const next = await kit.getLog({ wikiId, limit: 2, before: first[1].id })
    next.length.should.equal(2)
    next[0].id.should.be.below(first[1].id)
  })

  it('validates its inputs', async () => {
    const { kit } = await createTestKit()
    const { wikiId } = await seedAcme(kit)
    await kit.getLog({ wikiId, limit: 0 }).should.be.rejectedWith(ValidationError)
    await kit.getLog({ wikiId, before: -1 }).should.be.rejectedWith(ValidationError)
    await kit.getLog({ wikiId, path: 'Bad Path' }).should.be.rejectedWith(ValidationError)
  })
})
