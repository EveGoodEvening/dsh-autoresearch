import { spawn } from 'node:child_process'
import { writeFile } from 'node:fs/promises'

const marker = process.argv[2]
if (!marker) throw new Error('missing evaluator marker path')
const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
await writeFile(marker, JSON.stringify({ parent: process.pid, child: child.pid }))
setInterval(() => {}, 1_000)
await new Promise(() => {})
