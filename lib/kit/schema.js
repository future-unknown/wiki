/**
 * Explicit SQL migrations. wiki-kit owns the schema; the caller owns
 * the connection.
 */

export const migrations = [
  {
    id: '001-core',
    sql: `
      CREATE TABLE commits (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        wiki_id       TEXT NOT NULL,

        actor_type    TEXT NOT NULL,
        actor_id      TEXT NOT NULL,
        on_behalf_of  TEXT,

        message       TEXT,
        created_at    TEXT NOT NULL
      );

      CREATE INDEX commits_by_wiki ON commits(wiki_id, id);
      CREATE INDEX commits_by_wiki_time ON commits(wiki_id, created_at);

      CREATE TABLE nodes (
        id            TEXT PRIMARY KEY,
        wiki_id       TEXT NOT NULL,
        parent_id     TEXT,

        slug          TEXT NOT NULL,
        path          TEXT NOT NULL,

        title         TEXT,
        content       TEXT NOT NULL DEFAULT '',
        metadata      TEXT NOT NULL DEFAULT '{}',

        deleted       INTEGER NOT NULL DEFAULT 0,

        revision_id   TEXT NOT NULL,
        commit_id     INTEGER NOT NULL,

        created_at    TEXT NOT NULL,
        updated_at    TEXT NOT NULL
      );

      -- Active root slugs are globally unique; the root is the wiki.
      CREATE UNIQUE INDEX nodes_active_root_slug
        ON nodes(slug) WHERE parent_id IS NULL AND deleted = 0;

      -- Only one active root per wiki.
      CREATE UNIQUE INDEX nodes_active_root
        ON nodes(wiki_id) WHERE parent_id IS NULL AND deleted = 0;

      -- Active paths are unique within a wiki; tombstones free the path.
      CREATE UNIQUE INDEX nodes_active_wiki_path
        ON nodes(wiki_id, path) WHERE deleted = 0;

      -- Active sibling slugs are unique.
      CREATE UNIQUE INDEX nodes_active_sibling_slug
        ON nodes(wiki_id, parent_id, slug) WHERE deleted = 0 AND parent_id IS NOT NULL;

      CREATE INDEX nodes_by_parent ON nodes(wiki_id, parent_id);
      CREATE INDEX nodes_by_wiki_path ON nodes(wiki_id, path);

      CREATE TABLE node_revisions (
        id          TEXT PRIMARY KEY,

        wiki_id     TEXT NOT NULL,
        node_id     TEXT NOT NULL,
        commit_id   INTEGER NOT NULL,

        parent_id   TEXT,
        slug        TEXT NOT NULL,

        title       TEXT,
        content     TEXT NOT NULL,
        metadata    TEXT NOT NULL,

        deleted     INTEGER NOT NULL DEFAULT 0,

        created_at  TEXT NOT NULL,

        UNIQUE(node_id, commit_id)
      );

      CREATE INDEX node_revisions_by_wiki_commit ON node_revisions(wiki_id, commit_id);
      CREATE INDEX node_revisions_by_node ON node_revisions(node_id, commit_id);

      -- Derived full-text projection over current active state.
      -- rowid mirrors nodes.rowid.
      CREATE VIRTUAL TABLE nodes_fts USING fts5(path, title, content);
    `
  }
]

/**
 * Apply pending migrations. Idempotent.
 *
 * @param {import('better-sqlite3').Database} db
 */
export function migrate (db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id          TEXT PRIMARY KEY,
      applied_at  TEXT NOT NULL
    );
  `)
  const applied = new Set(
    db.prepare('SELECT id FROM schema_migrations').all().map((row) => row.id)
  )
  const insert = db.prepare('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)')
  for (const migration of migrations) {
    if (applied.has(migration.id)) continue
    const run = db.transaction(() => {
      db.exec(migration.sql)
      insert.run(migration.id, new Date().toISOString())
    })
    run()
  }
}
