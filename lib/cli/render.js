/**
 * Human-readable output helpers.
 */

import { createTwoFilesPatch } from 'diff'

const PREVIEW_WIDTH = 60

/**
 * Single-line preview for tree output: the title when present,
 * otherwise the first non-empty content line, cleaned and truncated.
 *
 * @param {{ title?: string|null, content?: string }} node
 */
export function preview (node) {
  let text = node.title
  if (!text) {
    text = (node.content || '')
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line !== '') || ''
    text = text.replace(/^#+\s*/, '')
  }
  text = text.replace(/\s+/g, ' ').trim()
  if (text.length > PREVIEW_WIDTH) text = text.slice(0, PREVIEW_WIDTH - 1) + '…'
  return text
}

/**
 * Render a tree (as returned by the API) with Unicode box drawing.
 *
 * @param {object} tree
 * @returns {string}
 */
export function renderTree (tree) {
  const rows = [{ label: tree.fullPath, preview: preview(tree) }]

  function walk (node, prefix) {
    node.children.forEach((child, index) => {
      const last = index === node.children.length - 1
      rows.push({
        label: prefix + (last ? '└── ' : '├── ') + child.slug,
        preview: preview(child)
      })
      walk(child, prefix + (last ? '    ' : '│   '))
    })
  }
  walk(tree, '')

  const width = Math.max(...rows.map((row) => row.label.length))
  return rows
    .map((row) => (row.preview ? row.label.padEnd(width + 3) + row.preview : row.label))
    .join('\n')
}

// A hit's address: a page's full path, or a record's page and key.
function addressOf (entry) {
  return entry.key ? `${entry.fullPath}/${entry.key}` : entry.fullPath
}

/**
 * @param {Array<{ fullPath: string, key?: string, excerpt: string, title?: string|null }>} results
 */
export function renderSearchResults (results) {
  if (results.length === 0) return 'no results'
  const width = Math.max(...results.map((result) => addressOf(result).length))
  return results
    .map((result) => `${addressOf(result).padEnd(width + 3)}${result.excerpt.replace(/\s+/g, ' ')}`)
    .join('\n')
}

function actorLine (actor) {
  if (!actor) return 'unknown'
  const who = actor.onBehalfOf ? `${actor.id} (for ${actor.onBehalfOf})` : actor.id
  return `${actor.type}:${who}`
}

// A record's own fields, stamps left out, keys sorted at every depth:
// the text a version diff compares, so two versions of the same record
// line up field by field.
function recordSource (record) {
  const sorted = (value) => {
    if (Array.isArray(value)) return value.map(sorted)
    if (value === null || typeof value !== 'object') return value
    return Object.fromEntries(Object.keys(value).sort().map((field) => [field, sorted(value[field])]))
  }
  const fields = {}
  for (const [field, value] of Object.entries(record ?? {})) {
    if (!field.startsWith('_')) fields[field] = value
  }
  return Object.keys(fields).length === 0 ? '' : JSON.stringify(sorted(fields), null, 2) + '\n'
}

/**
 * A table record's versions, one line each, newest first.
 * @param {{ versions: Array<object> }} result from wiki.versions
 */
export function renderVersions (result) {
  return result.versions
    .map((version) => `version ${version._v}  ${version._ts}  ${actorLine(version._actor)}  ${version._change}`)
    .join('\n')
}

/**
 * A record version as what it changed: a version line like history's,
 * then a unified diff of the record's fields (sorted JSON) against the
 * version before it. A first version is all additions, a deletion all
 * removals.
 * @param {{ fullPath: string, key: string, version: object, previous: object|null }} result
 */
export function renderVersionDiff ({ fullPath, key, version, previous }) {
  const lines = [`version ${version._v}  ${version._ts}  ${actorLine(version._actor)}  ${version._change}`]
  const before = previous && previous._change !== 'deleted' ? previous : null
  const fromSource = before ? recordSource(before) : ''
  const toSource = version._change === 'deleted' ? '' : recordSource(version)
  if (fromSource === toSource) {
    lines.push('(fields unchanged)')
    return lines.join('\n')
  }
  const address = `${fullPath}/${key}`
  const fromName = before ? `${address}@v${before._v}` : '/dev/null'
  const toName = toSource === '' ? '/dev/null' : `${address}@v${version._v}`
  const patch = createTwoFilesPatch(fromName, toName, fromSource, toSource, undefined, undefined, { context: DIFF_CONTEXT })
  lines.push(patch.split('\n').filter((line) => !line.startsWith('====')).join('\n').trimEnd())
  return lines.join('\n')
}

/**
 * What links here: one line per linking page or record, its address
 * then its heading.
 * @param {{ links: Array<object> }} result from wiki.links
 */
export function renderLinks (result) {
  if (result.links.length === 0) return 'no links'
  const width = Math.max(...result.links.map((link) => addressOf(link).length))
  return result.links
    .map((link) => (link.title ? `${addressOf(link).padEnd(width + 3)}${link.title}` : addressOf(link)))
    .join('\n')
}

/**
 * One line per record: its timestamp stamp, then the caller fields
 * (stamps stripped — they are addressing and provenance, not data).
 *
 * @param {Array<object>} records
 */
export function renderRecords (records) {
  if (records.length === 0) return 'no records'
  return records
    .map((record) => {
      const fields = {}
      for (const [field, value] of Object.entries(record)) {
        if (!field.startsWith('_')) fields[field] = value
      }
      return `${record._ts}  ${JSON.stringify(fields)}`
    })
    .join('\n')
}

/**
 * @param {Array<object>} history entries from the API
 */
export function renderHistory (history) {
  return history
    .map((entry) => {
      const actor = entry.commit.actor
      const who = actor.onBehalfOf ? `${actor.id} (for ${actor.onBehalfOf})` : actor.id
      const flags = entry.deleted ? ' [deleted]' : ''
      const message = entry.commit.message ? `  ${entry.commit.message}` : ''
      return `commit ${entry.commitId}  revision ${entry.revisionId}  ${entry.createdAt}  ${actor.type}:${who}${flags}${message}`
    })
    .join('\n')
}

// Unchanged lines shown around each hunk of a diff.
const DIFF_CONTEXT = 3

/**
 * A revision as what it changed: a commit line like history's, the
 * fields that changed around the source (title, slug, metadata) as
 * before -> after, then a unified diff of the source against the
 * revision before it. A first revision is all additions, a tombstone
 * all removals; a move with the same source says so instead.
 * @param {object} revision from wiki.revision — carries `previous`
 */
export function renderDiff (revision) {
  const actor = revision.commit.actor
  const who = actor.onBehalfOf ? `${actor.id} (for ${actor.onBehalfOf})` : actor.id
  const message = revision.commit.message ? `  ${revision.commit.message}` : ''
  const lines = [
    `commit ${revision.commitId}  revision ${revision.revisionId}  ${revision.createdAt}  ${actor.type}:${who}  ${revision.kind}${message}`
  ]
  const before = revision.previous && !revision.previous.deleted ? revision.previous : null
  const gone = revision.kind === 'deleted'
  const field = (name, from, to) => {
    if (from !== to) lines.push(`${name}: ${JSON.stringify(from ?? null)} -> ${JSON.stringify(to ?? null)}`)
  }
  if (revision.kind === 'moved') field('slug', before?.slug, revision.slug)
  field('title', before?.title ?? null, gone ? null : (revision.title ?? null))
  const fromMeta = before?.metadata ?? {}
  const toMeta = gone ? {} : (revision.metadata ?? {})
  for (const key of [...new Set([...Object.keys(fromMeta), ...Object.keys(toMeta)])].sort()) {
    const from = key in fromMeta ? JSON.stringify(fromMeta[key]) : 'null'
    const to = key in toMeta ? JSON.stringify(toMeta[key]) : 'null'
    if (from !== to) lines.push(`metadata.${key}: ${from} -> ${to}`)
  }
  const fromContent = before ? before.content : ''
  const toContent = gone ? '' : revision.content
  if (fromContent === toContent) {
    lines.push(revision.kind === 'moved' ? '(moved; content unchanged)' : '(content unchanged)')
    return lines.join('\n')
  }
  const fromName = before ? `${revision.fullPath}@c${before.commitId}` : '/dev/null'
  const toName = gone ? '/dev/null' : `${revision.fullPath}@c${revision.commitId}`
  const patch = createTwoFilesPatch(fromName, toName, fromContent, toContent, undefined, undefined, { context: DIFF_CONTEXT })
  // Drop the "Index"/"=====" banner; the commit line above is the header.
  lines.push(patch.split('\n').filter((line) => !line.startsWith('====')).join('\n').trimEnd())
  return lines.join('\n')
}

/**
 * @param {Array<object>} log entries from the API — a commit line, then
 * one indented line per page it touched
 */
export function renderLog (log) {
  return log
    .map((entry) => {
      const who = entry.actor.onBehalfOf ? `${entry.actor.id} (for ${entry.actor.onBehalfOf})` : entry.actor.id
      const message = entry.message ? `  ${entry.message}` : ''
      const head = `commit ${entry.id}  ${entry.createdAt}  ${entry.actor.type}:${who}${message}`
      const changes = entry.changes.map((change) => `  ${change.kind.padEnd(7)} ${change.fullPath}`)
      return [head, ...changes].join('\n')
    })
    .join('\n')
}
