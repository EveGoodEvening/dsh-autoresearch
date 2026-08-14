import { writeFile } from 'node:fs/promises'

const marker = process.argv[2]
if (!marker) throw new Error('missing evaluator marker path')
await writeFile(marker, `${process.pid}\n`)
setInterval(() => {}, 1_000)
await new Promise(() => {})
