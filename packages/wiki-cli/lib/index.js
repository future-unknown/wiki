/**
 * wiki-cli — the `wiki` executable.
 *
 * Talks to the waterfront API exclusively through wiki-sdk. Never
 * touches the database or wiki-kit.
 */

import fs from 'node:fs'
import { parseArgs } from 'node:util'
import {
  WikiClient,
  ValidationError,
  NotFoundError,
  AlreadyExistsError,
  RevisionConflictError,
  NonEmptyNodeError,
  CrossWikiMoveError,
  InvalidMoveError,
  UnauthenticatedError,
  UnauthorizedError
} from 'wiki-sdk'
import { commands, globalOptions, exitCodes } from './commands.js'
import { renderTree, renderSearchResults, renderHistory } from './render.js'

export { commands, globalOptions, exitCodes }

class UsageError extends Error {}

function exitCodeFor (error) {
  if (error instanceof UsageError) return exitCodes.invalidArguments
  if (error instanceof ValidationError) return exitCodes.invalidArguments
  if (error instanceof InvalidMoveError) return exitCodes.invalidArguments
  if (error instanceof CrossWikiMoveError) return exitCodes.invalidArguments
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
  if (values.commit !== undefined && values.at !== undefined) {
    throw new UsageError('--commit and --at are mutually exclusive')
  }
  return { commitId: parseIntOption(values.commit, 'commit'), at: values.at }
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
      case 'get': {
        const [path] = positionals
        if (!path || positionals.length !== 1) throw new UsageError('usage: wiki get <path>')
        const node = await client.get(path, historicalOptions(values))
        if (json) out(JSON.stringify(node, null, 2))
        else out(node.content)
        break
      }

      case 'set': {
        const [path, inline] = positionals
        if (!path || positionals.length > 2) throw new UsageError('usage: wiki set <path> [content]')
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
        const result = await client.set(path, {
          content,
          title: values.title,
          metadata,
          expectedRevisionId: values['if-revision'],
          message: values.message
        })
        if (json) out(JSON.stringify(result, null, 2))
        else if (result.created) err(`created ${result.node.fullPath} (revision ${result.node.revisionId})`)
        else if (result.changed) err(`updated ${result.node.fullPath} (revision ${result.node.revisionId})`)
        else err(`no changes to ${result.node.fullPath}`)
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
        const [path] = positionals
        if (!path || positionals.length !== 1) throw new UsageError('usage: wiki history <path>')
        const history = await client.history(path, {
          limit: parseIntOption(values.limit, 'limit')
        })
        if (json) out(JSON.stringify(history, null, 2))
        else out(renderHistory(history))
        break
      }

      case 'move': {
        const [from, to] = positionals
        if (!from || !to || positionals.length !== 2) {
          throw new UsageError('usage: wiki move <from> <to>')
        }
        const node = await client.move(from, to, {
          expectedRevisionId: values['if-revision'],
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
          expectedRevisionId: values['if-revision'],
          expectedCommitId: parseIntOption(values['if-commit'], 'if-commit'),
          message: values.message
        })
        if (json) out(JSON.stringify(result, null, 2))
        else err(`deleted ${result.deletedPaths.join(', ')} (commit ${result.commitId})`)
        break
      }
    }
    return exitCodes.success
  } catch (error) {
    err(`wiki: ${error.message}`)
    return exitCodeFor(error)
  }
}
