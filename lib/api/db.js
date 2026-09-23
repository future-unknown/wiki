/**
 * SQLite connection helper. The application owns the connection and
 * injects it into wiki-kit; wiki-kit never opens or closes it.
 */

import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'

// How long a connection waits on another's lock before giving up.
const BUSY_TIMEOUT_MS = 5000
// Pause between attempts to switch a fresh file to WAL.
const WAL_RETRY_MS = 10

/**
 * @param {string} file path to the database file, or ':memory:'
 * @returns {import('better-sqlite3').Database}
 */
export function openDatabase (file) {
  if (file !== ':memory:') {
    fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true })
  }
  const db = new Database(file)
  db.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`)
  enableWal(db)
  db.pragma('foreign_keys = ON')
  db.pragma('synchronous = NORMAL')
  return db
}

// Switching a file to WAL needs an exclusive lock, and SQLite answers
// SQLITE_BUSY at once instead of consulting the busy timeout when
// another connection is doing the same — two processes opening a new
// file together. WAL is a property of the file, so the first switch
// settles it for everyone; a contender retries until it sees that.
function enableWal (db) {
  const deadline = Date.now() + BUSY_TIMEOUT_MS
  const pause = new Int32Array(new SharedArrayBuffer(4))
  for (;;) {
    try {
      db.pragma('journal_mode = WAL')
      return
    } catch (error) {
      if (error?.code !== 'SQLITE_BUSY' || Date.now() >= deadline) throw error
      Atomics.wait(pause, 0, 0, WAL_RETRY_MS)
    }
  }
}
