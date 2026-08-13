---
name: waterfront
description: Read and write shared documentation in a waterfront wiki using the `wiki` CLI. Use when a task requires looking up, recording, or reorganizing knowledge that lives in a wiki addressed by dot-separated paths like acme.about.foo.
---

# Working with a waterfront wiki

waterfront is a shared, versioned wiki used by both agents and humans. You
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
Missing intermediate nodes are created automatically once the wiki exists.
`wiki set acme "..."` with a one-segment path creates the wiki itself.
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
