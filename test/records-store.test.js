import should from 'should'
import { createServer } from 'node:http'
import { openRecordStore } from '../lib/api/index.js'

// dynoxide is always consistent and ignores ConsistentRead, so the
// record tests cannot see whether reads ask for it. This captures the
// requests the store sends, as AWS would receive them.
describe('record store requests', () => {
  let server
  let endpoint
  const requests = []

  before(async () => {
    server = createServer((req, res) => {
      let body = ''
      req.on('data', (chunk) => { body += chunk })
      req.on('end', () => {
        const action = String(req.headers['x-amz-target']).split('.').pop()
        requests.push({ action, body: JSON.parse(body) })
        res.setHeader('content-type', 'application/x-amz-json-1.0')
        res.end(JSON.stringify(action === 'Query' ? { Items: [], Count: 0, ScannedCount: 0 } : {}))
      })
    })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    endpoint = `http://127.0.0.1:${server.address().port}`
  })

  after(() => {
    server.close()
  })

  beforeEach(() => {
    requests.length = 0
  })

  it('reads one item consistently', async () => {
    const store = openRecordStore({ endpoint, table: 'records' })
    should(await store.get('wiki_1', 'node_1#k')).equal(null)
    requests.map((r) => r.action).should.deepEqual(['GetItem'])
    requests[0].body.ConsistentRead.should.equal(true)
  })

  it('reads a range from the start without an empty key value, which AWS refuses', async () => {
    const store = openRecordStore({ endpoint, table: 'records' })
    await store.query({ pk: 'wiki_1', from: '', to: '￿' })
    const { KeyConditionExpression, ExpressionAttributeValues } = requests[0].body
    KeyConditionExpression.should.equal('pk = :pk AND sk <= :to')
    Object.values(ExpressionAttributeValues).forEach((value) => value.S.should.not.equal(''))
  })

  it('reads a bounded range between its ends', async () => {
    const store = openRecordStore({ endpoint, table: 'records' })
    await store.query({ pk: 'wiki_1', from: 'node_1#', to: 'node_1#￿' })
    requests[0].body.KeyConditionExpression.should.equal('pk = :pk AND sk BETWEEN :from AND :to')
    requests[0].body.ExpressionAttributeValues[':from'].S.should.equal('node_1#')
  })

  it('queries a range consistently', async () => {
    const store = openRecordStore({ endpoint, table: 'records' })
    const page = await store.query({ pk: 'wiki_1', from: '', to: '￿', limit: 10 })
    page.items.should.deepEqual([])
    requests.map((r) => r.action).should.deepEqual(['Query'])
    requests[0].body.ConsistentRead.should.equal(true)
  })
})
