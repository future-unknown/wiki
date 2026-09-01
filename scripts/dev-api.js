#!/usr/bin/env node
/**
 * Development server for the wiki API. The application owns the
 * Express app and the database connection; wiki provides the
 * router and the kit.
 *
 *   WIKI_DB         SQLite file (default var/wiki.db)
 *   WIKI_DEV_TOKEN  bearer token accepted in development (default dev-token)
 *   PORT            listen port (default 3000)
 */

import express from 'express'
import { createWikiKit } from '../lib/kit/index.js'
import { createWikiRouter, createStaticTokenAuth, openDatabase, openRecordStore } from '../lib/api/index.js'

const file = process.env.WIKI_DB || 'var/wiki.db'
const token = process.env.WIKI_DEV_TOKEN || 'dev-token'
const port = Number(process.env.PORT || 3000)
const recordsUrl = process.env.WIKI_RECORDS_URL

const db = openDatabase(file)
const records = recordsUrl
  ? openRecordStore({ endpoint: recordsUrl, table: process.env.WIKI_RECORDS_TABLE })
  : undefined
const kit = createWikiKit({ db, records })
await kit.migrate()

const auth = createStaticTokenAuth({
  tokens: {
    [token]: { actor: { type: 'human', id: 'dev', onBehalfOf: null } }
  }
})

const app = express()
app.use(createWikiRouter({ kit, auth, onError: (error) => console.error(error) }))

const server = app.listen(port, () => {
  const recordsNote = recordsUrl ? `, records: ${recordsUrl}` : ', records: disabled (set WIKI_RECORDS_URL)'
  console.log(`wiki api listening on http://localhost:${port} (db: ${file}${recordsNote})`)
})

const close = () => {
  server.close(() => {
    db.close()
    process.exit(0)
  })
}
process.on('SIGINT', close)
process.on('SIGTERM', close)
