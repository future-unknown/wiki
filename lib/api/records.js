/**
 * Record-store connection helper. The application owns the store and
 * injects it into wiki-kit, exactly as it injects the database
 * connection: the kit owns the record semantics, this module owns the
 * infrastructure (the DynamoDB-API client and the schema compiler).
 *
 * The store speaks the DynamoDB API and nothing more, so the same
 * configuration works against a local dynoxide sidecar and against
 * AWS — only the endpoint changes.
 */

import { DynamoDBClient, CreateTableCommand, DescribeTableCommand, UpdateTimeToLiveCommand } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient, PutCommand, GetCommand, DeleteCommand, QueryCommand } from '@aws-sdk/lib-dynamodb'
import { Ajv } from 'ajv'

const SCHEMA_CACHE_LIMIT = 200

/**
 * @param {object} options
 * @param {string} options.endpoint DynamoDB endpoint URL (dynoxide or AWS)
 * @param {string} [options.table] table name (default 'records')
 * @param {string} [options.region] AWS region (default 'local')
 * @param {{ accessKeyId: string, secretAccessKey: string }} [options.credentials]
 *   credentials; local emulators accept any value (default 'wiki'/'wiki')
 */
export function openRecordStore ({ endpoint, table = 'records', region = 'local', credentials } = {}) {
  if (!endpoint) throw new Error('records endpoint is required')
  const client = DynamoDBDocumentClient.from(
    new DynamoDBClient({
      endpoint,
      region,
      credentials: credentials ?? { accessKeyId: 'wiki', secretAccessKey: 'wiki' }
    }),
    { marshallOptions: { removeUndefinedValues: true } }
  )

  const ajv = new Ajv({ strict: false, allErrors: false })
  const compiled = new Map()

  function conditionFailed (error) {
    return error?.name === 'ConditionalCheckFailedException'
  }

  return {
    table,

    /**
     * Ensure the table exists (pk/sk, on-demand) with TTL enabled on
     * `_expires`. Idempotent.
     */
    async migrate () {
      try {
        await client.send(new DescribeTableCommand({ TableName: table }))
      } catch (error) {
        if (error?.name !== 'ResourceNotFoundException') throw error
        await client.send(new CreateTableCommand({
          TableName: table,
          AttributeDefinitions: [
            { AttributeName: 'pk', AttributeType: 'S' },
            { AttributeName: 'sk', AttributeType: 'S' }
          ],
          KeySchema: [
            { AttributeName: 'pk', KeyType: 'HASH' },
            { AttributeName: 'sk', KeyType: 'RANGE' }
          ],
          BillingMode: 'PAY_PER_REQUEST'
        }))
      }
      try {
        await client.send(new UpdateTimeToLiveCommand({
          TableName: table,
          TimeToLiveSpecification: { AttributeName: '_expires', Enabled: true }
        }))
      } catch (error) {
        // Already enabled reads as a validation refusal; that is fine.
        if (error?.name !== 'ValidationException') throw error
      }
    },

    /**
     * Write one item. `condition`/`names`/`values` pass through as the
     * DynamoDB condition expression. A failed condition throws an error
     * with `conditionFailed: true` for the kit to interpret.
     */
    async put ({ item, condition, names, values }) {
      try {
        await client.send(new PutCommand({
          TableName: table,
          Item: item,
          ...(condition ? { ConditionExpression: condition } : {}),
          ...(names ? { ExpressionAttributeNames: names } : {}),
          ...(values ? { ExpressionAttributeValues: values } : {})
        }))
      } catch (error) {
        if (conditionFailed(error)) {
          const failed = new Error('condition failed')
          failed.conditionFailed = true
          throw failed
        }
        throw error
      }
    },

    /** One item by full key, or null. */
    async get (pk, sk) {
      const result = await client.send(new GetCommand({ TableName: table, Key: { pk, sk } }))
      return result.Item ?? null
    },

    /** Delete one item; returns the old item, or null if absent. */
    async delete (pk, sk) {
      const result = await client.send(new DeleteCommand({
        TableName: table,
        Key: { pk, sk },
        ReturnValues: 'ALL_OLD'
      }))
      return result.Attributes ?? null
    },

    /**
     * One page of items in a partition's sort-key range [from, to],
     * ascending unless `descending`. Returns the continuation key when
     * more items remain.
     *
     * @returns {Promise<{ items: object[], next: object|undefined }>}
     */
    async query ({ pk, from, to, limit, cursor, descending }) {
      const result = await client.send(new QueryCommand({
        TableName: table,
        KeyConditionExpression: 'pk = :pk AND sk BETWEEN :from AND :to',
        ExpressionAttributeValues: { ':pk': pk, ':from': from, ':to': to },
        ...(limit !== undefined ? { Limit: limit } : {}),
        ...(cursor !== undefined ? { ExclusiveStartKey: cursor } : {}),
        ...(descending ? { ScanIndexForward: false } : {})
      }))
      return { items: result.Items ?? [], next: result.LastEvaluatedKey }
    },

    /**
     * Compile a JSON Schema to a validator. Returns
     * `(value) => null | string` (an error message on failure). Throws
     * an error with `invalidSchema: true` when the schema itself does
     * not compile.
     */
    compileSchema (schema) {
      const cacheKey = JSON.stringify(schema)
      if (compiled.has(cacheKey)) return compiled.get(cacheKey)
      let validate
      try {
        validate = ajv.compile(schema)
      } catch (error) {
        const failed = new Error(`invalid schema: ${error.message}`)
        failed.invalidSchema = true
        throw failed
      }
      const wrapped = (value) => {
        if (validate(value)) return null
        const first = validate.errors?.[0]
        if (!first) return 'value does not match the schema'
        const where = first.instancePath ? `${first.instancePath} ` : ''
        return `${where}${first.message}`
      }
      if (compiled.size >= SCHEMA_CACHE_LIMIT) {
        compiled.delete(compiled.keys().next().value)
      }
      compiled.set(cacheKey, wrapped)
      return wrapped
    }
  }
}
