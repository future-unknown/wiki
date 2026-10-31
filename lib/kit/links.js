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

// Inside a Markdown table a label's bar is escaped, `[[x\\|Label]]`, so a
// backslash just before the bar belongs to it, never to the key.
const WIKILINK = /!?\[\[(?:([a-z0-9][a-z0-9_-]*):)?([a-z0-9][a-z0-9_-]*(?:\.[a-z0-9][a-z0-9_-]*)*)?(?:\/([^\]|]+?))?(?:\\?\|[^\]]*)?\]\]/g

// Code, where a link is an example of the syntax rather than a link:
// fenced blocks (``` or ~~~, to a closing fence or the end) and inline
// spans (a run of backticks to the next run as long, within a
// paragraph). Reading surfaces leave code as text, so the index does
// too.
const FENCED = /^[ \t]*(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:^[ \t]*\1[ \t]*$|(?![\s\S]))/gm
const INLINE_CODE = /(`+)(?:(?!\n[ \t]*\n)[\s\S])*?\1(?!`)/g

function withoutCode (text) {
  return text.includes('`') || text.includes('~~~')
    ? text.replace(FENCED, ' ').replace(INLINE_CODE, ' ')
    : text
}

/**
 * The links in a string, in order, each `{ wiki, path, key }` — `wiki`
 * the name of the wiki it names, null for one relative to the page's
 * own; `path` '' for a wiki's root; `key` null for a page. Links inside
 * code are not links. Repeats are kept; callers that index links dedupe.
 *
 * @param {string} text
 * @returns {Array<{ wiki: string|null, path: string, key: string|null }>}
 */
export function parseLinks (text) {
  if (typeof text !== 'string' || !text.includes('[[')) return []
  return linksIn(withoutCode(text))
}

/**
 * Every wikilink pattern in a string, code included: what the index read
 * before it skipped code, so a backfill can tell which of a record's
 * links were only ever examples.
 *
 * @param {string} text
 */
export function linkPatterns (text) {
  if (typeof text !== 'string' || !text.includes('[[')) return []
  return linksIn(text)
}

function linksIn (text) {
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
 * `parse` reads one string (parseLinks; linkPatterns for code too).
 *
 * @param {object} value
 * @param {Function} [parse]
 * @returns {Array<{ wiki: string|null, path: string, key: string|null }>}
 */
export function recordLinks (value, parse = parseLinks) {
  const seen = new Map()
  const visit = (node) => {
    if (typeof node === 'string') {
      for (const link of parse(node)) seen.set(`${link.wiki ?? ''}:${link.path}/${link.key ?? ''}`, link)
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
