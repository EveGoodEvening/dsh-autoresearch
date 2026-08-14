import { appendFileSync } from 'node:fs'

if (process.env.AUTORESEARCH_SPAWN_LOG) appendFileSync(process.env.AUTORESEARCH_SPAWN_LOG, `${process.pid}\n`)
process.stdout.write(`${JSON.stringify({ score: Number(process.env.AUTORESEARCH_SCORE ?? 1) })}\n`)
