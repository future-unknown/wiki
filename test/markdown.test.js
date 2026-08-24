import should from 'should'
import { renderMarkdown } from '../web/markdown.js'

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

  it('renders wikilinks outside code spans', () => {
    const html = renderMarkdown('See [[docs.cli|the guide]] and [[roadmap]], not `[[docs.cli]]`.')
    html.should.containEql('<a href="#" data-wikilink="docs.cli">the guide</a>')
    html.should.containEql('<a href="#" data-wikilink="roadmap">roadmap</a>')
    html.should.containEql('<code>[[docs.cli]]</code>')
    renderMarkdown('[[Not.Valid]]').should.not.containEql('data-wikilink')
  })

  it('renders an embed line as an empty placeholder div', () => {
    renderMarkdown('![[usage.daily]]')
      .should.equal('<div class="embed" data-embed="usage.daily"></div>')
  })

  it('lets a valid embed line interrupt a paragraph', () => {
    const html = renderMarkdown('Some prose.\n![[usage.daily]]\nMore prose.')
    html.should.containEql('<p>Some prose.</p>')
    html.should.containEql('data-embed="usage.daily"')
    html.should.containEql('<p>More prose.</p>')
  })

  it('keeps inline and invalid embeds as literal text', () => {
    const inline = renderMarkdown('See ![[usage.daily]] for numbers.')
    inline.should.not.containEql('data-embed')
    inline.should.not.containEql('data-wikilink')
    inline.should.containEql('![[usage.daily]]')

    const invalid = renderMarkdown('![[Not Valid]]')
    invalid.should.not.containEql('data-embed')
    invalid.should.containEql('![[Not Valid]]')
  })

  it('leaves embeds in code alone', () => {
    renderMarkdown('```\n![[usage.daily]]\n```').should.not.containEql('data-embed')
    renderMarkdown('Use `![[usage.daily]]` to embed.').should.not.containEql('data-embed')
  })

  it('handles empty input', () => {
    renderMarkdown('').should.equal('')
    renderMarkdown(undefined).should.equal('')
  })
})
