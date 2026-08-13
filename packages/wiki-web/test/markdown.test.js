import should from 'should'
import { renderMarkdown } from '../lib/markdown.js'

describe('renderMarkdown', () => {
  it('renders headings, paragraphs, and inline styles', () => {
    const html = renderMarkdown('# Title\n\nSome **bold** and *italic* and `code`.')
    html.should.containEql('<h1>Title</h1>')
    html.should.containEql('<strong>bold</strong>')
    html.should.containEql('<em>italic</em>')
    html.should.containEql('<code>code</code>')
  })

  it('renders fenced code blocks verbatim', () => {
    const html = renderMarkdown('```\nconst x = 1 < 2\n```')
    html.should.containEql('<pre><code>const x = 1 &lt; 2</code></pre>')
  })

  it('renders lists and blockquotes', () => {
    renderMarkdown('- one\n- two').should.containEql('<ul><li>one</li><li>two</li></ul>')
    renderMarkdown('1. first\n2. second').should.containEql('<ol><li>first</li>')
    renderMarkdown('> quoted text').should.containEql('<blockquote>quoted text</blockquote>')
  })

  it('escapes raw HTML instead of executing it', () => {
    const html = renderMarkdown('hello <script>alert(1)</script> <img src=x onerror=y>')
    html.should.not.containEql('<script>')
    html.should.not.containEql('<img')
    html.should.containEql('&lt;script&gt;')
  })

  it('allows safe links and drops dangerous ones', () => {
    renderMarkdown('[ok](https://example.com)').should.containEql('href="https://example.com"')
    renderMarkdown('[rel](./sibling)').should.containEql('href="./sibling"')
    const bad = renderMarkdown('[evil](javascript:alert(1))')
    bad.should.not.containEql('javascript:')
    bad.should.containEql('evil')
  })

  it('handles empty input', () => {
    renderMarkdown('').should.equal('')
    renderMarkdown(undefined).should.equal('')
  })
})
