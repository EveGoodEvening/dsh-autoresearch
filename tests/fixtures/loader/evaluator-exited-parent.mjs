import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { readFile, rename, writeFile } from 'node:fs/promises'

const marker = process.argv[2]
const score = process.argv[3] === 'always' ? 0 : Number(await readFile('score.txt', 'utf8'))
if (score !== 1) {
  // Stay in the provider's managed group, but do not keep the parent's stdio open.
  const child = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); process.send('ready'); setInterval(() => {}, 1000)"], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] })
  const [message] = await once(child, 'message')
  if (message !== 'ready') throw new Error('descendant readiness protocol failed')
  await writeFile(`${marker}.tmp`, JSON.stringify({ parent: process.pid, child: child.pid, score }))
  await rename(`${marker}.tmp`, marker)
  child.disconnect()
  child.unref()
}
console.log(JSON.stringify({ score }))
