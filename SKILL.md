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
metadata, `revisionId`, and timestamps. `--commit <id>` or `--at <iso>` read
historical states (mutually exclusive).

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

## Observed data

Besides authored content, every page has a **data channel** for observed
facts: metrics, measurements, events. The rule for choosing:

- **`wiki set`** when you are *authoring* — composing or revising content
  someone takes responsibility for. Writes are versioned and guarded by
  `--if-revision`.
- **`wiki push`** when you are *reporting* — recording something that
  happened. Observations are timestamped, append-only, and never
  conflict; they create no revision and do not appear in `wiki history`.
  A page may trim old observations by a retention policy, so do not
  treat the channel as permanent storage. Never push prose or
  documentation; that belongs in authored content.

### Push an observation — `wiki push <path> [json]`

Appends one JSON value to the page's data channel. Supply the payload
inline or via stdin (inline wins). `--ts <iso>` backfills the
observation time; it defaults to now. The page must already exist.

```bash
wiki push acme.usage '{"requests": 1042}'
wiki push acme.usage --ts 2026-08-01T00:00:00Z < datum.json
```

### Read observations — `wiki data <path>`

Prints the page's observations, oldest first. `--latest` returns only
the newest one (and combines with nothing else); `--since <iso>` /
`--until <iso>` bound the range and `--limit <n>` caps it.

```bash
wiki data acme.usage --latest --json
wiki data acme.usage --since 2026-08-01T00:00:00Z --limit 100
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
`[[docs.cli|the CLI guide]]`. Paths are the same org-relative dot-paths
used everywhere else. Wikilinks are plain text to the system — write them
anywhere in page content; reading surfaces render them as navigation.

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
