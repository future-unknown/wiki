/**
 * Wikilinks: the one grammar every surface renders, read here so the
 * wiki can say what links to what.
 *
 *   [[about.team]]                     a page, by wiki-relative path
 *   [[about.team|the team]]            with a label
 *   [[crm.leads/jo@acme.com]]          a record: its page, a slash, its key
 *   [[crm.leads/jo@acme.com|Jo]]
 *   ![[usage.daily]]                   an embed — a link all the same
 *
 * Slugs never contain a slash, so a record address cannot be mistaken
 * for a page. A key runs to the label bar or the closing brackets, so
 * a key containing `|` or `]` cannot be linked.
 */

const WIKILINK = /!?\[\[([a-z0-9][a-z0-9_-]*(?:\.[a-z0-9][a-z0-9_-]*)*)(?:\/([^\]|]+))?(?:\|[^\]]*)?\]\]/g

/**
 * The links in a string, in order, each `{ path, key }` — `key` null
 * for a page. Repeats are kept; callers that index links dedupe.
 *
 * @param {string} text
 * @returns {Array<{ path: string, key: string|null }>}
 */
export function parseLinks (text) {
  if (typeof text !== 'string' || !text.includes('[[')) return []
  const links = []
  for (const match of text.matchAll(WIKILINK)) {
    const key = match[2]?.trim() || null
    links.push({ path: match[1], key })
  }
  return links
}

/**
 * Every link a record carries, anywhere in it — fields, arrays,
 * nested objects, its content — deduplicated. Stamps (underscore
 * fields) are the store's, not the author's, and are skipped.
 *
 * @param {object} value
 * @returns {Array<{ path: string, key: string|null }>}
 */
export function recordLinks (value) {
  const seen = new Map()
  const visit = (node) => {
    if (typeof node === 'string') {
      for (const link of parseLinks(node)) seen.set(`${link.path}/${link.key ?? ''}`, link)
    } else if (Array.isArray(node)) {
      node.forEach(visit)
    } else if (node !== null && typeof node === 'object') {
      for (const [field, inner] of Object.entries(node)) {
        if (!field.startsWith('_')) visit(inner)
      }
    }
  }
  visit(value)
  return [...seen.values()]
}

/**
 * A record's heading: its `title`, else its `name`, else its key — a
 * page's own field names, so a record with a title and content reads
 * as a small page.
 *
 * @param {object} record
 * @param {string} key
 */
export function recordTitle (record, key) {
  for (const field of ['title', 'name']) {
    const value = record?.[field]
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
  }
  return key
}

/**
 * Every string a record carries, for search: its fields' text, nested
 * values included, stamps left out.
 *
 * @param {object} value
 * @returns {string}
 */
export function recordText (value) {
  const parts = []
  const visit = (node) => {
    if (typeof node === 'string') parts.push(node)
    else if (typeof node === 'number' && Number.isFinite(node)) parts.push(String(node))
    else if (Array.isArray(node)) node.forEach(visit)
    else if (node !== null && typeof node === 'object') {
      for (const [field, inner] of Object.entries(node)) {
        if (!field.startsWith('_')) visit(inner)
      }
    }
  }
  visit(value)
  return parts.join('\n')
}
