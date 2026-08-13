#!/usr/bin/env node
/**
 * Static development server for wiki-web.
 *
 * Serves the browser UI and exposes wiki-sdk (and the shared markdown
 * renderer) as browser modules. All wiki data flows through wiki-sdk
 * to the API; this server never touches the database.
 *
 *   WEB_PORT  listen port (default 3001)
 */

import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const publicDir = fileURLToPath(new URL('../public', import.meta.url))
const sdkDir = path.dirname(fileURLToPath(import.meta.resolve('wiki-sdk')))
const libDir = fileURLToPath(new URL('../lib', import.meta.url))

const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml'
}

function resolveFile (urlPath) {
  if (urlPath.startsWith('/sdk/')) {
    return path.join(sdkDir, path.normalize(urlPath.slice(5)))
  }
  if (urlPath.startsWith('/lib/')) {
    return path.join(libDir, path.normalize(urlPath.slice(5)))
  }
  const file = urlPath === '/' ? '/index.html' : urlPath
  return path.join(publicDir, path.normalize(file))
}

const roots = [publicDir, sdkDir, libDir]

const server = http.createServer((request, response) => {
  const urlPath = new URL(request.url, 'http://localhost').pathname
  const file = resolveFile(urlPath)
  if (!roots.some((root) => file.startsWith(root + path.sep))) {
    response.writeHead(403).end('forbidden')
    return
  }
  fs.readFile(file, (error, data) => {
    if (error) {
      response.writeHead(404, { 'content-type': 'text/plain' }).end('not found')
      return
    }
    response.writeHead(200, {
      'content-type': types[path.extname(file)] || 'application/octet-stream'
    }).end(data)
  })
})

const port = Number(process.env.WEB_PORT || 3001)
server.listen(port, () => {
  console.log(`waterfront web ui on http://localhost:${port}`)
})
