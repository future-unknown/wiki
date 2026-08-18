import should from 'should'
import {
  ValidationError,
  NotFoundError,
  RevisionConflictError,
  NonEmptyNodeError
} from '../../lib/kit/index.js'
import { createTestKit, seedAcme, human, commitCount } from './helpers.js'

describe('deleteNode', () => {
  it('deletes a leaf node', async () => {
    const { kit } = await createTestKit()
    const { wikiId } = await seedAcme(kit)
    const result = await kit.deleteNode({ wikiId, path: 'about.foo', actor: human })
    result.deletedPaths.should.deepEqual(['about.foo'])
    await kit.getNode({ wikiId, path: 'about.foo' }).should.be.rejectedWith(NotFoundError)
  })

  it('rejects deleting a non-empty node without recursive', async () => {
    const { kit } = await createTestKit()
    const { wikiId } = await seedAcme(kit)
    await kit.deleteNode({ wikiId, path: 'about', actor: human })
      .should.be.rejectedWith(NonEmptyNodeError)
  })

  it('recursively tombstones a subtree in one commit', async () => {
    const { kit, db } = await createTestKit()
    const { wikiId } = await seedAcme(kit)
    const before = commitCount(db, wikiId)
    const result = await kit.deleteNode({ wikiId, path: 'about', recursive: true, actor: human })
    result.deletedPaths.should.deepEqual(['about', 'about.bar', 'about.baz', 'about.foo'])
    commitCount(db, wikiId).should.equal(before + 1)
    const commit = await kit.getCommit({ wikiId, commitId: result.commitId })
    commit.revisions.length.should.equal(4)
    commit.revisions.every((revision) => revision.deleted).should.be.true()
    await kit.getNode({ wikiId, path: 'about.baz' }).should.be.rejectedWith(NotFoundError)
  })

  it('refuses to delete the wiki root', async () => {
    const { kit } = await createTestKit()
    const { wikiId } = await seedAcme(kit)
    await kit.deleteNode({ wikiId, path: '', actor: human }).should.be.rejectedWith(ValidationError)
  })

  it('preserves history of deleted nodes', async () => {
    const { kit, db } = await createTestKit()
    const { wikiId } = await seedAcme(kit)
    const foo = await kit.getNode({ wikiId, path: 'about.foo' })
    await kit.deleteNode({ wikiId, path: 'about.foo', actor: human })

    const revisions = db.prepare(
      'SELECT * FROM node_revisions WHERE node_id = ? ORDER BY commit_id'
    ).all(foo.id)
    revisions.length.should.equal(2)
    revisions[0].deleted.should.equal(0)
    revisions[0].content.should.equal('This is all about foo')
    revisions[1].deleted.should.equal(1)

    const history = await kit.getNodeHistory({ wikiId, path: 'about.foo' })
    history.length.should.equal(2)
    history[0].deleted.should.be.true()
    history[1].deleted.should.be.false()
  })

  it('honors expectedRevisionId', async () => {
    const { kit } = await createTestKit()
    const { wikiId } = await seedAcme(kit)
    const foo = await kit.getNode({ wikiId, path: 'about.foo' })
    await kit.setNode({ wikiId, path: 'about.foo', content: 'v2', actor: human })
    await kit.deleteNode({
      wikiId, path: 'about.foo', expectedRevisionId: foo.revisionId, actor: human
    }).should.be.rejectedWith(RevisionConflictError)
  })

  it('honors the conservative expectedCommitId for subtree deletes', async () => {
    const { kit, db } = await createTestKit()
    const { wikiId } = await seedAcme(kit)
    const latest = db.prepare('SELECT MAX(id) AS id FROM commits WHERE wiki_id = ?').get(wikiId).id
    await kit.setNode({ wikiId, path: 'sales', content: 'new section', actor: human })
    await kit.deleteNode({
      wikiId, path: 'about', recursive: true, expectedCommitId: latest, actor: human
    }).should.be.rejectedWith(RevisionConflictError)
    // with the true latest commit it succeeds
    const current = db.prepare('SELECT MAX(id) AS id FROM commits WHERE wiki_id = ?').get(wikiId).id
    const result = await kit.deleteNode({
      wikiId, path: 'about', recursive: true, expectedCommitId: current, actor: human
    })
    result.deletedPaths.length.should.equal(4)
  })

  it('creates a new identity when a deleted path is reused', async () => {
    const { kit } = await createTestKit()
    const { wikiId } = await seedAcme(kit)
    const original = await kit.getNode({ wikiId, path: 'about.foo' })
    await kit.deleteNode({ wikiId, path: 'about.foo', actor: human })
    const recreated = await kit.setNode({ wikiId, path: 'about.foo', content: 'fresh foo', actor: human })
    recreated.node.id.should.not.equal(original.id)
    recreated.node.content.should.equal('fresh foo')
    // original identity's tombstoned history is intact
    const history = await kit.getNodeHistory({ wikiId, path: 'about.foo' })
    history.length.should.equal(1)
    history[0].nodeId.should.equal(recreated.node.id)
  })
})
