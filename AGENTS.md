# AGENTS.md

## Lessons

- DeepSeek Harness out-of-tree features ship as opt-in bundles: `package.json` declares `dsh.bundle.patch`, and the stable patch inserts an ordinary Cordis plugin row whose config is replaced whole, not deep-merged.
- Autoresearch runtime authority belongs to `AutoresearchRunController`; compose the existing `agents`, `jobs`, `subprocess`, `systemPrompt`, and `tools` services and generic `dsh-tool-jobs` controls instead of adding a workflow engine or subagent service.
- Karpathy-style autoresearch depends on a narrow mutable surface, immutable shell-free evaluator argv and provenance, one scalar metric, baseline-first execution, strict keep/reject decisions, and durable SQLite evidence.
- Release verification must exercise the packed artifact outside the checkout: inspect the allowlist, install without local links, import generated ESM/declarations, and install/dump the real named dsh profile.
