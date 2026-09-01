import should from 'should'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createCliFixture } from './helpers.js'

describe('wiki CLI (end to end)', () => {
  let fixture
  let wiki

  before(async () => {
    fixture = await createCliFixture()
    wiki = fixture.wiki
  })

  after(async () => {
    await fixture.close()
  })

  describe('the canonical workflow', () => {
    it('builds the acme wiki', async () => {
      for (const [target, content] of [
        ['acme', 'This is the acme wiki'],
        ['acme.about', 'This is an about section'],
        ['acme.about.foo', 'This is all about foo'],
        ['acme.about.bar', 'This is all about bar'],
        ['acme.about.baz', 'This is all about baz']
      ]) {
        const result = await wiki(['set', target, content])
        result.code.should.equal(0, result.stderr)
      }
    })

    it('creates a brand-new wiki from a nested write', async () => {
      const result = await wiki(['set', 'fresh.docs.intro', 'Welcome to fresh', '--json'])
      result.code.should.equal(0, result.stderr)
      const parsed = JSON.parse(result.stdout)
      parsed.created.should.be.true()
      parsed.node.fullPath.should.equal('fresh.docs.intro')
      const tree = await wiki(['tree', 'fresh'])
      tree.code.should.equal(0)
      tree.stdout.should.containEql('└── docs')
    })

    it('gets raw content on stdout', async () => {
      const result = await wiki(['get', 'acme.about.foo'])
      result.code.should.equal(0)
      result.stdout.should.equal('This is all about foo\n')
    })

    it('renders a human tree with previews', async () => {
      const result = await wiki(['tree', 'acme'])
      result.code.should.equal(0)
      result.stdout.should.containEql('acme')
      result.stdout.should.containEql('└── about')
      result.stdout.should.containEql('├── bar')
      result.stdout.should.containEql('This is the acme wiki')
      result.stdout.should.containEql('This is all about foo')
    })

    it('searches within the wiki', async () => {
      const result = await wiki(['search', 'acme', 'foo'])
      result.code.should.equal(0)
      result.stdout.should.containEql('acme.about.foo')
      const scoped = await wiki(['search', 'acme.about', 'baz', '--json'])
      JSON.parse(scoped.stdout)[0].fullPath.should.equal('acme.about.baz')
    })

    it('shows history', async () => {
      const result = await wiki(['history', 'acme.about.foo'])
      result.code.should.equal(0)
      result.stdout.should.containEql('commit')
      result.stdout.should.containEql('agent:cli_test (for user_test)')
    })
  })

  describe('safe agent-edit workflow', () => {
    it('reads with --json, writes with --if-revision, then detects staleness', async () => {
      const read = await wiki(['get', 'acme.about.foo', '--json'])
      read.code.should.equal(0)
      const node = JSON.parse(read.stdout)
      node.should.have.properties(
        'id', 'wikiId', 'fullPath', 'slug', 'title', 'content',
        'metadata', 'revisionId', 'commitId', 'createdAt', 'updatedAt'
      )

      const update = await wiki(
        ['set', 'acme.about.foo', 'Updated foo docs', '--if-revision', node.revisionId, '--json']
      )
      update.code.should.equal(0, update.stderr)
      const updated = JSON.parse(update.stdout)
      updated.changed.should.be.true()
      updated.node.revisionId.should.not.equal(node.revisionId)

      // a second write using the stale revision must conflict with exit code 4
      const stale = await wiki(
        ['set', 'acme.about.foo', 'Conflicting edit', '--if-revision', node.revisionId]
      )
      stale.code.should.equal(4)
      stale.stderr.should.containEql('wiki:')

      const current = await wiki(['get', 'acme.about.foo'])
      current.stdout.should.equal('Updated foo docs\n')
    })
  })

  describe('set input sources', () => {
    it('accepts stdin', async () => {
      const result = await wiki(['set', 'acme.stdin-doc'], { stdin: '# From stdin\n\nBody.\n' })
      result.code.should.equal(0, result.stderr)
      const read = await wiki(['get', 'acme.stdin-doc'])
      read.stdout.should.equal('# From stdin\n\nBody.\n')
    })

    it('accepts --file', async () => {
      const file = path.join(os.tmpdir(), `wiki-test-${process.pid}.md`)
      fs.writeFileSync(file, '# From a file\n')
      try {
        const result = await wiki(['set', 'acme.file-doc', '--file', file])
        result.code.should.equal(0, result.stderr)
        const read = await wiki(['get', 'acme.file-doc'])
        read.stdout.should.equal('# From a file\n')
      } finally {
        fs.unlinkSync(file)
      }
    })

    it('rejects multiple content sources', async () => {
      const result = await wiki(['set', 'acme.doc', 'inline', '--file', 'x.md'])
      result.code.should.equal(2)
    })

    it('supports --title and --metadata', async () => {
      const result = await wiki([
        'set', 'acme.meta-doc', 'body', '--title', 'Meta Doc', '--metadata', '{"tags":["x"]}'
      ])
      result.code.should.equal(0, result.stderr)
      const read = JSON.parse((await wiki(['get', 'acme.meta-doc', '--json'])).stdout)
      read.title.should.equal('Meta Doc')
      read.metadata.should.deepEqual({ tags: ['x'] })
    })

    it('rejects invalid --metadata JSON', async () => {
      const result = await wiki(['set', 'acme.doc', 'x', '--metadata', 'not json'])
      result.code.should.equal(2)
    })
  })

  describe('historical reads', () => {
    it('reads a node at an earlier commit', async () => {
      const before = JSON.parse((await wiki(['get', 'acme.about.bar', '--json'])).stdout)
      await wiki(['set', 'acme.about.bar', 'bar v2'])
      const past = await wiki(['get', 'acme.about.bar', '--commit', String(before.commitId)])
      past.stdout.should.equal('This is all about bar\n')
      const nowRead = await wiki(['get', 'acme.about.bar'])
      nowRead.stdout.should.equal('bar v2\n')
    })

    it('serves tree --at a timestamp', async () => {
      await new Promise((resolve) => setTimeout(resolve, 10))
      const stamp = new Date().toISOString()
      await new Promise((resolve) => setTimeout(resolve, 10))
      await wiki(['set', 'acme.newest', 'created after the stamp'])
      const past = await wiki(['tree', 'acme', '--at', stamp])
      past.code.should.equal(0)
      past.stdout.should.not.containEql('newest')
      const present = await wiki(['tree', 'acme'])
      present.stdout.should.containEql('newest')
    })

    it('rejects --commit with --at', async () => {
      const result = await wiki(['tree', 'acme', '--commit', '1', '--at', new Date().toISOString()])
      result.code.should.equal(2)
    })
  })

  describe('move and rm', () => {
    it('moves a subtree preserving identity', async () => {
      await wiki(['set', 'acme.projects.alpha.notes', 'alpha notes'])
      const before = JSON.parse((await wiki(['get', 'acme.projects.alpha.notes', '--json'])).stdout)
      const moved = await wiki(['move', 'acme.projects', 'acme.archive', '--json'])
      moved.code.should.equal(0, moved.stderr)
      const after = JSON.parse((await wiki(['get', 'acme.archive.alpha.notes', '--json'])).stdout)
      after.id.should.equal(before.id)
      const gone = await wiki(['get', 'acme.projects.alpha.notes'])
      gone.code.should.equal(3)
    })

    it('refuses non-empty deletes without --recursive, exit code 4', async () => {
      const result = await wiki(['rm', 'acme.archive'])
      result.code.should.equal(4)
      const recursive = await wiki(['rm', 'acme.archive', '--recursive', '--json'])
      recursive.code.should.equal(0, recursive.stderr)
      JSON.parse(recursive.stdout).deletedPaths.should.containEql('acme.archive.alpha.notes')
    })

    it('honors --if-commit', async () => {
      await wiki(['set', 'acme.tmp', 'temp'])
      const result = await wiki(['rm', 'acme.tmp', '--if-commit', '1'])
      result.code.should.equal(4)
    })
  })

  describe('put, del, data, and meta', () => {
    it('puts inline JSON and reads the latest record back', async () => {
      await wiki(['set', 'acme.usage', 'Daily API usage.'])
      const put = await wiki(['put', 'acme.usage', '{"requests": 1042}', '--json'])
      put.code.should.equal(0, put.stderr)
      JSON.parse(put.stdout).record.requests.should.equal(1042)

      const latest = await wiki(['data', 'acme.usage', '--latest', '--json'])
      latest.code.should.equal(0, latest.stderr)
      const parsed = JSON.parse(latest.stdout)
      parsed.fullPath.should.equal('acme.usage')
      parsed.records.length.should.equal(1)
      parsed.records[0].requests.should.equal(1042)
      parsed.records[0].should.have.properties('_id', '_ts', '_actor', '_v')
    })

    it('puts from stdin and renders a human listing', async () => {
      const result = await wiki(['put', 'acme.usage', '--ts', '2020-01-01T00:00:00Z'],
        { stdin: '{"requests": 1}\n' })
      result.code.should.equal(0, result.stderr)
      result.stderr.should.containEql('put acme.usage')

      const listed = await wiki(['data', 'acme.usage', '--until', '2020-06-01T00:00:00Z'])
      listed.code.should.equal(0)
      listed.stdout.should.containEql('2020-01-01T00:00:00.000Z  {"requests":1}')
    })

    it('declares a key with meta, upserts, claims with --if-version, and deletes', async () => {
      await wiki(['set', 'acme.tasks', 'Task board.'])
      const meta = await wiki(['meta', 'acme.tasks', '{"key": "id"}'])
      meta.code.should.equal(0, meta.stderr)
      meta.stderr.should.containEql('updated acme.tasks')

      const first = await wiki(['put', 'acme.tasks', '{"id": "t-1", "status": "todo"}', '--json'])
      first.code.should.equal(0, first.stderr)
      JSON.parse(first.stdout).record._v.should.equal(1)

      const claim = await wiki(['put', 'acme.tasks', '{"id": "t-1", "status": "claimed"}', '--if-version', '1'])
      claim.code.should.equal(0, claim.stderr)
      const stale = await wiki(['put', 'acme.tasks', '{"id": "t-1", "status": "claimed"}', '--if-version', '1'])
      stale.code.should.equal(4)

      const byKey = await wiki(['data', 'acme.tasks', 't-1', '--json'])
      byKey.code.should.equal(0, byKey.stderr)
      JSON.parse(byKey.stdout).record.status.should.equal('claimed')

      const del = await wiki(['del', 'acme.tasks', 't-1'])
      del.code.should.equal(0, del.stderr)
      del.stderr.should.containEql('deleted t-1 from acme.tasks')
      ;(await wiki(['data', 'acme.tasks', 't-1'])).code.should.equal(3)
    })

    it('enforces a declared schema on put', async () => {
      await wiki(['set', 'acme.survey', 'Survey.'])
      await wiki(['meta', 'acme.survey', '{"schema": {"type": "object", "required": ["vote"]}}'])
      const bad = await wiki(['put', 'acme.survey', '{"nope": 1}'])
      bad.code.should.equal(2)
      bad.stderr.should.containEql('schema')
      ;(await wiki(['put', 'acme.survey', '{"vote": "yes"}'])).code.should.equal(0)
    })

    it('rejects invalid records and read-option combinations, exit code 2', async () => {
      (await wiki(['put', 'acme.usage', 'not json'])).code.should.equal(2)
      ;(await wiki(['put', 'acme.usage'])).code.should.equal(2)
      ;(await wiki(['put', 'acme.usage', '"bare string"'])).code.should.equal(2)
      ;(await wiki(['data', 'acme.usage', '--latest', '--limit', '5'])).code.should.equal(2)
      ;(await wiki(['meta', 'acme.usage', '[1]'])).code.should.equal(2)
    })

    it('exits 3 for a missing page or record', async () => {
      (await wiki(['put', 'acme.nope', '{"n": 1}'])).code.should.equal(3)
      ;(await wiki(['data', 'acme.nope'])).code.should.equal(3)
      ;(await wiki(['del', 'acme.usage', 'no-such-record'])).code.should.equal(3)
    })
  })

  describe('exit codes and errors', () => {
    it('exits 3 for missing nodes', async () => {
      (await wiki(['get', 'acme.nope'])).code.should.equal(3)
    })

    it('exits 2 for invalid arguments', async () => {
      (await wiki(['get'])).code.should.equal(2)
      ;(await wiki(['set', 'acme.Bad', 'x'])).code.should.equal(2)
      ;(await wiki(['bogus'])).code.should.equal(2)
    })

    it('exits 5 without credentials', async () => {
      (await wiki(['get', 'acme'], { token: null })).code.should.equal(5)
    })

    it('exits 6 when the token is not authorized', async () => {
      const read = await wiki(['get', 'acme'], { token: 'read-token' })
      read.code.should.equal(0)
      const write = await wiki(['set', 'acme.denied', 'x'], { token: 'read-token' })
      write.code.should.equal(6)
    })

    it('keeps errors off stdout', async () => {
      const result = await wiki(['get', 'acme.nope'])
      result.stdout.should.equal('')
      result.stderr.should.containEql('wiki:')
    })

    it('shows help', async () => {
      const help = await wiki(['help'])
      help.code.should.equal(0)
      help.stdout.should.containEql('usage: wiki <command>')
      const commandHelp = await wiki(['set', '--help'])
      commandHelp.stdout.should.containEql('wiki set <path> [content]')
    })
  })
})
