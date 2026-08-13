#!/usr/bin/env node
/**
 * Development server for the waterfront API.
 *
 *   WIKI_DB         SQLite file (default var/waterfront.db)
 *   WIKI_DEV_TOKEN  bearer token accepted in development (default dev-token)
 *   PORT            listen port (default 3000)
 */

import { createWikiKit } from 'wiki-kit'
import { createWikiApi, createStaticTokenAuth, openDatabase } from '../lib/index.js'

const file = process.env.WIKI_DB || 'var/waterfront.db'
const token = process.env.WIKI_DEV_TOKEN || 'dev-token'
const port = Number(process.env.PORT || 3000)

const db = openDatabase(file)
const kit = createWikiKit({ db })
await kit.migrate()

const auth = createStaticTokenAuth({
  tokens: {
    [token]: { actor: { type: 'human', id: 'dev', onBehalfOf: null } }
  }
})

const app = createWikiApi({ kit, auth, fastifyOptions: { logger: true } })

const close = async () => {
  await app.close()
  db.close()
  process.exit(0)
}
process.on('SIGINT', close)
process.on('SIGTERM', close)

await app.listen({ port, host: '0.0.0.0' })
console.log(`waterfront api listening on http://localhost:${port} (db: ${file})`)
