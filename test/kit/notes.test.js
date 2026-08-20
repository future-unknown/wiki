import should from 'should'
import { ValidationError, NotFoundError } from '../../lib/kit/index.js'
import { createTestKit, seedAcme, human, agent, commitCount } from './helpers.js'

describe('notes', () => {
  it('attaches a note to a page without creating a commit or revision', async () => {
    const { kit, db } = await createTestKit()
    const { wikiId } = await seedAcme(kit)
    const before = commitCount(db, wikiId)
    const pageBefore = await kit.getNode({ wikiId, path: 'about.foo' })

    const note = await kit.addNote({
      wikiId, path: 'about.foo', body: 'This looks outdated.', actor: agent
    })
    note.body.should.equal('This looks outdated.')
    note.author.should.deepEqual({ type: 'agent', id: 'agent_test', onBehalfOf: 'user_test' })
    should(note.resolvedAt).be.null()

    commitCount(db, wikiId).should.equal(before)
    const pageAfter = await kit.getNode({ wikiId, path: 'about.foo' })
    pageAfter.revisionId.should.equal(pageBefore.revisionId)
  })

  it('lists notes as a thread, excluding resolved by default', async () => {
    const { kit } = await createTestKit()
    const { wikiId } = await seedAcme(kit)
    const first = await kit.addNote({ wikiId, path: 'about.foo', body: 'first', actor: human })
    await kit.addNote({ wikiId, path: 'about.foo', body: 'second', actor: agent })
    await kit.resolveNote({ wikiId, path: 'about.foo', noteId: first.id, actor: human })

    const open = await kit.listNotes({ wikiId, path: 'about.foo' })
    open.map((note) => note.body).should.deepEqual(['second'])

    const all = await kit.listNotes({ wikiId, path: 'about.foo', includeResolved: true })
    all.map((note) => note.body).should.deepEqual(['first', 'second'])
    all[0].resolvedBy.should.deepEqual({ type: 'human', id: 'user_test' })
  })

  it('never lets a note conflict with a conditional content edit', async () => {
    const { kit } = await createTestKit()
    const { wikiId } = await seedAcme(kit)
    const page = await kit.getNode({ wikiId, path: 'about.foo' })
    await kit.addNote({ wikiId, path: 'about.foo', body: 'note in between', actor: agent })
    const result = await kit.setNode({
      wikiId, path: 'about.foo', content: 'edited after a note', expectedRevisionId: page.revisionId, actor: human
    })
    result.changed.should.be.true()
  })

  it('keeps notes attached across moves', async () => {
    const { kit } = await createTestKit()
    const { wikiId } = await seedAcme(kit)
    await kit.addNote({ wikiId, path: 'about.foo', body: 'sticky', actor: human })
    await kit.moveNode({ wikiId, fromPath: 'about.foo', toPath: 'about.renamed', actor: human })
    const notes = await kit.listNotes({ wikiId, path: 'about.renamed' })
    notes.map((note) => note.body).should.deepEqual(['sticky'])
  })

  it('resolves idempotently and validates inputs', async () => {
    const { kit } = await createTestKit()
    const { wikiId } = await seedAcme(kit)
    const note = await kit.addNote({ wikiId, path: 'about.foo', body: 'resolve me', actor: human })

    const resolved = await kit.resolveNote({ wikiId, path: 'about.foo', noteId: note.id, actor: agent })
    resolved.resolvedBy.should.deepEqual({ type: 'agent', id: 'agent_test' })
    const again = await kit.resolveNote({ wikiId, path: 'about.foo', noteId: note.id, actor: human })
    again.resolvedAt.should.equal(resolved.resolvedAt)
    again.resolvedBy.should.deepEqual({ type: 'agent', id: 'agent_test' })

    await kit.resolveNote({ wikiId, path: 'about.foo', noteId: 'nope', actor: human })
      .should.be.rejectedWith(NotFoundError)
    await kit.addNote({ wikiId, path: 'about.foo', body: '   ', actor: human })
      .should.be.rejectedWith(ValidationError)
    await kit.addNote({ wikiId, path: 'about.foo', body: 'x'.repeat(10001), actor: human })
      .should.be.rejectedWith(ValidationError)
    await kit.addNote({ wikiId, path: 'about.nope', body: 'x', actor: human })
      .should.be.rejectedWith(NotFoundError)
  })

  it('lists a subtree of notes as a queue ordered by page then age', async () => {
    const { kit } = await createTestKit()
    const { wikiId } = await seedAcme(kit)
    await kit.addNote({ wikiId, path: 'about.foo', body: 'foo note', actor: human })
    await kit.addNote({ wikiId, path: 'about.bar', body: 'bar note one', actor: human })
    await kit.addNote({ wikiId, path: 'about.bar', body: 'bar note two', actor: agent })
    await kit.addNote({ wikiId, path: 'about', body: 'section note', actor: human })

    const queue = await kit.listNotes({ wikiId, path: 'about', subtree: true })
    queue.map((note) => [note.path, note.body]).should.deepEqual([
      ['about', 'section note'],
      ['about.bar', 'bar note one'],
      ['about.bar', 'bar note two'],
      ['about.foo', 'foo note']
    ])

    // whole-wiki queue is the root subtree
    const all = await kit.listNotes({ wikiId, path: '', subtree: true })
    all.length.should.equal(4)

    // exact-page listing is unchanged and carries the page path
    const exact = await kit.listNotes({ wikiId, path: 'about.bar' })
    exact.map((note) => note.path).should.deepEqual(['about.bar', 'about.bar'])
  })

  it('keeps the queue current across moves and deletes', async () => {
    const { kit } = await createTestKit()
    const { wikiId } = await seedAcme(kit)
    await kit.addNote({ wikiId, path: 'about.foo', body: 'moving note', actor: human })
    await kit.addNote({ wikiId, path: 'about.baz', body: 'doomed note', actor: human })

    await kit.moveNode({ wikiId, fromPath: 'about.foo', toPath: 'about.renamed', actor: human })
    await kit.deleteNode({ wikiId, path: 'about.baz', actor: human })

    const queue = await kit.listNotes({ wikiId, path: '', subtree: true })
    queue.map((note) => [note.path, note.body]).should.deepEqual([
      ['about.renamed', 'moving note']
    ])
  })

  it('scopes note lookups to the page', async () => {
    const { kit } = await createTestKit()
    const { wikiId } = await seedAcme(kit)
    const note = await kit.addNote({ wikiId, path: 'about.foo', body: 'on foo', actor: human })
    // resolving through a different page refuses
    await kit.resolveNote({ wikiId, path: 'about.bar', noteId: note.id, actor: human })
      .should.be.rejectedWith(NotFoundError)
    const bar = await kit.listNotes({ wikiId, path: 'about.bar' })
    bar.length.should.equal(0)
  })
})
