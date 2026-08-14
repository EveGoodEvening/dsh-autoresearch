# AGENTS.md

## Lessons

- DeepSeek Harness out-of-tree features ship as bundles: `package.json` declares `dsh.bundle.patch`, and the patch inserts ordinary Cordis plugin rows.
- Long-running model work should compose existing `ctx.workflowEngine`, `ctx.subagents`, and `ctx.jobs` seams instead of modifying `agent-loop`.
- Karpathy autoresearch depends on a narrow mutable surface, fixed evaluation budget, one scalar metric, baseline-first execution, and durable keep/discard logging.
