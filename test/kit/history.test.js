import should from 'should'
import { ValidationError, NotFoundError } from '../../lib/kit/index.js'
import { createTestKit, seedAcme, human, sleep } from './helpers.js'

describe('historical reconstruction', () => {
  it('reconstructs the complete wiki at an earlier commit', async () => {
    const { kit } = await createTestKit()
    const { wikiId } = await seedAcme(kit)
    const fooV1 = await kit.getNode({ wikiId, path: 'about.foo' })
    await kit.setNode({ wikiId, path: 'about.foo', content: 'foo v2', actor: human })
    await kit.setNode({ wikiId, path: 'about.qux', content: 'later addition', actor: human })

    const snapshot = await kit.getSnapshot({ wikiId, commitId: fooV1.commitId })
    snapshot.commitId.should.equal(fooV1.commitId)
    const paths = snapshot.nodes.map((node) => node.path)
    paths.should.deepEqual(['', 'about', 'about.foo'])
    const foo = snapshot.nodes.find((node) => node.path === 'about.foo')
    foo.content.should.equal('This is all about foo')
    foo.revisionId.should.equal(fooV1.revisionId)
  })

  it('reconstructs deleted state: present before, absent after', async () => {
    const { kit } = await createTestKit()
    const { wikiId } = await seedAcme(kit)
    const beforeDelete = (await kit.getNode({ wikiId, path: 'about.baz' })).commitId
    const result = await kit.deleteNode({ wikiId, path: 'about.baz', actor: human })

    const before = await kit.getSnapshot({ wikiId, commitId: result.commitId - 1 })
    before.nodes.map((node) => node.path).should.containEql('about.baz')
    const after = await kit.getSnapshot({ wikiId, commitId: result.commitId })
    after.nodes.map((node) => node.path).should.not.containEql('about.baz')

    const past = await kit.getNode({ wikiId, path: 'about.baz', commitId: beforeDelete })
    past.content.should.equal('This is all about baz')
  })

  it('serves a tree at a commit', async () => {
    const { kit } = await createTestKit()
    const { wikiId } = await seedAcme(kit)
    const fooCommit = (await kit.getNode({ wikiId, path: 'about.foo' })).commitId
    await kit.setNode({ wikiId, path: 'about.qux', content: 'later', actor: human })

    const tree = await kit.getTree({ wikiId, commitId: fooCommit })
    tree.path.should.equal('')
    tree.children.length.should.equal(1)
    tree.children[0].slug.should.equal('about')
    tree.children[0].children.map((child) => child.slug).should.deepEqual(['foo'])
  })

  it('serves a tree at a timestamp', async () => {
    const { kit } = await createTestKit()
    const root = await kit.createWiki({ slug: 'acme', content: 'root', actor: human })
    const wikiId = root.id
    await kit.setNode({ wikiId, path: 'early', content: 'early node', actor: human })
    await sleep(10)
    const between = new Date().toISOString()
    await sleep(10)
    await kit.setNode({ wikiId, path: 'late', content: 'late node', actor: human })

    const tree = await kit.getTree({ wikiId, at: between })
    tree.children.map((child) => child.slug).should.deepEqual(['early'])

    const nowTree = await kit.getTree({ wikiId, at: new Date().toISOString() })
    nowTree.children.map((child) => child.slug).should.deepEqual(['early', 'late'])
  })

  it('rejects commitId and at together', async () => {
    const { kit } = await createTestKit()
    const { wikiId } = await seedAcme(kit)
    await kit.getTree({ wikiId, commitId: 1, at: new Date().toISOString() })
      .should.be.rejectedWith(ValidationError)
  })

  it('rejects a timestamp before the wiki existed', async () => {
    const { kit } = await createTestKit()
    const { wikiId } = await seedAcme(kit)
    await kit.getSnapshot({ wikiId, at: '2000-01-01T00:00:00Z' })
      .should.be.rejectedWith(NotFoundError)
  })

  it('rejects an unknown commit id', async () => {
    const { kit } = await createTestKit()
    const { wikiId } = await seedAcme(kit)
    await kit.getSnapshot({ wikiId, commitId: 9999 }).should.be.rejectedWith(NotFoundError)
  })

  it('returns node history newest-first with commit info', async () => {
    const { kit } = await createTestKit()
    const { wikiId } = await seedAcme(kit)
    await kit.setNode({ wikiId, path: 'about.foo', content: 'v2', actor: human, message: 'second draft' })
    const history = await kit.getNodeHistory({ wikiId, path: 'about.foo' })
    history.length.should.equal(2)
    history[0].content.should.equal('v2')
    history[0].commit.message.should.equal('second draft')
    history[0].commit.actor.type.should.equal('human')
    history[1].content.should.equal('This is all about foo')
  })
})

describe('getRevision', () => {
  it('returns a revision with its previous one, kind, and current path', async () => {
    const { kit } = await createTestKit()
    const { wikiId } = await seedAcme(kit)
    const v1 = await kit.getNode({ wikiId, path: 'about.foo' })
    const v2 = await kit.setNode({ wikiId, path: 'about.foo', content: 'foo v2', actor: human, message: 'second draft' })
    const revision = await kit.getRevision({ wikiId, revisionId: v2.node.revisionId })
    revision.revisionId.should.equal(v2.node.revisionId)
    revision.path.should.equal('about.foo')
    revision.kind.should.equal('updated')
    revision.content.should.equal('foo v2')
    revision.commit.message.should.equal('second draft')
    revision.previous.revisionId.should.equal(v1.revisionId)
    revision.previous.content.should.equal('This is all about foo')
  })

  it('has no previous revision for a first one, and reads it as created', async () => {
    const { kit } = await createTestKit()
    const { wikiId } = await seedAcme(kit)
    const first = await kit.getNode({ wikiId, path: 'about.foo' })
    const revision = await kit.getRevision({ wikiId, revisionId: first.revisionId })
    revision.kind.should.equal('created')
    should(revision.previous).be.null()
  })

  it('names the current path after a move, and reads a tombstone as deleted', async () => {
    const { kit } = await createTestKit()
    const { wikiId } = await seedAcme(kit)
    const moved = await kit.moveNode({ wikiId, fromPath: 'about.foo', toPath: 'foo', actor: human })
    const afterMove = await kit.getRevision({ wikiId, revisionId: moved.revisionId })
    afterMove.kind.should.equal('moved')
    afterMove.path.should.equal('foo')
    afterMove.previous.slug.should.equal('foo')
    const removed = await kit.deleteNode({ wikiId, path: 'foo', actor: human })
    const history = await kit.getNodeHistory({ wikiId, path: 'foo' })
    history[0].commitId.should.equal(removed.commitId)
    const tombstone = await kit.getRevision({ wikiId, revisionId: history[0].revisionId })
    tombstone.kind.should.equal('deleted')
    tombstone.path.should.equal('foo')
    tombstone.previous.revisionId.should.equal(moved.revisionId)
  })

  it('rejects an unknown or foreign revision id', async () => {
    const { kit } = await createTestKit()
    const a = await kit.createWiki({ slug: 'a', content: 'a', actor: human })
    const b = await kit.createWiki({ slug: 'b', content: 'b', actor: human })
    await kit.getRevision({ wikiId: a.id, revisionId: 'nope' }).should.be.rejectedWith(NotFoundError)
    await kit.getRevision({ wikiId: a.id, revisionId: b.revisionId }).should.be.rejectedWith(NotFoundError)
    await kit.getRevision({ wikiId: a.id, revisionId: '' }).should.be.rejectedWith(ValidationError)
  })
})

describe('getCommit', () => {
  it('returns commit metadata and touched revisions', async () => {
    const { kit } = await createTestKit()
    const root = await kit.createWiki({ slug: 'acme', content: 'root', actor: human, message: 'genesis' })
    const commit = await kit.getCommit({ wikiId: root.id, commitId: root.commitId })
    commit.message.should.equal('genesis')
    commit.revisions.length.should.equal(1)
    commit.revisions[0].nodeId.should.equal(root.id)
  })

  it('scopes commits to the wiki', async () => {
    const { kit } = await createTestKit()
    const a = await kit.createWiki({ slug: 'aaa', content: 'a', actor: human })
    const b = await kit.createWiki({ slug: 'bbb', content: 'b', actor: human })
    await kit.getCommit({ wikiId: a.id, commitId: b.commitId }).should.be.rejectedWith(NotFoundError)
  })
})
