---
name: wiki
description: Read and write shared documentation in a wiki using the `wiki` CLI. Use when a task requires looking up, recording, or reorganizing knowledge that lives in a wiki addressed by dot-separated paths like acme.about.foo.
---

# Working with a wiki

wiki is a shared, versioned knowledge base used by both agents and humans. You
interact with it through the `wiki` CLI. Everything is a page addressed by a
dot-separated path; the first segment is the wiki itself:

```text
acme                the wiki root (also a page)
acme.about          a section (also a page)
acme.about.foo      a page inside that section
```

Content is Markdown. A page can hold content *and* have children — there is no
file-vs-directory distinction. Every change is recorded permanently; nothing
you overwrite or delete is lost.

Every page is also a small data store: **a document you can read plus records
you can query**. A page with a key is a **table** — records are rows with an
identity, edited in place, and every version of each is kept; a page without
one is a **log** — records are appended and never edited (see *Records*
below). A page keeps every revision, a table row its own versions, and a
log is its own history.

Pages and records have their own verbs, and they never overlap:

| | read | write | change part | remove |
|---|---|---|---|---|
| **pages** (writing) | `wiki read` | `wiki write` | `wiki edit` | `wiki rm` |
| **records** (data) | `wiki get`, `wiki records` | `wiki set` | — | `wiki del` |

## Configuration

The CLI reads `WIKI_URL` and `WIKI_TOKEN` from the environment (or
`--url` / `--token` flags). Never print the token.

## Core rules

1. **Orient before writing.** If you do not know where information belongs,
   inspect the tree (`wiki tree`) or search (`wiki search`) first.
2. **Read before you modify.** Before changing an existing page, read it with
   `--json` and preserve the returned `revisionId`.
3. **Change only what you mean to.** To change part of a page, use
   `wiki edit` with the exact text you read; it touches nothing else, so
   it cannot overwrite someone else's change elsewhere on the page. To
   rewrite a page, write it whole with `wiki write --if-revision
   <revisionId>`, based on the content you actually read.
4. **On conflict, merge and retry.** If a write fails with a conflict
   (exit code 4), someone changed the page after you read it: reread it,
   see exactly what they changed with `wiki diff`, merge your change into
   the new state, and retry with the fresh `revisionId`.
5. **Read narrowly.** Prefer targeted `wiki read` calls over dumping an entire
   large wiki with an unbounded `wiki tree`.
6. **Prefer `--json`** whenever output will be consumed programmatically.
   Every meaningful command supports it.
7. **Never use `--recursive` deletion** unless the task explicitly requires
   deleting a whole subtree.
8. **Review changes as diffs.** To learn what an edit did — yours, another
   agent's, or a person's — use `wiki diff` rather than reading and
   comparing whole pages.
9. **Read the actor, not just the id.** History, changes, notes and records name
   who acted: `type` (human or agent), `id`, `onBehalfOf` (the person an
   agent worked for — treat the change as theirs), and, when the host says,
   `via` (the surface it came through) and `org` (set only when the author
   acted from an organization other than the wiki's — a wiki can be shared
   across organizations). Name people rather than quoting ids when the host
   offers a way to resolve them.

## The safe edit loop

```bash
# 1. read the page and keep its revisionId
wiki read acme.about.foo --json
# -> { ..., "content": "...", "revisionId": "3f2a..." }

# 2a. change one part: the exact text you read, and what replaces it
wiki edit acme.about.foo --old "Deploys run nightly." --new "Deploys run hourly."

# 2b. or rewrite the page whole, conditionally
wiki write acme.about.foo --if-revision 3f2a... <<'EOF'
# Foo

Updated documentation.
EOF

# 3. if that exits with code 4 (conflict): see the other change, reread, merge, retry
wiki diff acme.about.foo          # what the other writer changed
wiki read acme.about.foo --json   # fresh content + fresh revisionId
```

## Commands

### Read a page — `wiki read <path>`

Prints the raw Markdown content on stdout; `--json` adds ids, title,
metadata, `revisionId`, timestamps, and the change that produced this
revision (with its actor and message) — who last touched the page,
without a history call. `--change <id>` or `--at <iso>` read historical
states (mutually exclusive).

```bash
wiki read acme.about.foo
wiki read acme.about.foo --json
wiki read acme.about.foo --change 123
```

### Write a page — `wiki write <path> [content]`

Creates or replaces a page's content whole. Supply content exactly one way:
inline argument, stdin (pipe/heredoc), or `--file <path>`. Also supports
`--title`, `--metadata '<json object>'`, `--if-revision <revisionId>`, and
`--message '<why>'` (a short note on the change; use it for meaningful
edits). Anything missing is created automatically: intermediate pages, and
the wiki itself if it does not exist yet — so double-check the first path
segment before writing; a typo there creates a new wiki instead of failing.
Omitted `--title`/`--metadata` are preserved, but content is replaced whole.

```bash
wiki write acme.about.foo "Short note"
wiki write acme.about.foo < foo.md
wiki write acme.guides.deploy --file deploy.md --title "Deploying" --message "initial guide"
```

### Change part of a page — `wiki edit <path> --old <text> --new <text>`

Replaces one exact string in the page's content and leaves everything
else as it is. `--old` must occur exactly once — give enough of the
surrounding text to make it unique — or the edit is refused (exit code
2) and says how many times it occurs; `--all` replaces every
occurrence instead. The page is read and written in one step, so an
edit never lands on a page that changed in between. Supports
`--if-revision` and `--message`. Prefer it to `wiki write` whenever you
are changing a sentence, a line, or a section rather than the whole
page.

```bash
wiki edit acme.about.foo --old "Q3 targets" --new "Q4 targets"
wiki edit acme.about.foo --old "acme" --new "Acme" --all --message "capitalize"
```

### Merge metadata — `wiki meta <path> [json]`

Merges fields into a page's metadata without touching the rest — the
safe way to change one declaration when other fields must survive.
Supply a JSON object inline or on stdin; a `null` value removes its
field; `--replace` swaps the whole object instead of merging. This is
an authored change like `write`: it makes a revision and supports
`--if-revision` and `--message '<why>'`.

```bash
wiki meta acme.usage '{"retain": {"days": 90}}'
wiki meta acme.tasks '{"key": "id"}' --message "tasks become a table"
wiki meta acme.usage '{"retain": null}'
```

### Browse — `wiki tree <path>`

Shows the hierarchy with one-line previews. Scope it to any subtree and limit
it with `--depth <n>`. Supports `--change` / `--at` for historical trees and
`--json` for the full structured tree, where each page carries `records`
— `{ count, latestTs }` when the page holds records, `null` otherwise —
so you can find the pages that carry data without reading each one.

```bash
wiki tree acme --depth 2
wiki tree acme.architecture --json
```

### Search — `wiki search <path> <query>`

Full-text search over current content, titles, and paths, scoped to any
subtree — and over the records of tables: every text value a record
carries, current version only. Logs are not searched. A page hit is its
full path; a record hit is its address, `<page>/<key>`, and with `--json`
carries `kind` (`page` or `record`), `key`, and the record's heading as
`title`. `--limit <n>` caps results.

```bash
wiki search acme "authentication"
wiki search acme.architecture "tokens" --json
```

### History — `wiki history <path>[/<key>]`

Lists a page's revisions, newest first, each with its change id,
revision id, actor, and message. `--limit <n>` caps entries. Use a
change id from here with `wiki read --change` to read the page as it
was, or with `wiki diff --change` to see what that revision changed.

Given a record's address — its table's path, a slash, its key — it
lists that row's versions instead, newest first: each version's
number, time, actor, and whether it `created`, `updated`, or `deleted`
the row. A row's history outlives it: a deleted row still has
one, and a record written again under the same key continues it. When
more versions remain, pass the continuation token back with
`--cursor <token>`.

```bash
wiki history acme.about.foo --json
wiki history acme.crm.contacts/jo
```

### Diff — `wiki diff <path>[/<key>]`

Shows what one revision changed: a change line (id, actor, message,
and whether the revision created, updated, moved, or deleted the
page), then any title, slug, or metadata change as `before -> after`,
then a unified diff of the page's source against the revision before
it. A page's first revision shows as all additions and a deletion as
all removals; a move that left the content alone says so.

With no option it reads the latest revision — the quickest answer to
"what just happened to this page". `--change <id>` reads the page's
revision at that change; `--revision <id>` addresses a revision
directly (revision ids appear in `wiki history`, and in `wiki changes
--json`). The two are exclusive. `--json` returns the revision as data,
with the revision before it under `previous`.

```bash
wiki diff acme.about.foo
wiki diff acme.about.foo --change 12
wiki diff acme.about.foo --revision 3f2a... --json
```

Given a record's address it shows what one version of that record
changed, read the way a page revision is: a version line, then each
other field that changed as `before -> after`, then a unified diff of
the record's writing (its `content`) against the version before it.
With no option it reads the latest version; `--version <n>` names one
from `wiki history`. `--json` returns the version and the one before
it under `previous`.

```bash
wiki diff acme.crm.contacts/jo
wiki diff acme.crm.contacts/jo --version 3
```

### What links here — `wiki links <path>[/<key>]`

Lists the pages whose content and the records that carry a wikilink to
a page — or, given a record's address, to that record. A record links
to whatever any of its values links to. With `--json` each linking
record comes with its current value under `record`, so you can read
them without another call. `--limit <n>` caps the list.

```bash
wiki links acme.crm.contacts/jo
wiki links acme.architecture --json
```

### Changes — `wiki changes <path>`

What changed in the wiki, newest first: each change with its actor,
message, and the pages it touched, each marked `created`, `updated`,
`moved`, or `deleted`. A subtree path scopes it to changes under that
page. `--limit <n>` caps changes; `--before <change id>` continues an
earlier listing. To see what a listed change did to a page, pass the
page and the change id to `wiki diff --change`. Record writes
(`wiki set`) are not listed here; a table row's changes are in its own
history (`wiki history <path>/<key>`).

```bash
wiki changes acme --limit 20
wiki changes acme.about --json
```

### Move — `wiki move <from> <to>`

Moves or renames a page together with its entire subtree. Identity and
history are preserved; only the address changes. Both paths must be in the
same wiki, the destination parent must exist, and the destination must be
free. Supports `--if-revision` and `--message`.

```bash
wiki move acme.about.foo acme.archive.foo
```

### Delete — `wiki rm <path>`

Deletes a page. Fails on pages with children unless `--recursive` is given.
For risky subtree deletions you may also pass `--if-change <changeId>` to
ensure the wiki has not changed at all since you inspected it. Supports
`--if-revision` and `--message`. History is preserved; recreating the path
later makes a fresh page.

```bash
wiki rm acme.scratch
wiki rm acme.old-section --recursive --if-change 57
```

## Records

Besides its document, every page carries one set of **records** — JSON
objects for structured data: metrics, events, survey responses, task
state, config. The rule for choosing:

- **`wiki write`** (or `wiki edit`) when you are writing a *document* —
  one of a kind, composed for people to read. Every revision is kept,
  guarded by `--if-revision`.
- **`wiki set`** when you are writing *one of many things of the same
  shape* — a contact, a task, a decision, an event, a measurement.
  Records are stamped (`_actor`, `_ts`, `_v`, and `_id`, the record's
  address within its page) and are not listed in the wiki's changes.

One declaration decides how a page's records behave:

- **A table** — `metadata.key` names a field (e.g. `{"key": "id"}`).
  `set` adds or replaces the row with that field's value. Every version of every row is
  kept (see `wiki history <path>/<key>`); `metadata.retain`
  (`{"versions": n}`) keeps only the newest n. `--if-version <n>` makes
  the write conditional on the record's current `_v` — when two agents
  race to update the same record, exactly one wins and the loser exits
  with a conflict.
- **A log** — no key declared. `set` adds an entry. `_ts` is when it
  happened — `--ts <iso>` backfills it — and `_written` when the wiki
  got it. `metadata.retain` (`{"days": n}`) expires old records, so do
  not treat a log as permanent storage.

**A record can carry writing.** On a table, a record whose `content`
field is a string carries a Markdown document — notes on a contact,
the description of a task — and reading surfaces show it as one,
headed by the record's `title`, else its `name`, else its key. A
record holds 16 KB at most, so keep it to what is about that one
thing; a long document is a page. Prefer one table of records with
content over a page per row: the table stays one page, and each record
keeps its own history.

A record is addressed as its page's path, a slash, and its key —
`acme.crm.contacts/jo` — and linked the same way, wiki-relative:
`[[crm.contacts/jo]]`. A record field whose value is a link is how one
record points at another (a deal's `person`, a call's `contact`):
`wiki links` reads those relations backwards, so do not copy one
record's data into another to show them together.

Read options follow the sort order. On a log records sort by time, so
`--latest`, `--since`, and `--until` mean what they say. On a table
records sort by key: `--since`/`--until` bound the key range and
`--latest` returns the highest key, not the most recent write — read
`_ts` on the records to judge recency. Changing `key` on a page that
already holds records does not rewrite them: earlier records keep
their addresses and list alongside the new ones.

A page may also declare `metadata.schema` — a JSON Schema that every
record must match; a `set` that does not match is refused. Declare
`key`, `schema`, and `retain` with `wiki meta`. A record must be a
JSON object, and field names starting with `_` are reserved for
stamps.

### Write a record — `wiki set <path> [json]`

Supply the record inline or via stdin (inline wins). The page must
already exist. Tables take `--if-version <n>`; logs take `--ts <iso>`.

```bash
wiki set acme.usage '{"requests": 1042}'
wiki set acme.tasks '{"id": "t-41", "status": "claimed", "by": "agent-7"}' --if-version 1
wiki set acme.usage --ts 2026-08-01T00:00:00Z < record.json
wiki set acme.crm.contacts '{"id": "jo", "name": "Jo Smith", "content": "## Intro\n\nMet at the summit."}'
```

### Read one record — `wiki get <path>/<key>`

Prints exactly that record: a table's row by its key-field value, or a
log entry by its `_id`. The address is the page's path, a slash, and
the key.

```bash
wiki get acme.tasks/t-41
wiki get acme.crm.contacts/jo --json
```

### Read records — `wiki records <path>`

The page's records in sort order — time on logs,
key on tables — or `--reverse` for newest first on a log (highest key
first on a table). `--latest` returns only the newest (and combines
with nothing else); `--since <iso>` / `--until <iso>` bound the range;
`--limit <n>` caps it; when more records remain the result carries a
continuation token — pass it back with `--cursor <token>` to continue.
To read recent activity, prefer `--reverse --limit <n>` over paging
forward from the beginning.

`--at <iso>` reads the records as they stood at that moment: a table
whole, from its kept versions — keys whose state then was not kept
come back under `unknown` rather than looking absent — and a log in
pages, the records written by then. A deleted log record is gone from
every moment.

```bash
wiki records acme.tasks --at 2026-09-01T00:00:00Z
wiki records acme.usage --since 2026-08-01T00:00:00Z --limit 100
wiki records acme.usage --reverse --limit 20
wiki records acme.usage --latest
```

### Delete a record — `wiki del <path>/<key>`

Removes one record by its key (tables) or `_id` (logs) and prints what
was removed. On a table the deletion is kept as the row's last
version. Deleting records is curation and needs write access, not just
record access.

```bash
wiki del acme.tasks/t-41
```

## Typed pages

A page's `metadata.type` declares how reading surfaces render its
content: `markdown` (the default) or `json` (any JSON value). Typed
content is still just content — write it with the same safe edit loop.
Rows belong in records, not in content: make the page a table.

```bash
wiki write acme.config.flags --metadata '{"type":"json"}' <<'EOF'
{"beta": true, "regions": ["us", "eu"]}
EOF
```

## Linking between pages

Link pages with wikilinks: `[[architecture.deployment]]`, or labeled,
`[[docs.cli|the CLI guide]]`. Paths are the same wiki-relative dot-paths
used everywhere else — links resolve within the wiki the page lives in.
Link a record by its address: `[[crm.contacts/jo|Jo]]`. Inside a
Markdown table cell, escape the label pipe — `[[path\|Label]]` —
because tables split cells on a raw `|`. Write links anywhere in page
content or in any record value; reading surfaces render them as
navigation, and the wiki keeps track of them, so `wiki links` can say
what links to any page or record.

To embed a whole page instead of linking it, put an embed on a line of
its own:

```text
![[usage.daily]]
```

Reading surfaces render the target page inline — content and any
observed data — so a dashboard is just a page of prose and embeds. To
everything else (including `wiki read`) an embed is plain text, and in
running text or code it stays literal. Embeds resolve the same
wiki-relative paths as wikilinks; after moving a page, find stale
embeds the same way you find stale wikilinks.

After moving a page, links pointing at its old path still say the old
path. Find them with `wiki links <old.path>` before the move (or
`wiki search "<old.path>"` after it) and update each referring page
(with `--if-revision`, as always) and record.

## Exit codes

| code | meaning |
|------|-------------------------|
| 0 | success |
| 1 | general failure |
| 2 | invalid arguments (including an edit whose `--old` is missing or ambiguous) |
| 3 | not found |
| 4 | conflict (stale revision, existing destination, non-empty page) |
| 5 | authentication failure |
| 6 | authorization failure |

Errors go to stderr; stdout carries only requested data, so it is safe to
pipe and parse.
