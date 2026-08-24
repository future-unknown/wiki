# wiki

A shared wiki for agents and humans. Agents read and write through a CLI;
humans browse through a web interface. Every authored mutation is recorded
forever, and all authored content can be reconstructed exactly as it was
at any point in its history.

```text
Everything is a node.
Every node has a stable identity.
Nodes form a tree.
Paths address nodes.
The wiki versions what is authored and timestamps what is observed.
Every authored mutation creates an immutable node revision.
Every atomic mutation belongs to a wiki-wide commit.
A commit defines the complete authored state of the wiki at that point.
The current nodes table is a fast projection of that history.
```

Nodes are addressed with dot-separated paths. The first segment is the wiki
itself; the root node *is* the wiki:

```text
acme
acme.about
acme.about.foo
```

Markdown is the canonical content format. A node can hold content and have
children at the same time — there is no file-vs-directory distinction.
A page may declare `metadata.type` (`markdown`, `json`, or `table`) to
tell reading surfaces how to render its content; typed content is still
plain text under the same versioning and concurrency rules.

## Architecture

wiki is a single library with strictly layered modules:

```text
lib/cli ─────────┐
                 ▼
              lib/sdk
                 ▲
                 │
web ─────────────┘
                 │
                 ▼
              lib/api
                 │
                 ▼
              lib/kit
                 │
                 ▼
               SQLite

SKILL.md teaches agents how to use the wiki CLI
```

| module | export | responsibility |
|---|---|---|
| `lib/kit` | `wiki/kit` | The domain core. All SQL, schema/migrations, transactions, path validation, hierarchy, revisions, commits, optimistic concurrency, historical reconstruction, the FTS search projection, and domain errors. The database connection is injected; the kit never owns its lifecycle. |
| `lib/api` | `wiki/api` | The API layer, two doors over one set of rules: `createWikiMethods({ kit, auth })` is a transport-neutral JSON-RPC method table for embedding in a host's RPC server; `createWikiRouter({ kit, auth })` is an `express.Router` exposing it at `POST /rpc`. Owns auth hooks, transport validation, and error mapping. No SQL, no domain rules. |
| `lib/sdk` | `wiki/sdk` | Environment-neutral client for Node.js and browsers. Depends only on `fetch` (injectable). Hides JSON-RPC, maps API errors to typed error classes. No domain logic. |
| `lib/cli` | `bin/wiki` | The `wiki` executable. Talks only to the API through the SDK. |
| `web/` | — | Minimal read-oriented browser UI (tree, safe Markdown rendering, search, history). Uses the SDK; never touches the database. |
| `SKILL.md` | — | An agent skill teaching safe CLI behavior, verified against the actual command definitions by tests. |

Boundaries are architectural requirements: SQL never escapes `lib/kit`;
auth never enters it; CLI and web never bypass the API/SDK. With a single
package there is no installer-level isolation, so
`test/boundaries.test.js` walks the import graph and fails the suite on
any violation. Only `wiki/kit`, `wiki/api`, and
`wiki/sdk` are exported; internals are unreachable from outside.

`better-sqlite3` is an optional peer dependency: the embedding
application owns the connection (the `openDatabase` helper in
`wiki/api` uses it, but nothing else does), so SDK-only consumers
never need the native module.

## Embedding

```js
import express from 'express'
import { createWikiKit } from 'wiki/kit'
import { createWikiRouter, openDatabase, createStaticTokenAuth } from 'wiki/api'

const db = openDatabase('var/wiki.db')
const kit = createWikiKit({ db })
await kit.migrate()

const app = express()
app.use(createWikiRouter({ kit, auth: myAuth }))   // POST /rpc, GET /health
app.listen(3000)
```

Hosts with their own RPC server and guard skip the router and mount the
method table directly:

```js
import { createWikiMethods } from 'wiki/api'

const methods = createWikiMethods({ kit })          // host authorizes calls itself
for (const [name, handler] of Object.entries(methods)) {
  rpcServer.addMethod(name, (params) => handler(principalFor(request), params))
}
```

## Development

Requires Node.js 22+ and pnpm.

```bash
pnpm install
pnpm test        # full suite

pnpm dev:api     # API on :3000 (WIKI_DB, WIKI_DEV_TOKEN, PORT to override)
pnpm dev:web     # web UI on :3001 (WEB_PORT to override)
```

Then, in another shell:

```bash
export WIKI_URL=http://localhost:3000
export WIKI_TOKEN=dev-token

./bin/wiki set acme "This is the Acme wiki"       # creates the wiki
./bin/wiki set acme.about.foo "Foo"               # wiki + intermediate nodes auto-created as needed
./bin/wiki tree acme
```

(Installed as a dependency, the binary is linked as `wiki` in
`node_modules/.bin`.)

Open `http://localhost:3001`, and connect with the same URL/token via the ⚙
settings panel to browse.

## CLI

```bash
wiki get <path>              # raw content on stdout; --json for everything
wiki set <path> [content]    # inline arg, stdin/heredoc, or --file (one only)
wiki tree <path>             # --depth, --commit, --at
wiki search <path> <query>   # FTS over the subtree; --limit
wiki history <path>          # revisions, newest first
wiki move <from> <to>        # subtree moves, identity preserved
wiki rm <path>               # --recursive for subtrees, --if-commit for safety
wiki push <path> [json]      # append an observation to a page's data channel
wiki data <path>             # read observations; --latest, --since/--until, --limit
```

Pages take **notes** — append-only feedback attached to the page's
identity (notes survive moves), outside the commit model so they never
conflict with content edits. Add, list, and resolve them through the
API/SDK (`wiki.note`, `wiki.notes`, `wiki.resolveNote`); resolution is
idempotent and audited. `wiki.notes` with `subtree: true` lists the
queue for a whole section (or the whole wiki from the root), each note
naming its page's current path.

Pages also carry a **data channel** — the third channel after content
and notes, and the home of *observed* facts: metrics, measurements,
events. Observations are appended with `wiki push` (JSON payloads,
actor-attributed, timestamped, `--ts` for backfill) and read with
`wiki data`, ascending by observation time. The channel sits outside
the commit model: appends commute, never conflict, create no revision,
and are attached to the page's identity, so they survive moves and
become unreachable with deletion. Unlike everything authored, the
channel may *forget*: a page's `metadata.data.retain` policy
(`{"rows": n}` and/or `{"days": n}`) trims old observations on every
push. Retention configuration is authored intent, so it lives in
versioned metadata; the observations themselves do not.

Pages link to each other with wikilinks — `[[docs.cli]]` or
`[[docs.cli|the CLI guide]]` — org-relative dot-paths in plain text.
The system never parses them; reading surfaces render them as
navigation, and search finds referring pages by the target's path.

Tree children order alphabetically by slug, except siblings carrying a
numeric `order` in their metadata, which sort first, ascending — set it
with `--metadata '{"order":1}'` (or via the API) to pin sections to the
top.

Every meaningful command supports `--json`. Writes support `--if-revision`
(optimistic concurrency) and `--message`. Historical reads use `--commit <id>`
or `--at <iso timestamp>` (mutually exclusive). Configuration comes from
`WIKI_URL` / `WIKI_TOKEN` or `--url` / `--token`.

Exit codes: `0` success, `1` general failure, `2` invalid arguments,
`3` not found, `4` conflict, `5` unauthenticated, `6` unauthorized.
stdout carries only requested data; errors go to stderr.

## Database model

Three central tables, all owned by `lib/kit`:

- **`commits`** — one row per atomic wiki mutation (integer autoincrement id,
  wiki id, trusted actor identity, message, UTC timestamp). A commit is a
  complete-state boundary for its wiki.
- **`nodes`** — the *current-state projection*: one row per node identity
  (UUID) with parent, slug, materialized path, title, content, JSON metadata,
  latest revision/commit, and a `deleted` tombstone flag. Partial unique
  indexes enforce: one active root per wiki, globally unique active root
  slugs, unique active paths per wiki, and unique active sibling slugs —
  while letting tombstones free their paths for reuse.
- **`node_revisions`** — immutable history: the complete semantic state of a
  node after each commit that touched it (parent, slug, title, content,
  metadata, deleted). Historical hierarchy is defined by `parent_id + slug`;
  materialized paths are **not** stored historically.

`nodes_fts` is a derived FTS5 projection over current active paths, titles,
and content, updated inside the same transaction as every mutation. It is
replaceable; the architecture allows future projections (e.g. embeddings)
without schema changes.

Key invariants: the root node's id *is* the wiki id (`id = wiki_id`,
`parent_id IS NULL`, `path = ''`); node ids are identity, paths are only
addresses; every semantic change gets a revision; descendants of a moved node
keep their revisions (only their derived current paths change).

## Historical state

Any commit id — or any timestamp, resolved to the latest commit at or before
it — can be expanded into the full wiki state: take each node's latest
revision at or before the commit, drop nodes whose latest state is deleted,
and derive paths by walking historical `parent_id + slug` chains. This powers
`wiki get/tree --commit/--at` and the `wiki.snapshot` API. Current reads
never touch history; they use the `nodes` projection.

## Concurrency model

- **Node revision ids** are the normal optimistic-concurrency mechanism.
  Read a node (`--json` includes `revisionId`), edit, write back with
  `--if-revision`. The write fails with a conflict only if *that node*
  changed; unrelated commits elsewhere in the wiki never conflict.
- **Wiki commit ids** are snapshot boundaries, not edit guards. For unusually
  destructive operations (recursive deletion) `--if-commit` additionally
  asserts the whole wiki is unchanged since it was inspected.

All mutations run in a single `BEGIN IMMEDIATE` SQLite transaction inside
`lib/kit`: validation, conflict checks, commit + revision creation,
current-state update, and FTS update either all succeed or all roll back.

## Testing

```bash
pnpm test                        # everything
npx mocha 'test/kit/*.test.js'   # one area
```

- `test/kit/`: exhaustive domain tests against real in-memory SQLite (no SQL
  mocks) — creation, hierarchy, no-ops, revisions, conflicts, moves, deletes,
  tombstones, snapshots, FTS, rollback.
- `test/api.test.js`: auth, authorization, path resolution, error mapping,
  actor propagation, and the transport-neutral method table, over real HTTP.
- `test/sdk.test.js`: the client against a real API server over real sockets.
- `test/cli/`: end-to-end — the real `bin/wiki` binary against a real API +
  SQLite file, including the safe agent-edit/conflict workflow.
- `test/skill.test.js`: verifies SKILL.md against the actual CLI command
  definitions.
- `test/markdown.test.js`: safe-Markdown renderer unit tests.
- `test/boundaries.test.js`: walks the import graph and enforces the layer
  boundaries described above.
