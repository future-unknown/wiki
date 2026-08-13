import should from 'should'
import {
  ValidationError,
  NotFoundError,
  AlreadyExistsError,
  RevisionConflictError,
  parseFullPath,
  parseRelativePath
} from '../lib/index.js'
import { createTestKit, seedAcme, human, agent, commitCount, revisionCount } from './helpers.js'

describe('wiki creation', () => {
  it('creates a root wiki whose node id is the wiki id', async () => {
    const { kit } = await createTestKit()
    const root = await kit.createWiki({ slug: 'acme', content: 'This is the acme wiki', actor: human })
    root.id.should.equal(root.wikiId)
    should(root.parentId).be.null()
    root.slug.should.equal('acme')
    root.path.should.equal('')
    root.content.should.equal('This is the acme wiki')
    should(root.title).be.null()
    root.metadata.should.deepEqual({})
    root.revisionId.should.be.a.String()
    root.commitId.should.be.a.Number()
  })

  it('resolves a wiki by slug', async () => {
    const { kit } = await createTestKit()
    const root = await kit.createWiki({ slug: 'acme', content: 'hi', actor: human })
    const resolved = await kit.resolveWikiBySlug({ slug: 'acme' })
    resolved.id.should.equal(root.id)
    should(await kit.resolveWikiBySlug({ slug: 'nope' })).be.null()
  })

  it('rejects duplicate root slugs', async () => {
    const { kit } = await createTestKit()
    await kit.createWiki({ slug: 'acme', content: 'one', actor: human })
    await kit.createWiki({ slug: 'acme', content: 'two', actor: human })
      .should.be.rejectedWith(AlreadyExistsError)
  })

  it('records the creating actor on the commit', async () => {
    const { kit } = await createTestKit()
    const root = await kit.createWiki({ slug: 'acme', content: 'hi', actor: agent, message: 'init' })
    const commit = await kit.getCommit({ wikiId: root.id, commitId: root.commitId })
    commit.actor.should.deepEqual({ type: 'agent', id: 'agent_test', onBehalfOf: 'user_test' })
    commit.message.should.equal('init')
  })

  it('requires an actor', async () => {
    const { kit } = await createTestKit()
    await kit.createWiki({ slug: 'acme', content: 'hi' }).should.be.rejectedWith(ValidationError)
  })
})

describe('path validation', () => {
  it('accepts valid paths', () => {
    parseFullPath('acme').should.deepEqual({ slug: 'acme', path: '' })
    parseFullPath('acme.about.foo-bar').should.deepEqual({ slug: 'acme', path: 'about.foo-bar' })
    parseFullPath('acme.api_v2.authentication').path.should.equal('api_v2.authentication')
    parseRelativePath('').should.deepEqual([])
    parseRelativePath('about.foo').should.deepEqual(['about', 'foo'])
  })

  it('rejects malformed paths', () => {
    for (const bad of ['.acme', 'acme.', 'acme..foo', 'acme.Foo', 'acme.foo.bar.', '', 'acme.-x', 'acme._x', 'a me']) {
      (() => parseFullPath(bad)).should.throw(ValidationError)
    }
  })

  it('rejects malformed paths at the domain boundary', async () => {
    const { kit, } = await createTestKit()
    const { wikiId } = await seedAcme(kit)
    await kit.setNode({ wikiId, path: 'About', content: 'x', actor: human })
      .should.be.rejectedWith(ValidationError)
    await kit.setNode({ wikiId, path: 'a..b', content: 'x', actor: human })
      .should.be.rejectedWith(ValidationError)
  })
})

describe('setNode', () => {
  it('creates nested nodes and reads them back', async () => {
    const { kit } = await createTestKit()
    const { wikiId } = await seedAcme(kit)
    const foo = await kit.getNode({ wikiId, path: 'about.foo' })
    foo.content.should.equal('This is all about foo')
    foo.slug.should.equal('foo')
    foo.path.should.equal('about.foo')
    foo.wikiId.should.equal(wikiId)
  })

  it('refuses writes into a wiki that does not exist', async () => {
    const { kit } = await createTestKit()
    await kit.setNode({ wikiId: 'no-such-wiki', path: 'about', content: 'x', actor: human })
      .should.be.rejectedWith(NotFoundError)
  })

  it('creates implicit intermediate parents in the same commit', async () => {
    const { kit, db } = await createTestKit()
    const root = await kit.createWiki({ slug: 'acme', content: 'root', actor: human })
    const wikiId = root.id
    const before = commitCount(db, wikiId)
    const leaf = await kit.setNode({
      wikiId, path: 'architecture.auth.tokens', content: 'Token documentation', actor: human
    })
    commitCount(db, wikiId).should.equal(before + 1)

    const arch = await kit.getNode({ wikiId, path: 'architecture' })
    const auth = await kit.getNode({ wikiId, path: 'architecture.auth' })
    arch.content.should.equal('')
    should(arch.title).be.null()
    arch.metadata.should.deepEqual({})
    auth.content.should.equal('')

    // all three revisions belong to one commit
    leaf.node.commitId.should.equal(arch.commitId)
    leaf.node.commitId.should.equal(auth.commitId)
    const commit = await kit.getCommit({ wikiId, commitId: leaf.node.commitId })
    commit.revisions.length.should.equal(3)
  })

  it('allows a node to have both content and children', async () => {
    const { kit } = await createTestKit()
    const { wikiId } = await seedAcme(kit)
    const about = await kit.getNode({ wikiId, path: 'about' })
    about.content.should.equal('This is an about section')
    const tree = await kit.getTree({ wikiId, path: 'about' })
    tree.children.length.should.equal(3)
  })

  it('stores and round-trips JSON metadata', async () => {
    const { kit } = await createTestKit()
    const { wikiId } = await seedAcme(kit)
    await kit.setNode({
      wikiId, path: 'about.foo', metadata: { tags: ['a', 'b'], rank: 3 }, actor: human
    })
    const foo = await kit.getNode({ wikiId, path: 'about.foo' })
    foo.metadata.should.deepEqual({ tags: ['a', 'b'], rank: 3 })
    foo.content.should.equal('This is all about foo') // preserved
  })

  it('replaces content and preserves omitted title/metadata', async () => {
    const { kit } = await createTestKit()
    const { wikiId } = await seedAcme(kit)
    await kit.setNode({ wikiId, path: 'about.foo', title: 'Foo', metadata: { a: 1 }, actor: human })
    await kit.setNode({ wikiId, path: 'about.foo', content: 'new content', actor: human })
    const foo = await kit.getNode({ wikiId, path: 'about.foo' })
    foo.content.should.equal('new content')
    foo.title.should.equal('Foo')
    foo.metadata.should.deepEqual({ a: 1 })
  })

  it('treats an identical write as a no-op with no commit or revision', async () => {
    const { kit, db } = await createTestKit()
    const { wikiId } = await seedAcme(kit)
    const before = commitCount(db, wikiId)
    const foo = await kit.getNode({ wikiId, path: 'about.foo' })
    const result = await kit.setNode({
      wikiId, path: 'about.foo', content: 'This is all about foo', actor: human
    })
    result.changed.should.be.false()
    result.node.revisionId.should.equal(foo.revisionId)
    commitCount(db, wikiId).should.equal(before)
    revisionCount(db, foo.id).should.equal(1)
  })

  it('creates exactly one commit and one revision per update', async () => {
    const { kit, db } = await createTestKit()
    const { wikiId } = await seedAcme(kit)
    const foo = await kit.getNode({ wikiId, path: 'about.foo' })
    const before = commitCount(db, wikiId)
    await kit.setNode({ wikiId, path: 'about.foo', content: 'v2', actor: human })
    commitCount(db, wikiId).should.equal(before + 1)
    revisionCount(db, foo.id).should.equal(2)
  })

  it('keeps prior revisions immutable across updates', async () => {
    const { kit, db } = await createTestKit()
    const { wikiId } = await seedAcme(kit)
    const foo = await kit.getNode({ wikiId, path: 'about.foo' })
    await kit.setNode({ wikiId, path: 'about.foo', content: 'v2', actor: human })
    const original = db.prepare('SELECT * FROM node_revisions WHERE id = ?').get(foo.revisionId)
    original.content.should.equal('This is all about foo')
    original.deleted.should.equal(0)
  })
})

describe('optimistic concurrency', () => {
  it('rejects writes with a stale revision id', async () => {
    const { kit } = await createTestKit()
    const { wikiId } = await seedAcme(kit)
    const foo = await kit.getNode({ wikiId, path: 'about.foo' })
    await kit.setNode({ wikiId, path: 'about.foo', content: 'v2', actor: human })
    await kit.setNode({
      wikiId, path: 'about.foo', content: 'v3', expectedRevisionId: foo.revisionId, actor: human
    }).should.be.rejectedWith(RevisionConflictError)
  })

  it('accepts writes with the current revision id', async () => {
    const { kit } = await createTestKit()
    const { wikiId } = await seedAcme(kit)
    const foo = await kit.getNode({ wikiId, path: 'about.foo' })
    const result = await kit.setNode({
      wikiId, path: 'about.foo', content: 'v2', expectedRevisionId: foo.revisionId, actor: human
    })
    result.changed.should.be.true()
  })

  it('does not conflict when unrelated nodes changed in between', async () => {
    const { kit } = await createTestKit()
    const { wikiId } = await seedAcme(kit)
    const foo = await kit.getNode({ wikiId, path: 'about.foo' })
    // unrelated edits create new wiki commits
    await kit.setNode({ wikiId, path: 'sales', content: 'Sales docs', actor: agent })
    await kit.setNode({ wikiId, path: 'about.bar', content: 'bar v2', actor: agent })
    const result = await kit.setNode({
      wikiId, path: 'about.foo', content: 'foo v2', expectedRevisionId: foo.revisionId, actor: human
    })
    result.changed.should.be.true()
    result.node.content.should.equal('foo v2')
  })

  it('conflicts when the expected revision targets a missing node', async () => {
    const { kit } = await createTestKit()
    const { wikiId } = await seedAcme(kit)
    await kit.setNode({
      wikiId, path: 'about.new', content: 'x', expectedRevisionId: 'rev-does-not-exist', actor: human
    }).should.be.rejectedWith(RevisionConflictError)
  })
})

describe('transaction rollback', () => {
  it('rolls back the whole mutation when a step fails', async () => {
    const { kit, db } = await createTestKit()
    const { wikiId } = await seedAcme(kit)
    const before = commitCount(db, wikiId)
    const circular = {}
    circular.self = circular
    await kit.setNode({
      wikiId, path: 'boom.deep.node', content: 'x', metadata: circular, actor: human
    }).should.be.rejected()
    commitCount(db, wikiId).should.equal(before)
    await kit.getNode({ wikiId, path: 'boom' }).should.be.rejectedWith(NotFoundError)
  })
})
