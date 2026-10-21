# Changelog

## Unreleased

### Added

- Default-branch dependency audit failures open a deduplicated Issue mentioning
  the repository owner and linking workflow logs. Repeated failures at the same
  steps update it without new comments; changed failed steps notify again, and
  recovery closes it. Setup and registry failures are reported too, not only
  confirmed vulnerabilities. Branch experiments and cancelled runs are ignored.

### Changed

- Raise scheduled and manual dependency audits to `--audit-level high`, retaining
  development and optional dependency coverage.

### Fixed

- Latest-upstream compatibility checks now resolve a fresh candidate lockfile
  instead of retaining baseline transitive versions that can violate newer
  Cordis peer requirements. Published peer ranges and baseline dependency
  resolutions are unchanged.
- Pin Vitest to the same version as its coverage provider so clean candidate
  installs satisfy their exact mutual peer requirements.

## v0.0.1

### Added

- Opt-in DeepSeek Harness bundle exposing the `autoresearch` tool for bounded,
  metric-driven optimization inspired by Karpathy's autoresearch.
- Baseline-first evaluation of one minimized or maximized scalar metric, strict
  improvement-only acceptance, candidate limits, and optional target thresholds.
- Isolated Git worktrees with explicit mutable paths, protected evaluator and
  local dataset files, and one active run per repository.
- Host-owned evaluator registrations with fixed shell-free commands, final-line
  JSON metric parsing, per-attempt watchdogs, bounded output, and managed
  process-tree cleanup. Worktrees are not a security sandbox.
- Durable SQLite run and experiment evidence, evaluator/dataset/policy provenance,
  and resume validation before further mutation or execution.
- Foreground execution and default background jobs controlled through `job_list`,
  `job_output`, and `job_kill`.
- Cancellation and hot-reload cleanup that waits for proposal children and jobs
  to settle, reconciles accepted Git state, and retains run authority when
  evaluator quiescence cannot be established.
- Configurable artifact and worktree retention, plus independent Host Git timeout
  and output limits so evaluator budgets do not constrain repository operations.

### Compatibility

- Requires the coordinated DeepSeek Harness `0.2.0-rc.2` service family and scoped
  `@deepseek-ai/cordis` `~4.0.4`.
- Requires Node.js `^22.19.0 || >=24.2.0`.
