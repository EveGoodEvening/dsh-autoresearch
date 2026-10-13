import { readFile } from 'node:fs/promises'

const value = Number((await readFile('score.txt', 'utf8')).trim())
if (!Number.isFinite(value)) throw new Error('score.txt must contain one finite number')
process.stdout.write(`${JSON.stringify({ score: value })}\n`)
