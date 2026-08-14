# dsh-autoresearch

`dsh-autoresearch` is an opt-in DeepSeek Harness bundle for bounded, metric-driven software optimization. It generalizes the loop popularized by Karpathy's autoresearch:

1. freeze the objective, evaluator, metric, constraints, provenance, environment, and mutable scope;
2. measure the unmodified baseline;
3. ask a fresh child Agent to propose one narrowly scoped candidate;
4. commit and evaluate that candidate in a dedicated Git worktree;
5. keep it only when its scalar metric is strictly better, otherwise return to the accepted commit;
6. persist every decision and its evidence before continuing.

The authority is trusted host code, not a prompt. `AutoresearchRunController` owns the run state machine, Git boundary, evaluator subprocess, metric decision, SQLite tracker, artifacts, cancellation, and recovery. The model proposes edits through a restricted child composition; it does not decide whether its candidate is accepted. This package does not modify AgentLoop and contains no workflow engine.

## Installation and profile composition

Install the published package or a packed tarball into a named profile:

```bash
dsh plugin --profile <name> add <tarball-or-package>
dsh --profile <name> --dump-config
```

For example:

```bash
dsh plugin --profile research add ./dsh-autoresearch-0.1.0.tgz
dsh --profile research --dump-config
```

Installation is opt-in: a base or unrelated profile does not load autoresearch. The bundle's stable `cordis.patch.yml` row has `id: autoresearch`, `name: dsh-autoresearch`, and a complete configuration object. Confirm that the dumped profile contains that row.

The installed profile must also provide:

- the core `agents` registry/runtime with child setup support (`ctx.agents.create`); no separate subagent provider is used;
- the `jobs` registry and `dsh-tool-jobs`, which expose `job_list`, `job_output`, and `job_kill`;
- a `subprocess` provider capable of spawning argv directly and proving provider-owned process-tree quiescence;
- `systemPrompt` and `tools` services;
- the normal LLM/session services required by the parent Agent.

The plugin declares these seams as Cordis injection dependencies: `agents`, `jobs`, `subprocess`, `systemPrompt`, and `tools`. Injection determines service readiness; YAML row order is not the dependency mechanism. Startup fails explicitly when a required service, child runtime, job registry, or generic job tool composition is missing.

Cordis patch overrides are whole-row replacements, not deep merges. If a profile replaces the `autoresearch` row or its `config`, repeat every field you intend to preserve.

## Deployment configuration

All sizes and times are positive integers. Unknown keys are rejected. The shipped patch repeats all independent defaults because a profile override replaces the whole config.

| Field | Default | Meaning and limit |
|---|---:|---|
| `provider` | unset | Optional child Agent provider route. |
| `model` | unset | Optional child Agent model override. |
| `maxTokens` | unset | Optional positive child Agent token cap. |
| `subagentProvider` | unset/ignored | Accepted only for clean migration from early 0.1.0 configuration; runtime composition uses `ctx.agents`, not a subagent service. Do not set it in new profiles. |
| `gitExecutable` | `git` | Bare executable name or absolute Git path resolved by the subprocess provider. |
| `stateRoot` | `dsh-autoresearch` | Safe relative directory beneath the repository Git common directory. |
| `branchPrefix` | `autoresearch/` | Valid Git prefix ending in `/`. |
| `resultsFile` | unset/ignored | Accepted legacy configuration only; authoritative exports use the state-root layout below. Do not set it in new profiles. |
| `defaultMaxExperiments` | `20` | Candidate cap when the tool omits `max_experiments`; must not exceed `maxExperiments`. The baseline is separate. |
| `maxExperiments` | `100` | Deployment maximum for a run's candidate experiments. |
| `maxHandoffChars` | `16384` | Maximum serialized child proposal/report handoff. |
| `maxResultChars` | `16384` | Maximum serialized canonical run result accepted from durable state. |
| `maxStdoutBytes` | `1048576` | Authoritative evaluator stdout capture/parse limit. Overflow fails the attempt. |
| `maxStderrBytes` | `1048576` | Evaluator stderr capture limit. |
| `defaultTimeoutMs` | `900000` | Per-attempt wall-clock timeout when omitted; must not exceed `maxTimeoutMs`. |
| `maxTimeoutMs` | `3600000` | Deployment maximum per-attempt timeout. |
| `terminationGraceMs` | `5000` | Grace supplied to subprocess termination before escalation. |
| `maxActiveRunsPerRepository` | `1` | Durable concurrent-run lock limit per repository identity. |
| `artifactRetentionDays` | `30` | Declared artifact-retention policy horizon. Automatic age-based deletion is not currently performed; cleanup is explicit. |
| `retainFailedArtifacts` | `true` | Declared failed-artifact retention policy. Current controller preserves failure evidence. |
| `retainWorktrees` | `true` | Preserve run worktrees by default. |
| `cleanupWorktreesOnSuccess` | `false` | Remove a safely terminal, quiescent worktree only when true and `retainWorktrees` is false; those two flags cannot both be true. |
| `exportTsv` | `true` | Atomically write the deterministic compatibility TSV at terminalization. |
| `tsvRetentionDays` | `30` | Declared TSV retention horizon. Automatic age-based deletion is not currently performed. |

## Tool input

`autoresearch` accepts one exact object; nested evaluator, allowlist, and provenance objects reject unknown keys.

| Field | Required/default | Schema and policy |
|---|---|---|
| `repository` | initiating Agent cwd | Normalized repository path or cwd. Discovery is read-only before tracker creation or mutating setup. |
| `run_tag` | exactly one of this or `resume_run_id` | Lower-case Git-safe text matching `[a-z0-9][a-z0-9._-]*`, without `..` or a trailing dot. |
| `resume_run_id` | exactly one of this or `run_tag` | Existing durable run UUID/id. Resume reuses its immutable stored tag, branch, and worktree identity. |
| `objective` | required | Normalized non-empty immutable optimization objective. |
| `constraints` | `[]` | Immutable normalized text constraints. |
| `mutable_globs` | required, non-empty | Deduplicated safe relative paths/globs; no absolute path or parent traversal. |
| `exceptional_allowlists` | all lists `[]` | Exact object with `dependencies`, `evaluators`, `datasets`, `submodules`, and `gitConfig`, each an array of safe relative paths. Exceptions are explicit policy, not automatic trust. |
| `evaluation` | required | Exact shell-free object `{ command: string, args: string[], cwd?: safe-relative-path }`. Empty argv elements are allowed; no shell command string is interpreted. |
| `metric_name` | required | Scalar JSON key matching `[A-Za-z_][A-Za-z0-9_.-]*`. |
| `metric_direction` | required | `minimize` or `maximize`. |
| `timeout_ms` | `defaultTimeoutMs` | Positive integer no greater than `maxTimeoutMs`. |
| `max_experiments` | `defaultMaxExperiments` | Positive integer no greater than `maxExperiments`; excludes baseline. |
| `target` | unset | Optional finite stopping threshold. |
| `provenance` | `{}` | Exact object with optional normalized `evaluator` and `dataset` labels. |
| `environment` | `{}` | Explicit evaluator overrides. Keys match shell environment identifiers; values are NUL-free strings. Values are hashed/redacted in durable evidence. |
| `mode` | `background` | `background` or `foreground`. |

These normalized values are frozen as the run policy. A resume must match the durable policy; changing the objective, scope, evaluator, metric, limits, provenance, or environment is not a continuation of the same run.

### Evaluator and metric protocol

The provider receives argv exactly as `[evaluation.command, ...evaluation.args]`, a contained canonical cwd, an explicit scrubbed environment, no stdin, output caps, timeout, and cancellation signal. The controller captures evaluator and dataset provenance, evaluator-file identities, normalized-policy and evaluator digests, spawn intent, provider PID, spawn time, exit facts, and output artifacts.

A successful evaluator must exit with code 0, without a signal or timeout, and its **last non-empty stdout line** must be one JSON object containing `metric_name` as a finite JSON number. Example:

```text
training diagnostics may precede the result
{"val_bpb":1.2345}
```

Extra text on the final line, missing keys, strings, `null`, `NaN`, infinity, truncated/lossy stdout, nonzero exit, or an unquiesced process tree fails the attempt. Earlier output is evidence only.

For `minimize`, a candidate is accepted only when `candidate < best`; for `maximize`, only when `candidate > best`. Equality is rejected. `target` uses `<=` for minimize and `>=` for maximize.

The baseline is ordinal zero and does not consume the candidate budget. It establishes the first accepted metric and commit. If it cannot produce a valid metric, the run terminates as `baseline-blocked`; candidates never start without an authoritative baseline.

## Controller loop and Git boundary

For a fresh run, the controller:

1. resolves Git and performs read-only repository discovery;
2. creates the owner-only state root and SQLite tracker;
3. acquires the durable controller claim and repository run lock;
4. allocates branch `<branchPrefix><run_tag>-<run_id>` and worktree `<git-common-dir>/<stateRoot>/worktrees/<run_id>`;
5. records and evaluates the baseline;
6. creates a fresh child Agent for each candidate with inherited `read`, `write`, `edit`, `glob`, and `grep` tools plus one terminal `autoresearch_report` tool;
7. verifies the diff, protected paths, Git configuration, submodules, evaluator/dataset identities, and mutable policy; commits the candidate and creates an audit ref;
8. evaluates in trusted host code, makes the strict metric decision, persists it, and moves the accepted ref/branch as required;
9. repeats until target, budget, cancellation, failure, or a proven blocker.

The initiating checkout is discovery input only and remains unchanged. All mutation occurs in the dedicated run worktree. Protected defaults include `.git`, `.gitmodules`, package manifests/lockfiles, `cordis.patch.yml`, and Git config; exceptional changes require the corresponding explicit allowlist. Accepted and rejected candidates retain full commit SHAs and per-run audit refs under `refs/autoresearch/runs/<run_id>/accepted` and `refs/autoresearch/runs/<run_id>/candidates/…`.

The branch and worktree include `run_id`, so a retained run never aliases a later run. Reusing the same `run_tag` creates a distinct identity. Cleanup is conservative: worktrees and evidence are retained by default, there is no implicit tag-based deletion, and operators should remove retained artifacts only after audit/recovery needs end. Successful automatic worktree removal requires both `cleanupWorktreesOnSuccess: true` and `retainWorktrees: false` plus a safely terminal, quiescent run.

## State, tracker, artifacts, and TSV

For run `<run_id>`, state lives below:

```text
<git-common-dir>/<stateRoot>/
  runs/<run_id>/tracker.sqlite
  runs/<run_id>/artifacts/...
  worktrees/<run_id>/
  exports/<run_id>.tsv
```

The owner-controlled state root is a real, non-symlink directory with mode `0700`; tracker and artifact files are mode `0600`. SQLite schema version 4 is authoritative for run identity, immutable policy/provenance digests, transitions, experiments, attempts, spawn facts, outcomes, artifacts, locks, and terminal state. Corrupt, newer, incompatible, or persistently busy trackers produce typed blocking rather than being overwritten.

The TSV is a deterministic, atomically replaced compatibility export ordered by experiment ordinal/id. It contains experiment summaries for inspection and older tooling; it is not recovery authority and must not be edited to influence a run. Artifact references include id, kind, contained location, byte size, and SHA-256. Evaluator stdout/stderr are bounded artifacts, not trusted instructions.

## Results and job control

Foreground success returns:

```ts
{ kind: 'foreground', run: AutoresearchRunResult }
```

Background readiness returns only after durable branch/worktree allocation:

```ts
{ kind: 'background', runId, jobId, tracker, branch, worktree }
```

Background startup failure returns:

```ts
{ kind: 'background-start-failed', jobId, runId?, status: 'failed' | 'cancelled', reason, evidence }
```

The canonical `run.status` union is:

- `target-reached`: includes `target` and `best`;
- `budget-limited`: includes `best`;
- `baseline-blocked`: includes `baselineAttemptId`, `reason`, and evaluator `exit` facts/artifacts;
- `blocked`: includes the last `best` and structured blocker `evidence`;
- `round-failed`: includes `reason`, evidence, and optional `best`;
- `cancelled`: includes `lastState`, `reason`, optional `best`, and literal `quiescent: true`.

Every run result also includes `runId`, tracker path, counts, and artifacts. `best` is `{ metric, commit: <full-40-character-sha>, experimentId }`. Counts are `experimentsStarted`, `experimentsCompleted`, and `attempts`.

Background runs use the generic jobs controls supplied by `dsh-tool-jobs`:

- `job_list` observes status;
- `job_output` reads/waits for bounded output and the terminal result;
- `job_kill` requests cancellation with a reason.

Readiness is deferred until durable identity exists. A job is not complete merely because cancellation was requested: the evaluator's entire provider-owned process tree must be quiescent, the child Agent handle must be disposed and absent from the registry with no live child jobs, terminal state/evidence must be persisted, and only then may the run lock be released and the job settle.

## Cancellation, interruption, recovery, and blocked states

`job_kill`, foreground abort, plugin disposal/HMR, and controller disposal all converge on the controller cancellation path. Cancellation intent is durably checkpointed. The controller terminates and awaits the evaluator through the subprocess provider, disposes the proposal Agent handle, verifies no registered child or nonterminal child job remains, writes the terminal `cancelled` row with `quiescent: true`, exports TSV when enabled, then releases safe locks.

HMR/plugin disposal first unregisters the tool and prompt guidance, cancels every active controller, awaits each controller's disposal, and waits for all active background-job promises. Reload therefore does not intentionally orphan controller work.

Resume with the original `run_id`:

```json
{
  "resume_run_id": "<run-id>",
  "objective": "the original objective",
  "mutable_globs": ["src/model.ts"],
  "evaluation": { "command": "node", "args": ["evaluate.mjs"] },
  "metric_name": "score",
  "metric_direction": "maximize"
}
```

Recovery reconciles the SQLite state, Git HEAD/branch/worktree, accepted and candidate audit refs, experiment/attempt rows, and persisted evaluator facts before taking action. It can finish a fully evidenced attempt, accept/reject or clean up a candidate, continue from a safe state, or return a typed blocker without duplicating a candidate.

A persisted PID is evidence, not post-restart authority. The plugin never signals a recorded PID solely because it still exists: PID reuse and unknown descendants make that unsafe. Safe rerun after interruption requires durable proof that the entire provider-owned evaluator process tree is quiescent. Parent death alone is insufficient. If spawn was observed but terminal process-tree evidence is missing or uncertain, recovery returns `blocked`, retains the lock/evidence as required, does not signal the PID, and does not start a duplicate evaluator. Other reconciliation blockers include ambiguous Git state, missing/mismatched refs or worktree identity, incompatible tracker schema, conflicting controller ownership, policy/provenance mismatch, and nonterminal state without sufficient evidence.

## Complete temporary-repository example

Create a clean repository whose evaluator prints the metric as final-line JSON:

```bash
tmp="$(mktemp -d)"
cd "$tmp"
git init
git config user.name 'Autoresearch Example'
git config user.email 'autoresearch@example.invalid'
printf 'export const value = 1\n' > candidate.mjs
cat > evaluate.mjs <<'JS'
import { value } from './candidate.mjs'
console.log('diagnostic: deterministic example')
console.log(JSON.stringify({ score: value }))
JS
git add candidate.mjs evaluate.mjs
git commit -m baseline
```

Ask the Agent to invoke `autoresearch` with the exact input:

```json
{
  "repository": "/absolute/path/to/the/temp/repository",
  "run_tag": "readme-example",
  "objective": "maximize score by editing candidate.mjs only",
  "constraints": ["keep the evaluator deterministic", "do not add dependencies"],
  "mutable_globs": ["candidate.mjs"],
  "exceptional_allowlists": {
    "dependencies": [],
    "evaluators": [],
    "datasets": [],
    "submodules": [],
    "gitConfig": []
  },
  "evaluation": {
    "command": "node",
    "args": ["evaluate.mjs"]
  },
  "metric_name": "score",
  "metric_direction": "maximize",
  "timeout_ms": 900000,
  "max_experiments": 20,
  "target": 2,
  "provenance": {
    "evaluator": "README deterministic evaluator",
    "dataset": "none"
  },
  "environment": {},
  "mode": "foreground"
}
```

`evaluate.mjs` is protected evaluator input and is intentionally outside `mutable_globs`. In a real run, choose narrow source globs and separately allow only genuinely necessary dependency/evaluator/dataset/submodule/Git-config changes.

## Security model

The trusted Harness host and this controller are policy authority. Child model output, repository content, evaluator stdout/stderr, TSV files, stale PIDs, and retained worktrees are untrusted evidence.

Host enforcement includes shell-free argv, closed/scrubbed Git and evaluator environments, canonical contained paths, symlink/ownership checks for state, immutable policy/provenance hashes, mutable/protected-path validation, Git-config and submodule checks, strict metric parsing/decision, bounded output, timeout/cancellation, process-tree quiescence, durable locks, and transition validation. The child receives only proposal-oriented file tools and one terminal report tool; it does not receive shell/subprocess or generic job control through that child composition.

This is **not an operating-system sandbox**. Repository code and the evaluator execute with the permissions of the configured subprocess provider and may exploit the host, network, credentials, kernel, or tools available to that provider. For untrusted code, compose an external container/VM/remote sandbox and resource/network/credential controls. The plugin's mutable-path policy protects the research protocol and Git result; it cannot replace OS isolation.

## Migration from recovered 0.1.0 behavior

Early 0.1.0 documentation described prompt-driven workflow orchestration, a legacy child-agent service, prompt-enforced keep/discard reports, a mutable in-worktree results file, and restarting by tag. None of those is current authority. Migrate by:

- composing `agents`, `jobs` + `dsh-tool-jobs`, `subprocess`, `systemPrompt`, and `tools`;
- replacing `evaluation_command` with `{ evaluation: { command, args, cwd? } }`;
- replacing `mutable_files` with `mutable_globs`;
- replacing `experiment_timeout_minutes` with bounded `timeout_ms`;
- using `target`, `mode`, explicit environment/provenance/allowlists, and `resume_run_id`;
- treating SQLite under the Git common directory as authority and TSV as export only;
- allowing the host controller, not the child prompt, to commit, evaluate, decide, cancel, and recover.

`subagentProvider` and `resultsFile` remain accepted configuration keys only to make stale profile rows fail less abruptly; they do not restore the old architecture and should be removed when rewriting a profile.

## Troubleshooting and limitations

- **Plugin row absent from `--dump-config`:** install it into the same named profile you booted; installation is opt-in.
- **Missing `ctx.agents.create`:** add the core Agent runtime with child setup support, not an old subagent provider.
- **Missing jobs controller composition:** add the jobs registry and `dsh-tool-jobs` so all three generic job tools exist.
- **Missing subprocess service:** add a compatible provider (normally the local provider or an external sandbox provider).
- **`baseline-blocked`:** inspect stdout/stderr artifacts and verify exit 0 plus exact final-line JSON metric.
- **`blocked` after restart:** inspect evidence; do not kill the recorded PID or delete locks. Establish provider-owned process-tree quiescence or resolve the stated Git/tracker mismatch, then resume by run id.
- **Mutable-path violation:** narrow the candidate or explicitly declare the correct exceptional allowlist; do not broaden globs merely to bypass protection.
- **Profile override lost defaults:** patch rows replace whole configs; copy the complete stable row and change only intended values.
- **Same tag already used:** tags are labels, not identities. A fresh run gets a new run-id-bearing branch/worktree; resume an existing run only by `resume_run_id`.

Current limitations: automatic age-based artifact/TSV retention is not implemented; explicit cleanup remains an operator responsibility. The controller supports one bounded scalar objective per run, serial candidates, and one evaluator attempt at a time. It does not provide distributed scheduling, multi-objective/Pareto decisions, hermetic builds, dependency caching, or an OS sandbox.

## Package and development

The npm package is ESM, requires Node `^22.19.0 || >=24.0.0`, exports `dsh-autoresearch` and `dsh-autoresearch/invariant`, and ships only generated `lib/` JavaScript/declarations/source maps, `cordis.patch.yml`, README, LICENSE, and package metadata. Harness packages are peers supplied by the installed profile; the sole direct runtime dependency is `@deepseek-ai/schemastery`.

Repository verification commands are:

```bash
pnpm install --frozen-lockfile
pnpm run typecheck
pnpm run test
pnpm run test:coverage
pnpm run build
pnpm pack
node scripts/release-smoke.mjs ./dsh-autoresearch-0.1.0.tgz
```
