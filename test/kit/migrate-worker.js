// One contender in the concurrent-migration test: open the shared file,
// wait at the barrier until every contender has opened it, migrate.
import { workerData, parentPort } from 'node:worker_threads'
import { openDatabase } from '../../lib/api/db.js'
import { migrate } from '../../lib/kit/schema.js'

const { file, barrier, contenders } = workerData
const gate = new Int32Array(barrier)
try {
  const db = openDatabase(file)
  Atomics.add(gate, 0, 1)
  while (Atomics.load(gate, 0) < contenders) Atomics.wait(gate, 0, Atomics.load(gate, 0), 5)
  migrate(db)
  db.close()
  parentPort.postMessage({ ok: true })
} catch (error) {
  Atomics.add(gate, 0, contenders) // release the others rather than hang them
  parentPort.postMessage({ ok: false, message: error.message + " @ " + error.stack.split("\n").slice(1,4).join(" | ") })
}
