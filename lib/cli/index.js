/**
 * wiki-cli — the `wiki` executable.
 *
 * Talks to the wiki API exclusively through wiki-sdk. Never
 * touches the database or wiki-kit.
 */

import fs from 'node:fs'
import { parseArgs } from 'node:util'
import {
  WikiClient,
  splitAddress,
  ValidationError,
  NotFoundError,
  AlreadyExistsError,
  RevisionConflictError,
  EditMismatchError,
  NonEmptyNodeError,
  CrossWikiMoveError,
  InvalidMoveError,
  UnauthenticatedError,
  UnauthorizedError
} from '../sdk/index.js'
import { commands, globalOptions, exitCodes } from './commands.js'
import {
  renderTree,
  renderSearchResults,
  renderHistory,
  renderChanges,
  renderRecords,
  renderDiff,
  renderVersions,
  renderVersionDiff,
  renderLinks
} from './render.js'

export { commands, globalOptions, exitCodes }

class UsageError extends Error {}

function exitCodeFor (error) {
  if (error instanceof UsageError) return exitCodes.invalidArguments
  if (error instanceof ValidationError) return exitCodes.invalidArguments
  if (error instanceof InvalidMoveError) return exitCodes.invalidArguments
  if (error instanceof CrossWikiMoveError) return exitCodes.invalidArguments
  if (error instanceof EditMismatchError) return exitCodes.invalidArguments
  if (error instanceof NotFoundError) return exitCodes.notFound
  if (error instanceof RevisionConflictError) return exitCodes.conflict
  if (error instanceof AlreadyExistsError) return exitCodes.conflict
  if (error instanceof NonEmptyNodeError) return exitCodes.conflict
  if (error instanceof UnauthenticatedError) return exitCodes.unauthenticated
  if (error instanceof UnauthorizedError) return exitCodes.unauthorized
  return exitCodes.failure
}

function helpText () {
  const lines = ['usage: wiki <command> [options]', '', 'commands:']
  for (const definition of Object.values(commands)) {
    lines.push(`  ${definition.usage.replace(/^wiki /, '').padEnd(26)}${definition.summary}`)
  }
  lines.push('')
  lines.push('global options:')
  for (const [name, option] of Object.entries(globalOptions)) {
    lines.push(`  --${name.padEnd(12)}${option.description}`)
  }
  lines.push('')
  lines.push('environment: WIKI_URL, WIKI_TOKEN')
  return lines.join('\n')
}

function commandHelpText (name) {
  const definition = commands[name]
  const lines = [`usage: ${definition.usage}`, '', definition.summary, '']
  const options = { ...definition.options, ...globalOptions }
  lines.push('options:')
  for (const [option, spec] of Object.entries(options)) {
    lines.push(`  --${option.padEnd(14)}${spec.description}`)
  }
  lines.push('')
  lines.push('examples:')
  for (const example of definition.examples) lines.push(`  ${example}`)
  return lines.join('\n')
}

async function readStdin () {
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8')
}

function parseIntOption (value, name) {
  if (value === undefined) return undefined
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new UsageError(`--${name} must be a positive integer`)
  }
  return parsed
}

function historicalOptions (values) {
  if (values.change !== undefined && values.at !== undefined) {
    throw new UsageError('--change and --at are mutually exclusive')
  }
  return { changeId: parseIntOption(values.change, 'change'), at: values.at }
}

// A record's address: its page, a slash, its key.
function recordAddress (address, usage) {
  const { path, key } = splitAddress(address ?? '')
  if (!path || !key) throw new UsageError(`usage: ${usage}`)
  return { path, key }
}

/**
 * @param {string[]} argv arguments after the command name
 * @returns {Promise<number>} exit code
 */
export async function main (argv) {
  const out = (text) => process.stdout.write(text.endsWith('\n') || text === '' ? text : text + '\n')
  const err = (text) => process.stderr.write(text + '\n')

  let commandName = argv[0]
  if (!commandName || commandName === 'help' || commandName === '--help' || commandName === '-h') {
    out(helpText())
    return commandName ? exitCodes.success : exitCodes.invalidArguments
  }
  const definition = commands[commandName]
  if (!definition) {
    err(`wiki: unknown command: ${commandName}`)
    err("run 'wiki help' for usage")
    return exitCodes.invalidArguments
  }

  let values, positionals
  try {
    ({ values, positionals } = parseArgs({
      args: argv.slice(1),
      options: { ...definition.options, ...globalOptions },
      allowPositionals: true
    }))
  } catch (error) {
    err(`wiki: ${error.message}`)
    return exitCodes.invalidArguments
  }

  if (values.help) {
    out(commandHelpText(commandName))
    return exitCodes.success
  }

  const baseUrl = values.url || process.env.WIKI_URL
  const token = values.token || process.env.WIKI_TOKEN
  if (!baseUrl) {
    err('wiki: no API URL configured (set WIKI_URL or pass --url)')
    return exitCodes.invalidArguments
  }
  const client = new WikiClient({ baseUrl, token })
  const json = !!values.json

  try {
    switch (commandName) {
      case 'read': {
        const [path] = positionals
        if (!path || positionals.length !== 1) throw new UsageError('usage: wiki read <path>')
        if (splitAddress(path).key) throw new UsageError('that is a record; read it with wiki get <path>/<key>')
        const node = await client.read(path, historicalOptions(values))
        if (json) out(JSON.stringify(node, null, 2))
        else out(node.content)
        break
      }

      case 'write': {
        const [path, inline] = positionals
        if (!path || positionals.length > 2) throw new UsageError('usage: wiki write <path> [content]')
        const sources = []
        if (inline !== undefined) sources.push('argument')
        if (values.file !== undefined) sources.push('--file')
        if (sources.length > 1) {
          throw new UsageError(`use exactly one content source (got ${sources.join(' and ')})`)
        }
        let content
        if (inline !== undefined) content = inline
        else if (values.file !== undefined) {
          try {
            content = fs.readFileSync(values.file, 'utf8')
          } catch (error) {
            throw new UsageError(`cannot read --file ${values.file}: ${error.message}`)
          }
        } else if (!process.stdin.isTTY) {
          content = await readStdin()
        }
        if (content === undefined) {
          throw new UsageError('no content supplied (inline argument, stdin, or --file)')
        }
        let metadata
        if (values.metadata !== undefined) {
          try {
            metadata = JSON.parse(values.metadata)
          } catch {
            throw new UsageError('--metadata must be valid JSON')
          }
          if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata)) {
            throw new UsageError('--metadata must be a JSON object')
          }
        }
        const result = await client.write(path, {
          content,
          title: values.title,
          metadata,
          ifRevision: values['if-revision'],
          message: values.message
        })
        if (json) out(JSON.stringify(result, null, 2))
        else if (result.created) err(`created ${result.node.fullPath} (revision ${result.node.revisionId})`)
        else if (result.changed) err(`updated ${result.node.fullPath} (revision ${result.node.revisionId})`)
        else err(`no changes to ${result.node.fullPath}`)
        break
      }

      case 'edit': {
        const [path] = positionals
        if (!path || positionals.length !== 1 || values.old === undefined || values.new === undefined) {
          throw new UsageError('usage: wiki edit <path> --old <text> --new <text>')
        }
        const result = await client.edit(path, values.old, values.new, {
          replaceAll: !!values.all,
          ifRevision: values['if-revision'],
          message: values.message
        })
        if (json) out(JSON.stringify(result, null, 2))
        else err(`edited ${result.node.fullPath}: ${result.replaced} replaced (revision ${result.node.revisionId})`)
        break
      }

      case 'tree': {
        const [path] = positionals
        if (!path || positionals.length !== 1) throw new UsageError('usage: wiki tree <path>')
        const tree = await client.tree(path, {
          depth: parseIntOption(values.depth, 'depth'),
          ...historicalOptions(values)
        })
        if (json) out(JSON.stringify(tree, null, 2))
        else out(renderTree(tree))
        break
      }

      case 'search': {
        const [path, query] = positionals
        if (!path || !query || positionals.length !== 2) {
          throw new UsageError('usage: wiki search <path> <query>')
        }
        const results = await client.search(path, query, {
          limit: parseIntOption(values.limit, 'limit')
        })
        if (json) out(JSON.stringify(results, null, 2))
        else out(renderSearchResults(results))
        break
      }

      case 'history': {
        const [address] = positionals
        if (!address || positionals.length !== 1) throw new UsageError('usage: wiki history <path>[/<key>]')
        const { path, key } = splitAddress(address)
        if (key) {
          const result = await client.history(path, {
            key,
            limit: parseIntOption(values.limit, 'limit'),
            cursor: values.cursor
          })
          if (json) out(JSON.stringify(result, null, 2))
          else {
            out(renderVersions(result))
            if (result.cursor) err(`more versions: --cursor ${result.cursor}`)
          }
          break
        }
        if (values.cursor !== undefined) throw new UsageError('--cursor applies to a record’s versions')
        const history = await client.history(path, {
          limit: parseIntOption(values.limit, 'limit')
        })
        if (json) out(JSON.stringify(history, null, 2))
        else out(renderHistory(history))
        break
      }

      case 'diff': {
        const [address] = positionals
        if (!address || positionals.length !== 1) throw new UsageError('usage: wiki diff <path>[/<key>]')
        const { path, key } = splitAddress(address)
        if (key) {
          if (values.revision || values.change) throw new UsageError('a row’s versions take --version, not --revision or --change')
          // A version is addressed by number; nothing names the latest.
          let version = parseIntOption(values.version, 'version')
          if (version === undefined) {
            const { versions } = await client.history(path, { key, limit: 1 })
            version = versions[0]._v
          }
          const result = await client.getVersion(path, key, version)
          if (json) out(JSON.stringify(result, null, 2))
          else out(renderVersionDiff(result))
          break
        }
        if (values.version !== undefined) throw new UsageError('--version applies to a record: <path>/<key>')
        if (values.revision && values.change) throw new UsageError('--revision and --change are exclusive')
        // A revision is addressed by id; a change (or nothing: the
        // latest) names it through the page as it was there.
        let revisionId = values.revision
        if (!revisionId) {
          const node = await client.read(path, { changeId: parseIntOption(values.change, 'change') })
          revisionId = node.revisionId
        }
        const revision = await client.getRevision(path.split('.')[0], revisionId)
        if (json) out(JSON.stringify(revision, null, 2))
        else out(renderDiff(revision))
        break
      }

      case 'links': {
        const [address] = positionals
        if (!address || positionals.length !== 1) throw new UsageError('usage: wiki links <path>[/<key>]')
        const { path, key } = splitAddress(address)
        const result = await client.links(path, {
          key: key ?? undefined,
          limit: parseIntOption(values.limit, 'limit')
        })
        if (json) out(JSON.stringify(result, null, 2))
        else out(renderLinks(result))
        break
      }

      case 'changes': {
        const [path] = positionals
        if (!path || positionals.length !== 1) throw new UsageError('usage: wiki changes <path>')
        const changes = await client.changes(path, {
          limit: parseIntOption(values.limit, 'limit'),
          before: parseIntOption(values.before, 'before')
        })
        if (json) out(JSON.stringify(changes, null, 2))
        else out(renderChanges(changes))
        break
      }

      case 'move': {
        const [from, to] = positionals
        if (!from || !to || positionals.length !== 2) {
          throw new UsageError('usage: wiki move <from> <to>')
        }
        const node = await client.move(from, to, {
          ifRevision: values['if-revision'],
          message: values.message
        })
        if (json) out(JSON.stringify(node, null, 2))
        else err(`moved ${from} -> ${node.fullPath}`)
        break
      }

      case 'rm': {
        const [path] = positionals
        if (!path || positionals.length !== 1) throw new UsageError('usage: wiki rm <path>')
        const result = await client.remove(path, {
          recursive: !!values.recursive,
          ifRevision: values['if-revision'],
          ifChange: parseIntOption(values['if-change'], 'if-change'),
          message: values.message
        })
        if (json) out(JSON.stringify(result, null, 2))
        else err(`deleted ${result.deletedPaths.join(', ')} (change ${result.changeId})`)
        break
      }

      case 'meta': {
        const [path, inline] = positionals
        if (!path || positionals.length > 2) throw new UsageError('usage: wiki meta <path> [json]')
        // Inline argument wins over piped stdin, mirroring `write`.
        let raw
        if (inline !== undefined) raw = inline
        else if (!process.stdin.isTTY) raw = await readStdin()
        if (raw === undefined || raw.trim() === '') {
          throw new UsageError('no metadata supplied (inline argument or stdin)')
        }
        let metadata
        try {
          metadata = JSON.parse(raw)
        } catch {
          throw new UsageError('metadata must be valid JSON')
        }
        if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata)) {
          throw new UsageError('metadata must be a JSON object')
        }
        const result = await client.updateMeta(path, metadata, {
          replace: !!values.replace,
          ifRevision: values['if-revision'],
          message: values.message
        })
        if (json) out(JSON.stringify(result, null, 2))
        else if (result.changed) err(`updated ${result.node.fullPath} (revision ${result.node.revisionId})`)
        else err(`no changes to ${result.node.fullPath}`)
        break
      }

      case 'set': {
        const [path, inline] = positionals
        if (!path || positionals.length > 2) throw new UsageError('usage: wiki set <path> [json]')
        let raw
        if (inline !== undefined) raw = inline
        else if (!process.stdin.isTTY) raw = await readStdin()
        if (raw === undefined || raw.trim() === '') {
          throw new UsageError('no record supplied (inline argument or stdin)')
        }
        let value
        try {
          value = JSON.parse(raw)
        } catch {
          throw new UsageError('record must be valid JSON')
        }
        const result = await client.set(path, value, {
          ts: values.ts,
          ifVersion: parseIntOption(values['if-version'], 'if-version')
        })
        if (json) out(JSON.stringify(result, null, 2))
        else err(`set ${result.fullPath} ${result.record._id} (version ${result.record._v})`)
        break
      }

      case 'get': {
        if (positionals.length !== 1) throw new UsageError('usage: wiki get <path>/<key>')
        const { path, key } = recordAddress(positionals[0], 'wiki get <path>/<key> (a page is read with wiki read)')
        const result = await client.get(path, key)
        if (json) out(JSON.stringify(result, null, 2))
        else out(JSON.stringify(result.record, null, 2))
        break
      }

      case 'del': {
        if (positionals.length !== 1) throw new UsageError('usage: wiki del <path>/<key>')
        const { path, key } = recordAddress(positionals[0], 'wiki del <path>/<key> (a page is deleted with wiki rm)')
        const result = await client.del(path, key)
        if (json) out(JSON.stringify(result, null, 2))
        else err(`deleted ${result.record._id} from ${result.fullPath}`)
        break
      }

      case 'records': {
        const [path] = positionals
        if (!path || positionals.length !== 1) throw new UsageError('usage: wiki records <path>')
        if (splitAddress(path).key) throw new UsageError('one record is read with wiki get <path>/<key>')
        const result = await client.records(path, {
          latest: !!values.latest,
          reverse: !!values.reverse,
          since: values.since,
          until: values.until,
          limit: parseIntOption(values.limit, 'limit'),
          cursor: values.cursor,
          at: values.at
        })
        if (json) out(JSON.stringify(result, null, 2))
        else {
          out(renderRecords(result.records))
          if (result.unknown?.length) err(`not kept at ${result.at}: ${result.unknown.join(', ')}`)
          if (result.cursor) err(`more records: --cursor ${result.cursor}`)
        }
        break
      }
    }
    return exitCodes.success
  } catch (error) {
    err(`wiki: ${error.message}`)
    return exitCodeFor(error)
  }
}
