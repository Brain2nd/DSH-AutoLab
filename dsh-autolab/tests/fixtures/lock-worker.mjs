import { acquireRuntimeLock } from '../../src/lock.ts'

const [root, mode] = process.argv.slice(2)
if (root === undefined || (mode !== 'hold' && mode !== 'crash')) {
  throw new Error('usage: lock-worker.mjs <root> <hold|crash>')
}

const lock = await acquireRuntimeLock(root)
process.stdout.write(`${JSON.stringify(lock.owner)}\n`)

if (mode === 'crash') {
  process.exit(0)
}

process.stdin.resume()
process.stdin.once('end', async () => {
  await lock.release()
})
