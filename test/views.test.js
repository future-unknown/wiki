import should from 'should'
import { renderJson, renderContent, seriesFromRows } from '../web/views.js'

describe('renderJson', () => {
  it('pretty-prints valid JSON, escaped', () => {
    const html = renderJson('{"name":"<b>x</b>"}')
    html.should.containEql('<pre class="json">')
    html.should.containEql('&lt;b&gt;x&lt;/b&gt;')
    html.should.not.containEql('<b>')
  })

  it('shows raw content with a notice when parsing fails', () => {
    const html = renderJson('not <json>')
    html.should.containEql('not valid JSON')
    html.should.containEql('not &lt;json&gt;')
  })
})

describe('renderContent', () => {
  it('dispatches on metadata.type', () => {
    renderContent({ content: '# Hi', metadata: {} }).should.equal('<h1>Hi</h1>')
    renderContent({ content: '{"a":1}', metadata: { type: 'json' } })
      .should.containEql('<pre class="json">')
    // Rows are records now; a retired table type reads as markdown.
    renderContent({ content: 'rows', metadata: { type: 'table' } }).should.equal('<p>rows</p>')
  })

  it('treats unknown types and missing metadata as markdown', () => {
    renderContent({ content: '**b**', metadata: { type: 'mystery' } })
      .should.containEql('<strong>b</strong>')
    renderContent({ content: '**b**' }).should.containEql('<strong>b</strong>')
  })
})

describe('seriesFromRows', () => {
  const records = [
    { requests: 10, errors: 1, region: 'us', _ts: '2026-01-01T00:00:00.000Z', _v: 1 },
    { requests: 20, _ts: '2026-01-02T00:00:00.000Z', _v: 1 },
    { requests: 30, errors: 3, _ts: '2026-01-03T00:00:00.000Z', _v: 1 }
  ]

  it('converts _ts stamps to epoch seconds', () => {
    const { ts } = seriesFromRows(records)
    ts.should.deepEqual([1767225600, 1767312000, 1767398400])
  })

  it('collects numeric fields with null gaps, skipping non-numeric ones and stamps', () => {
    const { series } = seriesFromRows(records)
    Object.keys(series).should.deepEqual(['requests', 'errors'])
    series.requests.should.deepEqual([10, 20, 30])
    series.errors.should.deepEqual([1, null, 3])
  })

  it('honors renderConfig.fields and never charts a stamp', () => {
    const { series } = seriesFromRows(records, { fields: ['errors'] })
    Object.keys(series).should.deepEqual(['errors'])
    const stamps = seriesFromRows(records, { fields: ['_v'] })
    Object.keys(stamps.series).should.deepEqual([])
  })

  it('returns no series for records without numeric fields', () => {
    const { ts, series } = seriesFromRows([
      { note: 'text', _ts: '2026-01-01T00:00:00.000Z' }
    ])
    ts.length.should.equal(1)
    Object.keys(series).should.deepEqual([])
  })
})
