import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const binPath = fileURLToPath(new URL('../node_modules/.bin/dynoxide', import.meta.url))

let tableCounter = 0

/**
 * A fresh table name per fixture, so tests sharing one dynoxide
 * process cannot see each other's records.
 */
export function uniqueTable () {
  tableCounter += 1
  return `records_test_${process.pid}_${tableCounter}`
}

/**
 * Boot an in-memory dynoxide server for a test file. Returns its
 * endpoint and a stop function; boot is ~15ms, so a server per file
 * costs nothing.
 */
export async function startDynoxide () {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const port = 20000 + Math.floor(Math.random() * 20000)
    const child = spawn(binPath, ['serve', '--port', String(port)], { stdio: 'ignore' })
    const endpoint = `http://127.0.0.1:${port}`
    const deadline = Date.now() + 5000
    while (Date.now() < deadline) {
      if (child.exitCode !== null) break // port taken; try another
      try {
        const response = await fetch(endpoint)
        if (response.status === 200) {
          return {
            endpoint,
            stop () {
              child.kill('SIGKILL')
            }
          }
        }
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 25))
      }
    }
    child.kill('SIGKILL')
  }
  throw new Error('could not start dynoxide for tests')
}
