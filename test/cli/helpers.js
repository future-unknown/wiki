import { execFile } from 'node:child_process'
import { once } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import express from 'express'
import Database from 'better-sqlite3'
import { createWikiKit } from '../../lib/kit/index.js'
import { createWikiRouter, createStaticTokenAuth, openRecordStore } from '../../lib/api/index.js'
import { startDynoxide, uniqueTable } from '../dynoxide.js'

const binPath = fileURLToPath(new URL('../../bin/wiki', import.meta.url))

/**
 * Boot a real API on a real SQLite file (with a real record store on a
 * dynoxide sidecar), and return a runner that executes the actual CLI
 * binary against it.
 */
export async function createCliFixture () {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-cli-'))
  const db = new Database(path.join(dir, 'test.db'))
  db.pragma('journal_mode = WAL')
  db.pragma('busy_timeout = 5000')
  const dynoxide = await startDynoxide()
  const records = openRecordStore({ endpoint: dynoxide.endpoint, table: uniqueTable() })
  const kit = createWikiKit({ db, records })
  await kit.migrate()
  const auth = createStaticTokenAuth({
    tokens: {
      'test-token': { actor: { type: 'agent', id: 'cli_test', onBehalfOf: 'user_test' } },
      'read-token': { actor: { type: 'human', id: 'reader', onBehalfOf: null }, allow: ['wiki:read'] }
    }
  })
  const app = express()
  app.use(createWikiRouter({ kit, auth }))
  const server = app.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const { port } = server.address()

  /**
   * @param {string[]} args
   * @param {{ stdin?: string, token?: string|null }} [options]
   * @returns {Promise<{ code: number, stdout: string, stderr: string }>}
   */
  function wiki (args, { stdin, token = 'test-token' } = {}) {
    return new Promise((resolve) => {
      const child = execFile(
        process.execPath,
        [binPath, ...args],
        {
          env: {
            ...process.env,
            WIKI_URL: `http://127.0.0.1:${port}`,
            ...(token === null ? { WIKI_TOKEN: '' } : { WIKI_TOKEN: token })
          }
        },
        (error, stdout, stderr) => {
          resolve({ code: error ? error.code ?? 1 : 0, stdout, stderr })
        }
      )
      if (stdin !== undefined) child.stdin.end(stdin)
      else child.stdin.end()
    })
  }

  async function close () {
    server.close()
    db.close()
    dynoxide.stop()
    fs.rmSync(dir, { recursive: true, force: true })
  }

  return { wiki, close, port }
}
