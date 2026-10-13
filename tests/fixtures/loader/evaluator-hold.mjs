import { rename, writeFile } from 'node:fs/promises'

const marker = process.argv[2]
if (!marker) throw new Error('missing evaluator marker path')
const pendingMarker = `${marker}.${process.pid}.tmp`
await writeFile(pendingMarker, `${process.pid}\n`)
await rename(pendingMarker, marker)
setInterval(() => {}, 1_000)
await new Promise(() => {})
