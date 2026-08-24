/**
 * Human-readable output helpers.
 */

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

/**
 * @param {Array<{ fullPath: string, excerpt: string, title?: string|null }>} results
 */
export function renderSearchResults (results) {
  if (results.length === 0) return 'no results'
  const width = Math.max(...results.map((result) => result.fullPath.length))
  return results
    .map((result) => `${result.fullPath.padEnd(width + 3)}${result.excerpt.replace(/\s+/g, ' ')}`)
    .join('\n')
}

/**
 * @param {Array<{ ts: string, payload: unknown }>} rows data-channel rows
 */
export function renderData (rows) {
  if (rows.length === 0) return 'no data'
  return rows.map((row) => `${row.ts}  ${JSON.stringify(row.payload)}`).join('\n')
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
