import should from 'should'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Architectural boundary enforcement.
 *
 * As a single library there is no package manager isolating the
 * layers, so this test is the guardian of the dependency direction:
 *
 *   cli -> sdk          web -> sdk
 *   api -> kit          kit -> (nothing)
 *
 * SQL stays in kit; express stays in api; better-sqlite3 never appears
 * in lib at all (the connection is injected; only the api's openDatabase
 * helper may load it).
 */

const root = fileURLToPath(new URL('..', import.meta.url))

function sourceFiles (dir) {
  const absolute = path.join(root, dir)
  return fs.readdirSync(absolute, { recursive: true })
    .filter((file) => file.endsWith('.js'))
    // Vendored third-party bundles (web/public/vendor) are not our
    // source; the regex scans here are not written for minified code.
    .filter((file) => !file.split(path.sep).includes('vendor'))
    .map((file) => path.join(absolute, file))
}

function importsOf (file) {
  // Strip comments first so JSDoc type imports like
  // {import('better-sqlite3').Database} do not count as dependencies.
  const source = fs.readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|\n)\s*\/\/[^\n]*/g, '$1')
  const statements = [
    ...source.matchAll(/(?:^|\n)\s*import[\s\S]*?from\s+['"]([^'"]+)['"]/g),
    ...source.matchAll(/import\(\s*['"]([^'"]+)['"]\s*\)/g),
    ...source.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)
  ]
  return statements.map((match) => match[1])
}

/**
 * Resolve a relative import to the lib layer ("kit" | "api" | "sdk" |
 * "cli") it lands in, or null for anything outside lib.
 */
function layerOf (fromFile, specifier) {
  // Browser modules import by served URL: /sdk/* maps to the sdk
  // layer, anything else absolute is web-internal.
  if (specifier.startsWith('/')) {
    return specifier.startsWith('/sdk/') ? 'sdk' : 'web'
  }
  if (!specifier.startsWith('.')) return null
  const resolved = path.resolve(path.dirname(fromFile), specifier)
  const relative = path.relative(path.join(root, 'lib'), resolved)
  if (relative.startsWith('..')) return null
  return relative.split(path.sep)[0]
}

function assertLayer (dir, ownLayer, { allowedLayers, allowedPackages }) {
  for (const file of sourceFiles(dir)) {
    for (const specifier of importsOf(file)) {
      const name = path.relative(root, file)
      if (specifier.startsWith('node:')) continue
      if (specifier.startsWith('.') || specifier.startsWith('/')) {
        const layer = layerOf(file, specifier)
        if (layer === null || layer === ownLayer) continue
        allowedLayers.should.containEql(
          layer,
          `${name} imports across the ${ownLayer} -> ${layer} boundary (${specifier})`
        )
      } else {
        allowedPackages.should.containEql(
          specifier,
          `${name} imports disallowed package ${specifier}`
        )
      }
    }
  }
}

describe('architectural boundaries', () => {
  it('kit imports nothing outside itself', () => {
    assertLayer('lib/kit', 'kit', { allowedLayers: [], allowedPackages: [] })
  })

  it('sdk imports nothing outside itself (environment-neutral)', () => {
    assertLayer('lib/sdk', 'sdk', { allowedLayers: [], allowedPackages: [] })
  })

  it('cli imports only the sdk', () => {
    assertLayer('lib/cli', 'cli', { allowedLayers: ['sdk'], allowedPackages: [] })
  })

  it('api imports only the kit, express, and the storage drivers', () => {
    assertLayer('lib/api', 'api', {
      allowedLayers: ['kit'],
      allowedPackages: [
        'express', 'better-sqlite3',
        '@aws-sdk/client-dynamodb', '@aws-sdk/lib-dynamodb', 'ajv'
      ]
    })
  })

  it('web never touches kit or api', () => {
    assertLayer('web', 'web', { allowedLayers: ['sdk'], allowedPackages: [] })
  })

  it('SQL statements stay inside kit', () => {
    for (const dir of ['lib/api', 'lib/sdk', 'lib/cli', 'web']) {
      for (const file of sourceFiles(dir)) {
        const source = fs.readFileSync(file, 'utf8')
        should(/\b(SELECT\s+\*|INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM)\b/.test(source))
          .be.false(`${path.relative(root, file)} contains SQL`)
      }
    }
  })
})
