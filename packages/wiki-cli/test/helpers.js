import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { createWikiKit } from 'wiki-kit'
import { createWikiApi, createStaticTokenAuth } from 'wiki-api'

const binPath = fileURLToPath(new URL('../bin/wiki.js', import.meta.url))

/**
 * Boot a real API on a real SQLite file, and return a runner that
 * executes the actual CLI binary against it.
 */
export async function createCliFixture () {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'waterfront-cli-'))
  const db = new Database(path.join(dir, 'test.db'))
  db.pragma('journal_mode = WAL')
  db.pragma('busy_timeout = 5000')
  const kit = createWikiKit({ db })
  await kit.migrate()
  const auth = createStaticTokenAuth({
    tokens: {
      'test-token': { actor: { type: 'agent', id: 'cli_test', onBehalfOf: 'user_test' } },
      'read-token': { actor: { type: 'human', id: 'reader', onBehalfOf: null }, allow: ['wiki:read'] }
    }
  })
  const app = createWikiApi({ kit, auth })
  await app.listen({ port: 0, host: '127.0.0.1' })
  const { port } = app.server.address()

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
    await app.close()
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }

  return { wiki, close, port }
}
