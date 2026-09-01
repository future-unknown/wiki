/**
 * Pure content renderers for wiki-web.
 *
 * A page's `metadata.type` declares how its content renders: markdown
 * (default), json, or table. Everything here is escape-first HTML
 * string building with no DOM access, so it is shared by the browser
 * app and node tests exactly like markdown.js. Non-conforming content
 * degrades to a visible fallback; it never throws.
 */

import { escapeHtml, renderMarkdown } from './markdown.js'

function isPlainObject (value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function cellText (value) {
  if (value === undefined) return ''
  if (typeof value === 'string') return value
  return JSON.stringify(value)
}

/**
 * Pretty-printed JSON in a code block; raw content with a notice when
 * it does not parse.
 *
 * @param {string} content
 */
export function renderJson (content) {
  let value
  try {
    value = JSON.parse(content)
  } catch {
    return '<p class="hint">not valid JSON — showing raw content</p>' +
      `<pre><code>${escapeHtml(content)}</code></pre>`
  }
  return `<pre class="json"><code>${escapeHtml(JSON.stringify(value, null, 2))}</code></pre>`
}

/**
 * A JSON array of objects as a table (columns in first-appearance
 * order); anything else falls back to the JSON rendering with a notice.
 *
 * @param {string} content
 */
export function renderTable (content) {
  let value
  try {
    value = JSON.parse(content)
  } catch {
    return renderJson(content)
  }
  if (!Array.isArray(value) || value.length === 0 || !value.every(isPlainObject)) {
    return '<p class="hint">table pages hold a JSON array of objects — showing JSON</p>' +
      renderJson(content)
  }
  const columns = []
  for (const row of value) {
    for (const key of Object.keys(row)) {
      if (!columns.includes(key)) columns.push(key)
    }
  }
  const head = columns.map((column) => `<th>${escapeHtml(column)}</th>`).join('')
  const body = value
    .map((row) =>
      `<tr>${columns.map((column) => `<td>${escapeHtml(cellText(row[column]))}</td>`).join('')}</tr>`)
    .join('')
  return `<table class="data-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`
}

/**
 * Dispatch on the page's declared type.
 *
 * @param {{ content: string, metadata?: { type?: string } }} node
 */
export function renderContent (node) {
  const type = node.metadata?.type
  if (type === 'json') return renderJson(node.content)
  if (type === 'table') return renderTable(node.content)
  return renderMarkdown(node.content)
}

function numericValue (record, field) {
  if (typeof record[field] === 'number' && Number.isFinite(record[field])) {
    return record[field]
  }
  return null
}

/**
 * Chart-ready series from a page's records: x is epoch seconds from
 * the `_ts` stamp (numeric, as charting expects), y is one array per
 * numeric field. Fields come from `renderConfig.fields` when given,
 * otherwise every numeric caller field seen in any record (stamps are
 * never charted). Missing values are null gaps.
 *
 * @param {Array<object>} records
 * @param {{ fields?: string[] }} [renderConfig] the page's metadata.data.render
 * @returns {{ ts: number[], series: Record<string, Array<number|null>> }}
 */
export function seriesFromRows (records, renderConfig) {
  const named = Array.isArray(renderConfig?.fields)
    ? renderConfig.fields.filter((field) => typeof field === 'string' && !field.startsWith('_'))
    : null
  const fields = named ?? []
  if (!named) {
    for (const record of records) {
      if (!isPlainObject(record)) continue
      for (const [key, value] of Object.entries(record)) {
        if (key.startsWith('_')) continue
        if (typeof value === 'number' && Number.isFinite(value) && !fields.includes(key)) {
          fields.push(key)
        }
      }
    }
  }
  const ts = records.map((record) => Math.round(Date.parse(record._ts) / 1000))
  const series = {}
  for (const field of fields) {
    series[field] = records.map((record) => (isPlainObject(record) ? numericValue(record, field) : null))
  }
  return { ts, series }
}
