import should from 'should'
import {
  NotFoundError,
  AlreadyExistsError,
  RevisionConflictError,
  InvalidMoveError
} from '../../lib/kit/index.js'
import { createTestKit, human, commitCount } from './helpers.js'

async function seedProjects (kit) {
  const root = await kit.createWiki({ slug: 'acme', content: 'root', actor: human })
  const wikiId = root.id
  await kit.setNode({ wikiId, path: 'projects.foo', content: 'Foo project', actor: human })
  await kit.setNode({ wikiId, path: 'projects.foo.backend.api', content: 'API docs', actor: human })
  await kit.setNode({ wikiId, path: 'archive', content: 'Archived things', actor: human })
  return { wikiId }
}

describe('moveNode', () => {
  it('moves a node, preserving identity and content', async () => {
    const { kit } = await createTestKit()
    const { wikiId } = await seedProjects(kit)
    const before = await kit.getNode({ wikiId, path: 'projects.foo' })
    const moved = await kit.moveNode({
      wikiId, fromPath: 'projects.foo', toPath: 'archive.foo', actor: human
    })
    moved.id.should.equal(before.id)
    moved.path.should.equal('archive.foo')
    moved.slug.should.equal('foo')
    moved.content.should.equal('Foo project')
    await kit.getNode({ wikiId, path: 'projects.foo' }).should.be.rejectedWith(NotFoundError)
  })

  it('can rename within the same parent', async () => {
    const { kit } = await createTestKit()
    const { wikiId } = await seedProjects(kit)
    const moved = await kit.moveNode({
      wikiId, fromPath: 'projects.foo', toPath: 'projects.bar', actor: human
    })
    moved.slug.should.equal('bar')
    moved.path.should.equal('projects.bar')
  })

  it('updates current paths of all descendants without new revisions for them', async () => {
    const { kit, db } = await createTestKit()
    const { wikiId } = await seedProjects(kit)
    const api = await kit.getNode({ wikiId, path: 'projects.foo.backend.api' })
    const backend = await kit.getNode({ wikiId, path: 'projects.foo.backend' })

    await kit.moveNode({ wikiId, fromPath: 'projects.foo', toPath: 'archive.foo', actor: human })

    const apiAfter = await kit.getNode({ wikiId, path: 'archive.foo.backend.api' })
    apiAfter.id.should.equal(api.id)
    apiAfter.revisionId.should.equal(api.revisionId) // no fake revision
    const backendAfter = await kit.getNode({ wikiId, path: 'archive.foo.backend' })
    backendAfter.id.should.equal(backend.id)
    backendAfter.revisionId.should.equal(backend.revisionId)

    // only the moved node received a revision in the move commit
    const moveCommitId = (await kit.getNode({ wikiId, path: 'archive.foo' })).commitId
    const commit = await kit.getCommit({ wikiId, commitId: moveCommitId })
    commit.revisions.length.should.equal(1)
    db.prepare('SELECT COUNT(*) AS n FROM node_revisions WHERE node_id = ?').get(api.id).n.should.equal(1)
  })

  it('creates exactly one commit per move', async () => {
    const { kit, db } = await createTestKit()
    const { wikiId } = await seedProjects(kit)
    const before = commitCount(db, wikiId)
    await kit.moveNode({ wikiId, fromPath: 'projects.foo', toPath: 'archive.foo', actor: human })
    commitCount(db, wikiId).should.equal(before + 1)
  })

  it('reconstructs historical paths before and after the move', async () => {
    const { kit } = await createTestKit()
    const { wikiId } = await seedProjects(kit)
    const beforeCommit = (await kit.getNode({ wikiId, path: 'projects.foo.backend.api' })).commitId
    const moved = await kit.moveNode({
      wikiId, fromPath: 'projects.foo', toPath: 'archive.foo', actor: human
    })

    const past = await kit.getNode({ wikiId, path: 'projects.foo.backend.api', commitId: beforeCommit })
    past.path.should.equal('projects.foo.backend.api')
    const present = await kit.getNode({ wikiId, path: 'archive.foo.backend.api', commitId: moved.commitId })
    present.id.should.equal(past.id)
    await kit.getNode({ wikiId, path: 'projects.foo.backend.api', commitId: moved.commitId })
      .should.be.rejectedWith(NotFoundError)
  })

  it('refuses to move the root', async () => {
    const { kit } = await createTestKit()
    const { wikiId } = await seedProjects(kit)
    await kit.moveNode({ wikiId, fromPath: '', toPath: 'x', actor: human })
      .should.be.rejectedWith(InvalidMoveError)
  })

  it('refuses to move a node beneath itself', async () => {
    const { kit } = await createTestKit()
    const { wikiId } = await seedProjects(kit)
    await kit.moveNode({
      wikiId, fromPath: 'projects.foo', toPath: 'projects.foo.sub', actor: human
    }).should.be.rejectedWith(InvalidMoveError)
    await kit.moveNode({
      wikiId, fromPath: 'projects.foo', toPath: 'projects.foo', actor: human
    }).should.be.rejectedWith(InvalidMoveError)
  })

  it('refuses a destination that already exists', async () => {
    const { kit } = await createTestKit()
    const { wikiId } = await seedProjects(kit)
    await kit.moveNode({
      wikiId, fromPath: 'projects.foo', toPath: 'archive', actor: human
    }).should.be.rejectedWith(AlreadyExistsError)
  })

  it('requires the destination parent to exist', async () => {
    const { kit } = await createTestKit()
    const { wikiId } = await seedProjects(kit)
    await kit.moveNode({
      wikiId, fromPath: 'projects.foo', toPath: 'nowhere.foo', actor: human
    }).should.be.rejectedWith(NotFoundError)
  })

  it('honors expectedRevisionId', async () => {
    const { kit } = await createTestKit()
    const { wikiId } = await seedProjects(kit)
    const foo = await kit.getNode({ wikiId, path: 'projects.foo' })
    await kit.setNode({ wikiId, path: 'projects.foo', content: 'changed', actor: human })
    await kit.moveNode({
      wikiId,
      fromPath: 'projects.foo',
      toPath: 'archive.foo',
      expectedRevisionId: foo.revisionId,
      actor: human
    }).should.be.rejectedWith(RevisionConflictError)
  })
})
