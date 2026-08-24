import should from 'should'
import { renderJson, renderTable, renderContent, seriesFromRows } from '../web/views.js'

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

describe('renderTable', () => {
  it('renders an array of objects with columns in first-appearance order', () => {
    const html = renderTable(JSON.stringify([
      { date: '2026-01-01', requests: 10 },
      { date: '2026-01-02', errors: 1 }
    ]))
    html.should.containEql('<table class="data-table">')
    html.indexOf('<th>date</th>').should.be.below(html.indexOf('<th>requests</th>'))
    html.indexOf('<th>requests</th>').should.be.below(html.indexOf('<th>errors</th>'))
    html.should.containEql('<td>2026-01-01</td>')
    html.should.containEql('<td>10</td>')
    html.should.containEql('<td></td>') // missing cells render empty
  })

  it('escapes cell content and stringifies nested values', () => {
    const html = renderTable(JSON.stringify([{ note: '<script>', tags: ['a'] }]))
    html.should.containEql('&lt;script&gt;')
    html.should.not.containEql('<script>')
    html.should.containEql('[&quot;a&quot;]')
  })

  it('falls back to JSON with a notice for non-tabular values', () => {
    renderTable('{"not":"an array"}').should.containEql('array of objects')
    renderTable('[]').should.containEql('array of objects')
    renderTable('[1,2]').should.containEql('array of objects')
  })

  it('falls back to the raw-content notice when parsing fails', () => {
    renderTable('nope').should.containEql('not valid JSON')
  })
})

describe('renderContent', () => {
  it('dispatches on metadata.type', () => {
    renderContent({ content: '# Hi', metadata: {} }).should.equal('<h1>Hi</h1>')
    renderContent({ content: '{"a":1}', metadata: { type: 'json' } })
      .should.containEql('<pre class="json">')
    renderContent({ content: '[{"a":1}]', metadata: { type: 'table' } })
      .should.containEql('<table class="data-table">')
  })

  it('treats unknown types and missing metadata as markdown', () => {
    renderContent({ content: '**b**', metadata: { type: 'mystery' } })
      .should.containEql('<strong>b</strong>')
    renderContent({ content: '**b**' }).should.containEql('<strong>b</strong>')
  })
})

describe('seriesFromRows', () => {
  const rows = [
    { ts: '2026-01-01T00:00:00.000Z', payload: { requests: 10, errors: 1, region: 'us' } },
    { ts: '2026-01-02T00:00:00.000Z', payload: { requests: 20 } },
    { ts: '2026-01-03T00:00:00.000Z', payload: { requests: 30, errors: 3 } }
  ]

  it('converts timestamps to epoch seconds', () => {
    const { ts } = seriesFromRows(rows)
    ts.should.deepEqual([1767225600, 1767312000, 1767398400])
  })

  it('collects numeric fields with null gaps, skipping non-numeric ones', () => {
    const { series } = seriesFromRows(rows)
    Object.keys(series).should.deepEqual(['requests', 'errors'])
    series.requests.should.deepEqual([10, 20, 30])
    series.errors.should.deepEqual([1, null, 3])
  })

  it('honors renderConfig.fields', () => {
    const { series } = seriesFromRows(rows, { fields: ['errors'] })
    Object.keys(series).should.deepEqual(['errors'])
  })

  it('charts bare numeric payloads as "value"', () => {
    const { series } = seriesFromRows([
      { ts: '2026-01-01T00:00:00.000Z', payload: 5 },
      { ts: '2026-01-02T00:00:00.000Z', payload: 7 }
    ])
    series.value.should.deepEqual([5, 7])
  })

  it('returns no series for non-numeric payloads', () => {
    const { ts, series } = seriesFromRows([
      { ts: '2026-01-01T00:00:00.000Z', payload: 'text' }
    ])
    ts.length.should.equal(1)
    Object.keys(series).should.deepEqual([])
  })
})
