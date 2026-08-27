# dsh-autoresearch

> Bounded, metric-driven autoresearch plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

`dsh-autoresearch` gives a DeepSeek Harness agent a single tool — `autoresearch` — that runs a **baseline-first, keep/reject optimization loop** inside an isolated Git worktree.

The design is inspired by [Karpathy's `autoresearch`](https://github.com/karpathy/autoresearch): an autonomous *propose → edit → run → measure → keep/revert* loop where a coding agent performs the search and a fixed mechanical metric acts as the source of truth. What makes that loop trustworthy is discipline — the agent proposes candidate changes; trusted host code owns evaluation, metric decisions, persistence, cancellation, and recovery. The model never touches the evaluator, the metric, or the database.

- **One scalar metric.** Strict `minimize` / `maximize` improvement against a measured baseline; no vibes.
- **Shell-free evaluator.** Immutable `{ command, args, cwd? }` argv, final-line JSON scalar parsing, frozen provenance hashes.
- **Narrow mutable surface.** Only `mutable_globs` paths may change; everything else is protected.
- **Durable SQLite evidence.** Every run, experiment, attempt, and artifact is recorded with transition-checked state and SHA-256 provenance.
- **Background jobs by default.** Runs are `dsh-jobs` background jobs; inspect or stop them with the generic job tools.
- **Resumable.** Crash-safe recovery reconciles in-flight runs from durable state on restart.

## Requirements

- Node.js `^22.19.0 || >=24.0.0` (uses `node:sqlite`)
- pnpm `11.7.0`
- DeepSeek Harness `0.1.1-rc.2`; this developer-preview integration is retested and repinned for each supported DSH release.
- The Host must provide `agents`, `jobs`, `subprocess`, `systemPrompt`, and `tools`. Background mode additionally requires the calling Agent to mount `dsh-tool-jobs`; the Web `standard` Agent preset and the base/headless compositions do so. Host-global `job_*` tools are not required.

## Install

Install the published package through DSH's profile plugin manager:

```sh
dsh plugin --profile <name> add dsh-autoresearch
dsh --profile <name> --dump-config
```

`dsh plugin` forwards the package spec to pnpm inside the selected profile, then adds installed packages that declare `dsh.bundle` to that profile's ordered bundle list. A plain `pnpm add` does not perform that DSH reconciliation.

For a release-like installation from this checkout, build and install the packed artifact:

```sh
pnpm install --frozen-lockfile
pnpm pack
dsh plugin --profile <name> add ./dsh-autoresearch-0.1.0.tgz
dsh --profile <name> --dump-config
```

For local development, install a link to the built checkout instead:

```sh
pnpm install --frozen-lockfile
pnpm run build
dsh plugin --profile <name> add .
dsh --profile <name> --dump-config
```

DSH anchors relative filesystem specs such as `.` and `./dsh-autoresearch-0.1.0.tgz` to the directory where you invoke `dsh`. The config dump should contain `id: autoresearch` and `name: dsh-autoresearch`.

The package ships a Cordis patch row (`cordis.patch.yml`) declared via `dsh.bundle.patch` in `package.json`. DeepSeek Harness out-of-tree features ship as opt-in bundles: the stable patch inserts an ordinary Cordis plugin row whose config is **replaced whole, not deep-merged**, so every default you want must be explicit in the patch row.

## How it works

```
┌─────────────┐   proposal    ┌──────────────────┐   evaluate   ┌──────────────┐
│  proposal   │ ────────────► │ AutoresearchRun  │ ───────────► │  evaluator   │
│   agent     │ ◄──────────── │    Controller    │ ◄─────────── │ (host-owned) │
└──────────────┘   history     └────────┬─────────┘   metric     └──────────────┘
                                        │ persist
                                        ▼
                               ┌──────────────────┐
                               │  DurableTracker  │  SQLite, schema v6
                               └──────────────────┘
```

1. **Baseline.** The controller checks out the start commit, runs the evaluator, and records the baseline metric. No baseline → run is `baseline-blocked`.
2. **Propose.** A delegated proposal agent (inherited tools: `read`, `write`, `edit`, `glob`, `grep`) edits only `mutable_globs` and reports back via the `autoresearch_report` tool.
3. **Evaluate.** The candidate commit is checked out into the worktree and the evaluator argv runs under an immutable boundary; provenance (evaluator files, dataset) is frozen and revalidated.
4. **Decide.** Strict improvement against the current best → `accept` (fast-forward the run branch); otherwise `reject`. A `target` threshold stops the loop early.
5. **Persist.** Every transition is written to the SQLite tracker with artifacts, attempts, and SHA-256 hashes. Terminal states: `target-reached`, `budget-limited`, `baseline-blocked`, `blocked`, `round-failed`, `cancelled`.

Runtime authority lives in `AutoresearchRunController` (`src/controller.ts`); it composes the existing `agents`, `jobs`, `subprocess`, `systemPrompt`, and `tools` services — no separate workflow engine or subagent service.

## The `autoresearch` tool

Registered by `apply()` in `src/index.ts`. Runs as a **background job** by default; set `mode: 'foreground'` to block the caller until completion.

| Parameter | Required | Description |
| --- | --- | --- |
| `objective` | yes | Immutable optimization objective. |
| `mutable_globs` | yes | Narrow relative paths/globs the proposal agent may edit. |
| `evaluation` | yes | Shell-free evaluator argv: `{ command, args, cwd? }`. |
| `metric_name` | yes | Exact JSON scalar key on the evaluator's final output line. |
| `metric_direction` | yes | `minimize` or `maximize`. |
| `run_tag` | one of | Fresh Git-safe exclusion tag; mutually exclusive with `resume_run_id`. |
| `resume_run_id` | one of | Durable run id to resume using canonical repository identity and the persisted start commit; caller HEAD and subdirectory may differ. |
| `constraints` | no | Immutable policy constraints. |
| `exceptional_allowlists` | no | Explicit `dependencies` / `evaluators` / `datasets` / `submodules` / `gitConfig` path exceptions. |
| `timeout_ms` | no | Per-attempt timeout, bounded by deployment policy. |
| `max_experiments` | no | Candidate experiment cap (baseline is separate). |
| `target` | no | Finite stopping threshold. |
| `provenance` | no | `{ evaluator?, dataset? }` labels. |
| `environment` | no | Evaluator env overrides; every value a NUL-free string, no reserved `DSH_` prefix. |
| `mode` | no | Execution-only dispatch: `background` (default) or `foreground`; it may change when resuming a run. |

**Output** is a discriminated JSON: `background` (run + job started), `background-start-failed`, or `foreground` (full run result). Run results carry `status`, `counts`, `best`, `artifacts`, and blocker `evidence`.

## Configuration

The `Config` schema (`src/config.ts`) is loaded at deploy time. Defaults (also in `cordis.patch.yml`):

| Key | Default | Meaning |
| --- | --- | --- |
| `gitExecutable` | `git` | Git binary. |
| `stateRoot` | `dsh-autoresearch` | Tracker + worktree state directory. |
| `branchPrefix` | `autoresearch/` | Run branch prefix (must end in `/`). |
| `defaultMaxExperiments` | `20` | Default candidate cap. |
| `maxExperiments` | `100` | Hard candidate cap. |
| `defaultTimeoutMs` | `900000` | 15 min per attempt. |
| `maxTimeoutMs` | `3600000` | 60 min hard per-attempt ceiling. |
| `terminationGraceMs` | `5000` | Grace period before killing the evaluator tree. |
| `maxActiveRunsPerRepository` | `1` | Concurrent run cap per repo. |
| `maxStdoutBytes` / `maxStderrBytes` | `1048576` | Evaluator output capture limits. |
| `maxResultChars` | `16384` | Tool result render limit. |
| `artifactRetentionDays` | `30` | Artifact-byte retention window, enforced lazily for safe terminal runs. |
| `retainFailedArtifacts` | `true` | If `false`, prune failed-attempt bytes at safe terminal settlement. |
| `retainWorktrees` | `true` | Keep terminal worktrees; `false` enables terminal cleanup. |
| `cleanupWorktreesOnSuccess` | `false` | With `retainWorktrees: false`, limit cleanup to `target-reached` / `budget-limited`. |
| `exportTsv` | `true` | Export a TSV summary per run. |
| `tsvRetentionDays` | `30` | TSV retention window, measured from the export mtime. |

Retention is repository-local and lazy: each controller startup sweeps safely terminal runs without a live controller owner, and each safe terminal settlement applies the same policy to the current run. Pruning removes artifact bytes but preserves SQLite artifact identity, size, hash, and outcome metadata so terminal replay remains deterministic. `retainWorktrees: false` removes every safely terminal worktree unless `cleanupWorktreesOnSuccess: true` narrows removal to successful terminal statuses.

## Project layout

```
src/
  index.ts            Plugin entry: registers the `autoresearch` tool + direct-human guidance
  controller.ts       AutoresearchRunController — sole owner of the run state machine
  config.ts           Config schema, defaults, run-policy normalization
  types.ts            Tool parameters, output schema, durable state types
  evaluator.ts        Shell-free evaluator boundary, provenance freezing, final-line JSON metric
  git.ts              Worktree/lock/claim/commit reconciliation, candidate validation
  tracker.ts          DurableTracker — SQLite, schema v5, transition-checked state
  recovery.ts         Crash-safe run reconciliation from durable state
  agent.ts            Delegated proposal agent + autoresearch_report tool
  render.ts           Tool result rendering with bounded truncation
  invariant.ts        Package invariant companion (dsh-invariants)
  state-layout.ts     SQLite state layout
  retention.ts        Lazy artifact/TSV retention sweeps and current-run pruning
  evaluator-artifacts.ts  Evaluator stdout/stderr artifact capture
```

## Develop

```sh
pnpm install
pnpm run typecheck      # tsc --noEmit
pnpm run test           # vitest run
pnpm run test:coverage  # vitest run --coverage
pnpm run build          # tsc -p tsconfig.json → lib/
pnpm run check          # typecheck + test + build
pnpm run release:smoke  # packed-artifact release verification
```

Release verification exercises the packed artifact **outside** the checkout: inspect the allowlist, install without local links, import generated ESM/declarations, install/dump the real named dsh profile, and boot the actual Web profile long enough to fetch its HTML surface. The integration suite separately executes autoresearch through the Web `standard` Agent preset with owner-scoped `job_*` controls.

## License

MIT © 2026 EveGoodEvening
