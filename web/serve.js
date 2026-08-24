#!/usr/bin/env node
/**
 * Static development server for the wiki web UI.
 *
 * Serves the browser app and exposes the SDK (and the shared markdown
 * renderer) as browser modules. All wiki data flows through the SDK to
 * the API; this server never touches the database.
 *
 *   WEB_PORT  listen port (default 3001)
 */

import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const webDir = fileURLToPath(new URL('.', import.meta.url))
const publicDir = path.join(webDir, 'public')
const sdkDir = fileURLToPath(new URL('../lib/sdk', import.meta.url))

const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml'
}

// Shared browser modules that live in web/ itself (outside public/).
const webModules = ['markdown.js', 'views.js']

function resolveFile (urlPath) {
  if (urlPath.startsWith('/sdk/')) {
    return path.join(sdkDir, path.normalize(urlPath.slice(5)))
  }
  if (webModules.includes(urlPath.slice(1))) {
    return path.join(webDir, urlPath.slice(1))
  }
  const file = urlPath === '/' ? '/index.html' : urlPath
  return path.join(publicDir, path.normalize(file))
}

const roots = [publicDir, sdkDir]

const server = http.createServer((request, response) => {
  const urlPath = new URL(request.url, 'http://localhost').pathname
  const file = resolveFile(urlPath)
  const allowed = roots.some((root) => file.startsWith(root + path.sep)) ||
    webModules.some((name) => file === path.join(webDir, name))
  if (!allowed) {
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
  console.log(`wiki web ui on http://localhost:${port}`)
})
