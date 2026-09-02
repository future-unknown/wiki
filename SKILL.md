---
name: wiki
description: Read and write shared documentation in a wiki using the `wiki` CLI. Use when a task requires looking up, recording, or reorganizing knowledge that lives in a wiki addressed by dot-separated paths like acme.about.foo.
---

# Working with a wiki

wiki is a shared, versioned knowledge base used by both agents and humans. You
interact with it through the `wiki` CLI. Everything is a node addressed by a
dot-separated path; the first segment is the wiki itself:

```text
acme                the wiki root (also a page)
acme.about          a section (also a page)
acme.about.foo      a page inside that section
```

Content is Markdown. A node can hold content *and* have children — there is no
file-vs-directory distinction. Every change is recorded permanently; nothing
you overwrite or delete is lost.

Every page is also a small data store: **a document you can read plus records
you can query**. The document is authored and versioned; records are stamped
observations and state (see *Records* below). The wiki versions what is
authored and stamps what is observed.

## Configuration

The CLI reads `WIKI_URL` and `WIKI_TOKEN` from the environment (or
`--url` / `--token` flags). Never print the token.

## Core rules

1. **Orient before writing.** If you do not know where information belongs,
   inspect the tree (`wiki tree`) or search (`wiki search`) first.
2. **Read before you modify.** Before changing an existing node, read it with
   `--json` and preserve the returned `revisionId`.
3. **Write conditionally.** Make your edit based on the content you actually
   read, and write it back with `--if-revision <revisionId>`.
4. **On conflict, merge and retry.** If the write fails with a conflict
   (exit code 4), someone changed the node after you read it: reread it,
   merge your change into the new state, and retry with the fresh
   `revisionId`.
5. **Read narrowly.** Prefer targeted `wiki get` calls over dumping an entire
   large wiki with an unbounded `wiki tree`.
6. **Prefer `--json`** whenever output will be consumed programmatically.
   Every meaningful command supports it.
7. **Never use `--recursive` deletion** unless the task explicitly requires
   deleting a whole subtree.

## The safe edit loop

```bash
# 1. read the node and keep its revisionId
wiki get acme.about.foo --json
# -> { ..., "content": "...", "revisionId": "3f2a..." }

# 2. write the merged result conditionally
wiki set acme.about.foo --if-revision 3f2a... <<'EOF'
# Foo

Updated documentation.
EOF

# 3. if that exits with code 4 (conflict): reread, merge, retry
wiki get acme.about.foo --json   # fresh content + fresh revisionId
```

## Commands

### Read a node — `wiki get <path>`

Prints the raw Markdown content on stdout; `--json` adds ids, title,
metadata, `revisionId`, timestamps, and the commit that produced this
revision (with its actor and message) — who last touched the page,
without a history call. `--commit <id>` or `--at <iso>` read historical
states (mutually exclusive).

```bash
wiki get acme.about.foo
wiki get acme.about.foo --json
wiki get acme.about.foo --commit 123
```

### Write a node — `wiki set <path> [content]`

Creates or replaces a node's content. Supply content exactly one way: inline
argument, stdin (pipe/heredoc), or `--file <path>`. Also supports `--title`,
`--metadata '<json object>'`, `--if-revision <revisionId>`, and
`--message '<why>'` (a short commit message; use it for meaningful edits).
Anything missing is created automatically: intermediate nodes, and the wiki
itself if it does not exist yet — so double-check the first path segment
before writing; a typo there creates a new wiki instead of failing.
Omitted `--title`/`--metadata` are preserved, but content is replaced whole.

```bash
wiki set acme.about.foo "Short note"
wiki set acme.about.foo < foo.md
wiki set acme.guides.deploy --file deploy.md --title "Deploying" --message "initial guide"
```

### Merge metadata — `wiki meta <path> [json]`

Merges fields into a page's metadata without touching the rest — the
safe way to change one declaration when other fields must survive.
Supply a JSON object inline or on stdin; a `null` value removes its
field; `--replace` swaps the whole object instead of merging. This is
an authored change like `set`: it makes a revision and supports
`--if-revision` and `--message '<why>'`.

```bash
wiki meta acme.usage '{"retain": {"days": 90}}'
wiki meta acme.tasks '{"key": "id"}' --message "tasks become a keyed page"
wiki meta acme.usage '{"retain": null}'
```

### Browse — `wiki tree <path>`

Shows the hierarchy with one-line previews. Scope it to any subtree and limit
it with `--depth <n>`. Supports `--commit` / `--at` for historical trees and
`--json` for the full structured tree.

```bash
wiki tree acme --depth 2
wiki tree acme.architecture --json
```

### Search — `wiki search <path> <query>`

Full-text search over current content, titles, and paths, scoped to any
subtree. Returns full paths with excerpts; `--limit <n>` caps results.

```bash
wiki search acme "authentication"
wiki search acme.architecture "tokens" --json
```

### History — `wiki history <path>`

Lists a node's revisions, newest first, with commit ids, actors, and
messages. `--limit <n>` caps entries. Use commit ids from here with
`wiki get --commit` to read old versions.

```bash
wiki history acme.about.foo --json
```

### Move — `wiki move <from> <to>`

Moves or renames a node together with its entire subtree. Identity and
history are preserved; only the address changes. Both paths must be in the
same wiki, the destination parent must exist, and the destination must be
free. Supports `--if-revision` and `--message`.

```bash
wiki move acme.about.foo acme.archive.foo
```

### Delete — `wiki rm <path>`

Deletes a node. Fails on nodes with children unless `--recursive` is given.
For risky subtree deletions you may also pass `--if-commit <commitId>` to
ensure the wiki has not changed at all since you inspected it. Supports
`--if-revision` and `--message`. History is preserved; recreating the path
later makes a fresh page.

```bash
wiki rm acme.scratch
wiki rm acme.old-section --recursive --if-commit 57
```

## Records

Besides its document, every page carries one set of **records** — JSON
objects for structured data: metrics, events, survey responses, task
state, config. The rule for choosing:

- **`wiki set`** when you are *authoring* — composing content someone
  takes responsibility for. Versioned, guarded by `--if-revision`.
- **`wiki put`** when you are *recording* — writing structured data.
  Records are stamped (`_actor`, `_ts`, `_v`, and `_id`, the record's
  address within its page), create no revision, and never appear in
  `wiki history`. Never put prose; that belongs in the document.

One declaration decides how a page's records behave:

- **Keyed** — `metadata.key` names a field (e.g. `{"key": "id"}`).
  `put` upserts by that field's value: the page acts as a table or a
  key/value store. `--if-version <n>` makes the write conditional on
  the record's current `_v` — when two agents race to update the same
  record, exactly one wins and the loser exits with a conflict.
- **Unkeyed** — no key declared. `put` appends: the page acts as a
  log. `--ts <iso>` backfills the record time; `metadata.retain`
  (`{"days": n}`) expires old records, so do not treat an unkeyed
  page as permanent storage.

Read options follow the sort order. On an unkeyed page records sort
by time, so `--latest`, `--since`, and `--until` mean what they say.
On a keyed page records sort by key: `--since`/`--until` bound the
key range and `--latest` returns the highest key, not the most recent
write — read `_ts` on the records to judge recency. Changing `key` on
a page that already holds records does not rewrite them: earlier
records keep their addresses and list alongside the new ones.

A page may also declare `metadata.schema` — a JSON Schema that every
record must match; a `put` that does not match is refused. Declare
`key`, `schema`, and `retain` with `wiki meta`. Records are field
maps, not documents: a record must be a JSON object, and field names
starting with `_` are reserved for stamps.

### Write a record — `wiki put <path> [json]`

Supply the record inline or via stdin (inline wins). The page must
already exist. Keyed pages take `--if-version <n>`; unkeyed pages take
`--ts <iso>`.

```bash
wiki put acme.usage '{"requests": 1042}'
wiki put acme.tasks '{"id": "t-41", "status": "claimed", "by": "agent-7"}' --if-version 1
wiki put acme.usage --ts 2026-08-01T00:00:00Z < record.json
```

### Read records — `wiki data <path> [key]`

With a key (the key-field value, or `_id` on an unkeyed page): exactly
that record. Without one: the page's records in sort order — time on
unkeyed pages, key on keyed ones — or `--reverse` for newest first on
a log (highest key first on a keyed page). `--latest` returns only the
newest (and combines with nothing else); `--since <iso>` /
`--until <iso>` bound the range; `--limit <n>` caps it; when more
records remain the result carries a continuation token — pass it back
with `--cursor <token>` to continue. To read recent activity, prefer
`--reverse --limit <n>` over paging forward from the beginning.

```bash
wiki data acme.tasks t-41 --json
wiki data acme.usage --since 2026-08-01T00:00:00Z --limit 100
wiki data acme.usage --reverse --limit 20
wiki data acme.usage --latest
```

### Delete a record — `wiki del <path> <key>`

Removes one record by its key (keyed pages) or `_id` (unkeyed pages)
and prints what was removed. Deleting records is curation and needs
write access, not just record access.

```bash
wiki del acme.tasks t-41
```

## Typed pages

A page's `metadata.type` declares how reading surfaces render its
content: `markdown` (the default), `json` (any JSON value), or `table`
(a JSON array of objects). Typed content is still just content — write
it with the same safe edit loop:

```bash
wiki set acme.usage.by-region --metadata '{"type":"table"}' <<'EOF'
[{"region": "us", "requests": 812}, {"region": "eu", "requests": 230}]
EOF
```

## Linking between pages

Link pages with wikilinks: `[[architecture.deployment]]`, or labeled,
`[[docs.cli|the CLI guide]]`. Paths are the same wiki-relative dot-paths
used everywhere else — links resolve within the wiki the page lives in.
Inside a Markdown table cell, escape the label pipe — `[[path\|Label]]`
— because tables split cells on a raw `|`. Wikilinks are plain text to the system — write them
anywhere in page content; reading surfaces render them as navigation.

To embed a whole page instead of linking it, put an embed on a line of
its own:

```text
![[usage.daily]]
```

Reading surfaces render the target page inline — content and any
observed data — so a dashboard is just a page of prose and embeds. To
everything else (including `wiki get`) an embed is plain text, and in
running text or code it stays literal. Embeds resolve the same
wiki-relative paths as wikilinks; after moving a page, find stale
embeds the same way you find stale wikilinks.

After moving a page, links pointing at its old path still say the old
path. Find them with `wiki search "<old.path>"` and update each referring
page (with `--if-revision`, as always). That same search also answers
"what links here?" for any page.

## Exit codes

| code | meaning |
|------|-------------------------|
| 0 | success |
| 1 | general failure |
| 2 | invalid arguments |
| 3 | not found |
| 4 | conflict (stale revision, existing destination, non-empty node) |
| 5 | authentication failure |
| 6 | authorization failure |

Errors go to stderr; stdout carries only requested data, so it is safe to
pipe and parse.
