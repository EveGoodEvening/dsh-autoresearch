# Changelog

## v0.0.3

### Added

- Add a Simplified Chinese README and language navigation between the English
  and Chinese documentation; include both READMEs in the published package.

### Changed

- Migrate the supported Host baseline to the exact, coordinated DSH `0.2.1-rc.2`
  CLI and service family in both development and peer dependencies.
- Raise the scoped `@deepseek-ai/cordis` peer range to `~4.0.5`, matching the
  development range, and upgrade `cordis-plugin-group` to `1.0.5` to satisfy
  the new Host boot peer requirement.
- Update targeted development dependency overrides for the new Host's pinned
  MCP client, Undici and Zod versions so the migration does not reintroduce
  their known advisories. These overrides do not patch consumer-managed Hosts.
- Clarify upstream invariant diagnostic activation and the minimal SDK's
  composition requirements.

### Known issues

- The four `fast-uri@3.1.8` advisories documented under v0.0.2 remain present
  in the release-time audit (two moderate, two low). This release leaves the
  dependency lockfile, low-severity audit threshold, and seven-day release-age
  policy unchanged.

## v0.0.2

### Added

- Default-branch dependency audit failures open a deduplicated Issue mentioning
  the repository owner and linking workflow logs. Repeated failures at the same
  steps update it without new comments; changed failed steps notify again, and
  recovery closes it. Setup and registry failures are reported too, not only
  confirmed vulnerabilities. Branch experiments and cancelled runs are ignored.

### Changed

- Update `@deepseek-ai/schemastery` to `3.18.5` to satisfy the latest DSH
  settings peer requirement without changing the declared DSH/Cordis support ranges.
- Restore scheduled and manual dependency audits to `--audit-level low`, retaining
  development and optional dependency coverage without advisory suppressions.
- Require patched Node.js `^22.23.4 || ^24.22.1 || >=26.12.1` and align all CI
  workflows on Node.js `24.22.1` for the October TLS/Brotli and CA fixes.
- Refresh compatible transitive dependencies, pair Vitest/coverage at `4.1.12`,
  and replace vulnerable upstream pins for MCP client/SDK, Vite and fflate with
  patched releases while preserving the supported DSH release family.
- Earlier dependency-refresh verification on Node.js `24.22.1` reported zero
  low-threshold audit findings, passing peer checks,
  typecheck/build, 576 passing coverage tests (10 skipped), and the packed
  consumer/installed DSH profile/Web HTTP smoke. Normal HTTPS returned 200;
  all four published compromised-CA endpoints failed with `CERT_REVOKED`.

### Fixed

- Latest-upstream compatibility checks now resolve a fresh candidate lockfile
  instead of retaining baseline transitive versions that can violate newer
  Cordis peer requirements. Published peer ranges and baseline dependency
  resolutions are unchanged.
- Pin Vitest to the same version as its coverage provider so clean candidate
  installs satisfy their exact mutual peer requirements.

### Removed

- Remove the empty `dsh-autoresearch/invariant` companion and direct
  `@deepseek-ai/dsh-invariants` dependency. Upstream retired this mechanism after
  DSH `0.2.0-rc.2`; the latest compatibility probe no longer requests its nonexistent
  matching release. Remove custom imports or profile rows for the former companion.
  Controller-owned validation, evaluation and recovery checks are unchanged.

### Known issues

- The release-time audit on 2026-10-26 reports four advisories in transitive
  `fast-uri@3.1.8` (two moderate, two low):
  [GHSA-w74x-v6f9-j3xg](https://github.com/advisories/GHSA-w74x-v6f9-j3xg),
  [GHSA-wjr9-j795-jxcr](https://github.com/advisories/GHSA-wjr9-j795-jxcr),
  [GHSA-xhq7-xmqj-769h](https://github.com/advisories/GHSA-xhq7-xmqj-769h), and
  [GHSA-333x-w4r6-6crp](https://github.com/advisories/GHSA-333x-w4r6-6crp).
  This release retains the existing dependency resolutions; patched `3.1.9`
  becomes eligible under the seven-day release-age policy at 23:05:26 UTC that day.
  The audit threshold and release-age policy remain unchanged.

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
