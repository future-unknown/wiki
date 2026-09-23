import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Worker } from 'node:worker_threads'
import should from 'should'
import Database from 'better-sqlite3'
import { migrations } from '../../lib/kit/schema.js'

const WORKER = new URL('./migrate-worker.js', import.meta.url)
const CONTENDERS = 4
const ROUNDS = 25

function contend (file) {
  const barrier = new SharedArrayBuffer(4)
  return Promise.all(Array.from({ length: CONTENDERS }, () => new Promise((resolve, reject) => {
    const worker = new Worker(WORKER, { workerData: { file, barrier, contenders: CONTENDERS } })
    worker.once('message', resolve)
    worker.once('error', reject)
  })))
}

describe('migrate under contention', () => {
  let dir
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-migrate-')) })
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

  it('lets several connections migrate one fresh file at once, each migration applied once', async function () {
    this.timeout(60000)
    for (let round = 0; round < ROUNDS; round++) {
      const file = path.join(dir, `race-${round}.db`)
      const results = await contend(file)
      results.filter((r) => !r.ok).map((r) => r.message).should.deepEqual([])
      const db = new Database(file, { readonly: true })
      db.prepare('SELECT id FROM schema_migrations ORDER BY id').all().map((r) => r.id)
        .should.deepEqual(migrations.map((m) => m.id))
      db.close()
    }
  })
})
