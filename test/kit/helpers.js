import Database from 'better-sqlite3'
import { createWikiKit } from '../../lib/kit/index.js'

export const human = { type: 'human', id: 'user_test', onBehalfOf: null }
export const agent = { type: 'agent', id: 'agent_test', onBehalfOf: 'user_test' }

/**
 * Fresh in-memory kit for a test. The db handle is exposed so tests can
 * assert directly against SQLite state.
 */
export async function createTestKit () {
  const db = new Database(':memory:')
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  const kit = createWikiKit({ db })
  await kit.migrate()
  return { kit, db }
}

/**
 * Seed the canonical acme fixture from the spec.
 */
export async function seedAcme (kit) {
  const root = await kit.createWiki({
    slug: 'acme',
    content: 'This is the acme wiki',
    actor: human
  })
  const wikiId = root.id
  await kit.setNode({ wikiId, path: 'about', content: 'This is an about section', actor: human })
  await kit.setNode({ wikiId, path: 'about.foo', content: 'This is all about foo', actor: human })
  await kit.setNode({ wikiId, path: 'about.bar', content: 'This is all about bar', actor: human })
  await kit.setNode({ wikiId, path: 'about.baz', content: 'This is all about baz', actor: human })
  return { root, wikiId }
}

export function commitCount (db, wikiId) {
  return db.prepare('SELECT COUNT(*) AS n FROM commits WHERE wiki_id = ?').get(wikiId).n
}

export function revisionCount (db, nodeId) {
  return db.prepare('SELECT COUNT(*) AS n FROM node_revisions WHERE node_id = ?').get(nodeId).n
}

export function sleep (ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
