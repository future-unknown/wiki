/**
 * Small, safe Markdown renderer for wiki-web.
 *
 * All input is HTML-escaped before any markup is generated, so raw
 * HTML in documents is displayed as text, never executed. Supports
 * headings, paragraphs, fenced code, inline code, bold, italic,
 * links (http/https/mailto/relative only), lists, blockquotes, and
 * horizontal rules.
 */

export function escapeHtml (text) {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function safeHref (url) {
  const trimmed = url.trim()
  if (/^(https?:|mailto:)/i.test(trimmed)) return trimmed
  if (/^(#|\/|\.\/|\.\.\/)/.test(trimmed)) return trimmed
  return null
}

// [[path]] / [[path|label]] — org-relative wiki page links. Rendered as
// anchors carrying data-wikilink; the app resolves them against the
// current wiki. Code spans are exempt so docs about the syntax stay text.
// ![[path]] on a line of its own is an embed (see renderMarkdown); in
// running text it stays literal, so the wikilink pass matches a leading
// `!` too and leaves those occurrences untouched.
const PATH_PATTERN = '[a-z0-9][a-z0-9_-]*(?:\\.[a-z0-9][a-z0-9_-]*)*'
const WIKILINK = new RegExp(`(!?)\\[\\[(${PATH_PATTERN})(?:\\|([^\\]|]+))?\\]\\]`, 'g')
const EMBED_LINE = new RegExp(`^!\\[\\[(${PATH_PATTERN})\\]\\]\\s*$`)

function inline (raw) {
  let text = escapeHtml(raw)
  text = text.replace(/`([^`]+)`/g, (match, code) => `<code>${code}</code>`)
  text = text
    .split(/(<code>[\s\S]*?<\/code>)/)
    .map((part) => part.startsWith('<code>')
      ? part
      : part.replace(WIKILINK, (match, bang, path, label) => bang
        ? match
        : `<a href="#" data-wikilink="${path}">${(label || path).trim()}</a>`))
    .join('')
  text = text.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (match, label, url) => {
    const href = safeHref(url)
    if (!href) return label
    return `<a href="${escapeHtml(href)}" rel="noopener noreferrer">${label}</a>`
  })
  text = text.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  text = text.replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>')
  return text
}

/**
 * @param {string} source Markdown text
 * @returns {string} sanitized HTML
 */
export function renderMarkdown (source) {
  const lines = (source || '').split('\n')
  const html = []
  let index = 0

  while (index < lines.length) {
    const line = lines[index]

    if (line.trim() === '') { index += 1; continue }

    if (/^```/.test(line)) {
      const block = []
      index += 1
      while (index < lines.length && !/^```/.test(lines[index])) {
        block.push(lines[index])
        index += 1
      }
      index += 1 // closing fence
      html.push(`<pre><code>${escapeHtml(block.join('\n'))}</code></pre>`)
      continue
    }

    const heading = line.match(/^(#{1,6})\s+(.*)$/)
    if (heading) {
      const level = heading[1].length
      html.push(`<h${level}>${inline(heading[2])}</h${level}>`)
      index += 1
      continue
    }

    if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) {
      html.push('<hr>')
      index += 1
      continue
    }

    if (/^>\s?/.test(line)) {
      const block = []
      while (index < lines.length && /^>\s?/.test(lines[index])) {
        block.push(lines[index].replace(/^>\s?/, ''))
        index += 1
      }
      html.push(`<blockquote>${inline(block.join(' '))}</blockquote>`)
      continue
    }

    // ![[path]] on its own line embeds the target page: an empty,
    // app-hydrated placeholder. The syntax carries no content itself.
    const embed = line.match(EMBED_LINE)
    if (embed) {
      html.push(`<div class="embed" data-embed="${embed[1]}"></div>`)
      index += 1
      continue
    }

    const unordered = /^\s*[-*+]\s+/
    const ordered = /^\s*\d+\.\s+/
    if (unordered.test(line) || ordered.test(line)) {
      const isOrdered = ordered.test(line)
      const marker = isOrdered ? ordered : unordered
      const items = []
      while (index < lines.length && marker.test(lines[index])) {
        items.push(`<li>${inline(lines[index].replace(marker, ''))}</li>`)
        index += 1
      }
      const tag = isOrdered ? 'ol' : 'ul'
      html.push(`<${tag}>${items.join('')}</${tag}>`)
      continue
    }

    // A valid embed line interrupts a paragraph (no blank line needed);
    // an invalid one is just text and stays in the paragraph.
    const paragraph = []
    while (index < lines.length && lines[index].trim() !== '' &&
           !/^(#{1,6}\s|```|>|\s*[-*+]\s|\s*\d+\.\s)/.test(lines[index]) &&
           !EMBED_LINE.test(lines[index])) {
      paragraph.push(lines[index].trim())
      index += 1
    }
    html.push(`<p>${inline(paragraph.join(' '))}</p>`)
  }

  return html.join('\n')
}
