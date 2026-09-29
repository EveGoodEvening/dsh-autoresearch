import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { renameSync, writeFileSync } from 'node:fs'

const marker = process.env.AUTORESEARCH_MARKER
if (!marker) throw new Error('AUTORESEARCH_MARKER is required')
const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: false, stdio: 'ignore' })
await once(child, 'spawn')
const pending = `${marker}.${process.pid}.pending`
writeFileSync(pending, JSON.stringify({ parent: process.pid, descendant: child.pid }))
renameSync(pending, marker)
setInterval(() => {}, 1000)
