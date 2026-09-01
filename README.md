# dsh-autoresearch

> Bounded, metric-driven autoresearch plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

`dsh-autoresearch` gives a DeepSeek Harness agent a single tool — `autoresearch` — that runs a **baseline-first, bounded keep/reject optimization loop** inside an isolated Git worktree.

The design is inspired by [Karpathy's `autoresearch`](https://github.com/karpathy/autoresearch): a *propose → edit → run → measure → keep/revert* search where a coding agent proposes candidates and a fixed mechanical metric acts as the source of truth. Trusted Host configuration selects the evaluator; Host code owns evaluation, metric decisions, persistence, cancellation, and recovery. The proposal model cannot submit evaluator commands, metric definitions, dataset authority, or evaluator environment.

- **One scalar metric.** Strict `minimize` / `maximize` improvement against a measured baseline; no hidden tie-breaker or separate complexity score.
- **Host-selected evaluator.** New runs name a deployment registration with `evaluator_id`; the immutable argv, metric, environment, evaluator files, and dataset identity are persisted and revalidated for baseline, candidates, and resume.
- **Narrow mutable surface.** Only `mutable_globs` paths may change; registered evaluator and local dataset files remain protected even under broad globs.
- **Durable SQLite evidence.** Every run, experiment, attempt, and bounded artifact record is transition-checked and hash-bound.
- **Background jobs by default.** Runs are `dsh-jobs` background jobs; inspect or stop them with the generic job tools.
- **Fail-closed recovery.** Resume reconciles durable Host evidence before mutation or evaluator spawn.

## Requirements

- Node.js `^22.19.0 || >=24.0.0` (uses `node:sqlite`)
- pnpm `11.7.0`
- DeepSeek Harness `0.1.1-rc.2`; this developer-preview integration is retested and repinned for each supported DSH release.
- The Host must provide `agents`, `jobs`, `subprocess`, `systemPrompt`, and `tools`. Background mode additionally requires the calling Agent to mount `dsh-tool-jobs`; the Web `standard` Agent preset and the base/headless compositions do so. Host-global `job_*` tools are not required.

Automatic takeover of a controller claim left by abnormal Host death requires Linux `/proc/<pid>/stat` start-token evidence. Normal managed execution is not declared Linux-only, but on non-Linux systems a stale claim remains conservatively blocked; lease expiry alone is not proof that its owner died.

## Install

Install the published package through DSH's profile plugin manager:

```sh
dsh plugin --profile <name> add dsh-autoresearch
dsh --profile <name> --dump-config
```

`dsh plugin` forwards the package spec to pnpm inside the selected profile, then adds installed packages that declare `dsh.bundle` to that profile's ordered bundle list. A plain `pnpm add` does not perform that DSH reconciliation.

For a release-like installation from this checkout, build and install the artifact emitted by `pnpm pack` (the filename is derived from `package.json`):

```sh
pnpm install --frozen-lockfile
TARBALL=$(pnpm pack --silent)
dsh plugin --profile <name> add "./$TARBALL"
dsh --profile <name> --dump-config
```

For local development, install a link to the built checkout instead:

```sh
pnpm install --frozen-lockfile
pnpm run build
dsh plugin --profile <name> add .
dsh --profile <name> --dump-config
```

DSH anchors relative filesystem specs such as `.` and the path emitted by `pnpm pack` to the directory where you invoke `dsh`. The config dump should contain `id: autoresearch` and `name: dsh-autoresearch`.

The package ships a Cordis patch row (`cordis.patch.yml`) declared via `dsh.bundle.patch` in `package.json`. DeepSeek Harness out-of-tree features ship as opt-in bundles: the stable patch inserts an ordinary Cordis plugin row whose config is **replaced whole, not deep-merged**, so every default you want must be explicit in the patch row.

## How it works

```
┌─────────────┐  proposal   ┌──────────────────┐  evaluator id  ┌──────────────────┐
│  proposal   │ ─────────► │ AutoresearchRun  │ ─────────────► │ Host registration│
│   agent     │ ◄───────── │    Controller    │ ◄───────────── │ + managed argv   │
└─────────────┘  memory     └────────┬─────────┘     metric     └──────────────────┘
                                     │ persist
                                     ▼
                            ┌──────────────────┐
                            │  DurableTracker  │  SQLite; current schema authority:
                            └──────────────────┘  TRACKER_SCHEMA_VERSION in src/tracker.ts
```

1. **Baseline.** The controller checks out the immutable start commit, resolves the Host registration, derives hashes for registered local evaluator/dataset files, and measures the baseline. No baseline → `baseline-blocked`.
2. **Propose.** A delegated proposal agent (inherited tools: `read`, `write`, `edit`, `glob`, `grep`) edits only `mutable_globs` and submits one bounded, untrusted annotation. Later proposal prompts receive bounded research memory: truncated child hypotheses/summaries plus Host-derived commits, changed paths/diff statistics, metrics, decisions, and failure facts—not full logs or patches. Only exact configured secret values are redacted; all child annotations must still be treated as potentially sensitive untrusted data.
3. **Evaluate.** The candidate commit is checked out and the registered shell-free argv runs through the managed `ctx.subprocess` provider. The immutable registration and run-creation file manifest are revalidated before and after each attempt.
4. **Decide.** Strict improvement of the configured scalar metric against the current best → `accept`; otherwise `reject`. `constraints` are immutable, hash-bound proposal guidance only. They are not a Host-enforced simplicity criterion, complexity field, authoritative report field, or acceptance tie-breaker. Encode required simplicity in the trusted evaluator/objective or mutable-path policy.
5. **Continue or stop.** A proven-quiescent candidate timeout, non-zero exit, signal, output-limit failure, metric-protocol failure, or provider spawn failure is recorded, consumes that candidate ordinal, restores the accepted worktree, and permits the next bounded candidate. Baseline failures, cancellation, uncertain process state, policy/provenance/registration violations, persistence or Git contradictions, and exhausted recovery reruns stop or block the run.
6. **Persist and replay.** Every transition is written to the SQLite tracker. Cancellation records and replays the exact pre-cancellation run state (`lastState`) and canonical lineage; recovery does not infer a replacement origin state.

Runtime authority lives in `AutoresearchRunController` (`src/controller.ts`); it composes the existing `agents`, `jobs`, `subprocess`, `systemPrompt`, and `tools` services — no separate workflow engine or subagent service.

### Trust and isolation boundary

The Host-selected evaluator registration and the managed DSH subprocess provider are trusted. The plugin manages exact argv, a closed evaluator environment, bounded stdout/stderr capture, a per-attempt wall-clock timeout, cancellation, process-tree termination, and quiescence checks. It does **not** use the separate DSH sandbox seam and does not provide hostile-code filesystem, process, same-UID, privilege, or network isolation. An isolated Git worktree protects repository state; it is not an OS security boundary.

Do not run hostile evaluator or candidate code on the strength of this plugin. Deployments requiring that property must separately select and verify an external sandbox or read-only execution provider. First-party support for that broader threat model requires an explicit product change defining and testing a sandbox/deployment contract.

The timeout is a safety watchdog, not fixed steps, epochs, CPU/GPU time, FLOPs, or an exact fair-compute budget. Comparable compute methodology belongs to the trusted evaluator and remains identical through the frozen registration used for baseline, candidates, and resume.

## The `autoresearch` tool

Registered by `apply()` in `src/index.ts`. Runs as a **background job** by default; set `mode: 'foreground'` to block the caller until completion.

| Parameter | Required | Description |
| --- | --- | --- |
| `repository` | no | Repository or cwd; defaults to the initiating agent cwd. |
| `objective` | yes | Immutable optimization objective. |
| `mutable_globs` | yes | Narrow relative paths/globs the proposal agent may edit. |
| `run_tag` | new run | Fresh Git-safe exclusion tag; required with `evaluator_id` and forbidden on resume. |
| `evaluator_id` | new run | Host-provided evaluator registration id; required with `run_tag` and forbidden on resume. |
| `resume_run_id` | resume | Durable run id; mutually exclusive with `run_tag` and `evaluator_id`. The stored registration and policy remain authoritative. |
| `constraints` | no | Immutable, hash-bound advisory proposal guidance; not an acceptance rule. |
| `timeout_ms` | no | Per-attempt wall-clock watchdog bounded by deployment policy. |
| `max_experiments` | no | Immutable candidate cap for the run; baseline is separate. |
| `target` | no | Finite stopping threshold. |
| `mode` | no | Execution-only dispatch: `background` (default) or `foreground`; it may change when resuming a run. |

Evaluator command, args, cwd, environment, metric name/direction, evaluator files, and dataset registration are deployment configuration under `evaluatorRegistrations`; they are intentionally absent from tool input. A new run freezes the normalized registration and hashes local files from its isolated worktree at exactly the start commit. Local datasets declare repository files; external datasets provide an algorithm-qualified immutable digest. Resume fails closed before spawn if the current Host registration, durable fingerprint, or frozen bytes disagree.

**Output** is a discriminated JSON: `background` (run + job started), `background-start-failed`, or `foreground` (full run result). Run results carry `status`, `counts`, `best`, `artifacts`, and blocker `evidence`.

Canonical run JSON is validated independently of `maxResultChars`; that setting applies only to rendered and background-job presentation.

## Configuration

The `Config` schema (`src/config.ts`) is loaded at deploy time. Defaults (also in `cordis.patch.yml`):

| Key | Default | Meaning |
| --- | --- | --- |
| `gitExecutable` | `git` | Git binary. |
| `stateRoot` | `dsh-autoresearch` | Tracker + worktree state directory. |
| `branchPrefix` | `autoresearch/` | Run branch prefix (must end in `/`). |
| `defaultMaxExperiments` | `20` | Default candidate cap; baseline is separate. |
| `maxExperiments` | `100` | Configured deployment maximum candidate cap (the shipped default, not a universal code constant). |
| `maxHandoffChars` | `16384` | Maximum serialized bounded research-memory handoff. |
| `defaultTimeoutMs` | `900000` | 15 min wall-clock watchdog per attempt. |
| `maxTimeoutMs` | `3600000` | Configured maximum watchdog per attempt. |
| `terminationGraceMs` | `5000` | Grace period before killing the evaluator tree. |
| `maxActiveRunsPerRepository` | `1` | Concurrent run cap per repo. |
| `maxStdoutBytes` / `maxStderrBytes` | `1048576` | Evaluator output capture limits. |
| `maxResultChars` | `16384` | Rendered tool and background-job presentation limit; canonical run results are unaffected. |
| `artifactRetentionDays` | `30` | Artifact-byte retention window, enforced lazily for safe terminal runs. |
| `retainFailedArtifacts` | `true` | If `false`, prune failed-attempt bytes at safe terminal settlement. |
| `retainWorktrees` | `true` | Keep terminal worktrees; `false` enables terminal cleanup. |
| `cleanupWorktreesOnSuccess` | `false` | With `retainWorktrees: false`, limit cleanup to `target-reached` / `budget-limited`. |
| `exportTsv` | `true` | Export a TSV summary per run. |
| `evaluatorRegistrations` | `[]` | Host-owned evaluator, metric, environment, frozen-file, and dataset contracts selectable by `evaluator_id`. |
| `tsvRetentionDays` | `30` | TSV retention window, measured from the export mtime. |

Runs are bounded. The shipped default is 20 candidate experiments and the shipped deployment maximum is 100; each candidate failure that is safe to continue consumes one ordinal. The baseline is separate, and a target, cancellation, blocking condition, or exhausted candidate cap can stop earlier. There is no indefinite mode or automatic run chaining; an operator may explicitly start another run.

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
  tracker.ts          DurableTracker — SQLite; TRACKER_SCHEMA_VERSION is authoritative
  recovery.ts         Crash-safe run reconciliation from durable state
  agent.ts            Delegated proposal agent + autoresearch_report tool
  render.ts           Tool result rendering with bounded truncation
  invariant.ts        Package invariant companion (dsh-invariants)
  state-layout.ts     SQLite state layout
  retention.ts        Lazy artifact/TSV retention sweeps and current-run pruning
  evaluator-artifacts.ts  Evaluator stdout/stderr artifact capture
```

## Legacy runs

Runs created before the Host-registration contract are retained as historical evidence and are never automatically converted or reinterpreted as satisfying the current Host-registration contract. Ordinary SQLite tracker schema migrations may still occur during retention or other writable maintenance; those migrations do not create an evaluator registration or grant resume authority. A legacy terminal run remains inspectable and eligible for normal retention handling. Attempting to resume a legacy nonterminal run fails closed with `legacy-evaluator-policy-unsupported`; inspect its tracker/artifacts, preserve or archive them according to operator policy, then explicitly start a new run with `run_tag` and a Host-provided `evaluator_id` if experimentation should continue.

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
