import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'

const marker = process.env.AUTORESEARCH_MARKER
if (!marker) throw new Error('AUTORESEARCH_MARKER is required')
const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: false, stdio: 'ignore' })
writeFileSync(marker, JSON.stringify({ parent: process.pid, descendant: child.pid }))
setInterval(() => {}, 1000)
