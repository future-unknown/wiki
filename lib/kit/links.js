/**
 * Wikilinks: the one grammar every surface renders, read here so the
 * wiki can say what links to what.
 *
 *   [[about.team]]                     a page, by wiki-relative path
 *   [[about.team|the team]]            with a label
 *   [[crm.leads/jo@acme.com]]          a record: its page, a slash, its key
 *   [[crm.leads/jo@acme.com|Jo]]
 *   ![[usage.daily]]                   an embed — a link all the same
 *   [[capital:round.terms]]            a page of another wiki, by its name
 *   [[people:contacts/jo|Jo]]          a record of another wiki
 *   [[capital:]]                       another wiki's root
 *
 * A wiki's name and a colon make a link absolute; without them it is
 * relative to the wiki the page lives in. Slugs never contain a colon
 * or a slash, so neither address can be mistaken for the other, and a
 * record address cannot be mistaken for a page. A key runs to the label
 * bar or the closing brackets, so a key containing `|` or `]` cannot be
 * linked.
 */

const WIKILINK = /!?\[\[(?:([a-z0-9][a-z0-9_-]*):)?([a-z0-9][a-z0-9_-]*(?:\.[a-z0-9][a-z0-9_-]*)*)?(?:\/([^\]|]+))?(?:\|[^\]]*)?\]\]/g

/**
 * The links in a string, in order, each `{ wiki, path, key }` — `wiki`
 * the name of the wiki it names, null for one relative to the page's
 * own; `path` '' for a wiki's root; `key` null for a page. Repeats are
 * kept; callers that index links dedupe.
 *
 * @param {string} text
 * @returns {Array<{ wiki: string|null, path: string, key: string|null }>}
 */
export function parseLinks (text) {
  if (typeof text !== 'string' || !text.includes('[[')) return []
  const links = []
  for (const match of text.matchAll(WIKILINK)) {
    const wiki = match[1] ?? null
    const path = match[2] ?? ''
    // Only a named wiki has a root to link to: [[]] and [[/key]] are
    // not links.
    if (!wiki && !path) continue
    const key = match[3]?.trim() || null
    links.push({ wiki, path, key })
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
      for (const link of parseLinks(node)) seen.set(`${link.wiki ?? ''}:${link.path}/${link.key ?? ''}`, link)
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
