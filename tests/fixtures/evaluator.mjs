const metric = Number(process.argv[2] ?? '1')
process.stdout.write(`${JSON.stringify({ metric })}\n`)
