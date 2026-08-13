/**
 * SQLite connection helper. The application owns the connection and
 * injects it into wiki-kit; wiki-kit never opens or closes it.
 */

import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'

/**
 * @param {string} file path to the database file, or ':memory:'
 * @returns {import('better-sqlite3').Database}
 */
export function openDatabase (file) {
  if (file !== ':memory:') {
    fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true })
  }
  const db = new Database(file)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.pragma('busy_timeout = 5000')
  db.pragma('synchronous = NORMAL')
  return db
}
