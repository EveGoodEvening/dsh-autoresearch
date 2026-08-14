# dsh-autoresearch Implementation Plan

## Goal and current state

Build an installable, opt-in DeepSeek Harness plugin that applies Karpathy-style autoresearch as a bounded, auditable optimization loop: a fresh child agent proposes and authors one candidate at a time, while trusted host code owns isolation, evaluation, metric parsing, acceptance, Git history, durable state, cancellation, and recovery.

The archived implementation session reached an implementation-start state and produced a working candidate package, but the repository began as an unborn `master` branch with no implementation files or commits. Twelve authoritative Git blobs remain recoverable. Before the planning-only commit, the orchestrator must create the exact durable direct refs listed below under `refs/recovery/autoresearch/*`, verify each ref's object id and `blob` type, and set repository-local `gc.auto=0` only as defense in depth. The planning artifacts (`PLAN.md` and `CHECKLIST.md`) are then committed in a dedicated planning-only commit; **Chunk 01 — `01-recover-authoritative-snapshot`** re-verifies the refs, types, and hashes, recovers the blobs byte-exactly, and commits exactly the 12 paths in a separate provenance commit.

## Product principles

1. **Everything is a Plugin.** Integrate through public Cordis/DSH services; do not modify AgentLoop or create a parallel harness.
2. **Host authority, agent creativity.** Agents may inspect, hypothesize, and edit only. They may not choose the evaluator, report the authoritative metric, accept/reject a candidate, mutate tracker state, promote/rollback Git, or decide recovery.
3. **One measured fact per transition.** Before proposal N+1, experiment N must have a terminal durable row and referenced artifacts.
4. **Strict improvement.** Minimize accepts only `< best`; maximize accepts only `> best`; ties reject. The host recomputes target satisfaction.
5. **Baseline before mutation.** Evaluate the immutable starting commit before any child edits. Baseline failure is terminal `baseline-blocked`, not a nullable-best experiment.
6. **Isolation over caller mutation.** Every run receives a dedicated branch/worktree. Never checkout, reset, stage, or clean the caller worktree.
7. **Durability before side effects.** Persist intent before each external effect and observed outcome after it.
8. **Canonical data over prose.** Tool/job APIs return discriminated JSON. Rendering is bounded and pure; prose is never the state contract.
9. **Bounded resources.** Experiments, child handoff/result sizes, stdout/stderr, evaluator time, active runs, and retained artifacts all have explicit limits.
10. **Evidence is retained.** Accepted and rejected candidates remain full commits/audit refs; cancellation and failure retain tracker and artifacts.
11. **Clean cutover.** Replace the recovered workflow-owned orchestration and shell-string evaluator. Do not keep compatibility shims that weaken invariants.
12. **Recovery is part of correctness.** Resume by durable `run_id`; ambiguous provenance or externally mutated state blocks rather than guesses.

## Exact DeepSeek Harness integration seams

The plugin remains a normal Cordis function plugin with named exports only: `name`, `inject`, `Config`, and `apply`.

| Concern | Exact seam | Contract |
|---|---|---|
| Tool exposure | `ctx.tools.register` using DSH `defineTool` | Register exactly one opt-in model tool named `autoresearch`; return canonical JSON, not rendered status text. Registration is lifecycle-owned and removed on disposal/HMR. |
| Human-request guidance | system-prompt registry via `ctx.systemPrompt` | Add guidance that the tool is used only for direct human autoresearch requests; contribution is removed on disposal. |
| Proposal/code rounds | `ctx.agents.create` | For every proposal round, create a fresh in-host Agent with a new `SessionId`, durable `meta.cwd` set to the canonical isolated worktree, `parentSession`/origin/delegation metadata derived from `exec.agent`, and explicit `agentOptions` that inherit the initiating Agent's provider, model, and optional `maxTokens`. During the unpublished `setup(childCtx)` window, compose the required parent policy/preset surface and register an autoresearch-only schema-validating report tool plus matching system-prompt section in the child scope. Drive the Agent with `followup(...)` and `whenIdle()`, cancel with `agent.cancel(...)`, validate/capture exactly one bounded report, and always `await AgentHandle.dispose()` in `finally` across success, invalid/missing report, cancellation, controller failure, and unload. The host remains authoritative for Git, evaluation, metrics, decisions, tracker state, and recovery. `SubagentStartRequest` is unsuitable because it has no per-run `cwd` or session-meta hook, and `agentOptions` cannot carry a cwd; an absolute path in a prompt is not workspace isolation. |
| Evaluation and Git processes | `ctx.subprocess.spawn` | Invoke explicit executable plus argv without shell interpretation. Evaluator and configured Git executable use validated cwd, bounded output, explicit/scrubbed environment, abort signal, grace period, whole-tree termination, and awaited `waitForExit()`. Persist spawn intent and observed PID/attempt facts, but treat a PID alone as non-authoritative after host restart. Never use `node:child_process` for authoritative execution. |
| Background lifetime | `ctx.jobs.start` | Publish background runs by default with `owner: exec.agent`. Implement the LocalJobRegistry-compatible deferred-start handshake: `run()` synchronously creates job-owned hooks/controller and returns a `done` promise whose controller execution waits behind a gate; after `ctx.jobs.start` returns, durably record the returned job id, sever lifetime from `exec.signal`, and release the gate. A readiness promise resolves only after tracker/branch/worktree facts are durably committed; only then may the tool return the background result. Initialization failure/cancellation before readiness rejects with a typed startup result while `done` settles without orphaned resources. Cancellation flows through the job hook. Declare job kind `autoresearch`; expose control through generic `job_list`, `job_output`, and `job_kill`, requiring the jobs registry and `dsh-tool-jobs` in profile composition. `done` resolves only after child/process/tracker/Git cleanup and maps plugin-internal cancellation to Harness job status `killed`. |
| Dependency ordering | Cordis `inject` | Inject `tools`, `agents`, `subprocess`, `jobs`, and `systemPrompt`. Service availability/order comes from injection, never YAML row order. |
| Bundle activation | `package.json` + `cordis.patch.yml` | Retain `"dsh":{"bundle":{"patch":"./cordis.patch.yml"}}`; patch inserts stable row id `autoresearch`, module `dsh-autoresearch`, and complete defaults because profile row configs are whole-row replacements rather than deep merges. |
| Lifecycle/HMR | Cordis fiber/disposers | Every registration, active controller, child, evaluator, and job hook must converge to quiescence on cancel/unload. `done` resolves only after resources, tracker transactions, and worktree reconciliation settle. |
| Durable Harness events | Existing tool/job/session records | Add no new durable session event initially. SQLite is plugin-owned run state. Add declaration merging only for the `autoresearch` job kind and an ephemeral progress event only if a UI actually consumes it. |

Required installed composition: tools registry, system-prompt registry, jobs registry plus `dsh-tool-jobs`, subprocess provider, and the core Agent registry/runtime exposed as `ctx.agents`. No configured subagent provider is required. Missing or incompatible seams must fail clearly at composition/start rather than hang.

## Resolved decisions and assumptions

- The 12 dangling blobs are the authoritative prior implementation. Before the planning-only commit, the orchestrator creates durable direct refs under `refs/recovery/autoresearch/*`, one for each authoritative blob, and records the exact ref/path/blob mapping; repository-local `gc.auto=0` is defense in depth, not the protection mechanism. No implementation work begins during this prerequisite. Commit `PLAN.md` and `CHECKLIST.md` next in a planning-only commit. Chunk 01 resolves every recorded ref, verifies that its object type is `blob` and its object id exactly matches the authoritative hash before reading bytes, recovers the files byte-exactly, and commits exactly those 12 paths in a separate provenance commit; the empty worktree is not permission to reconstruct from transcript text.
- The recovered fresh-agent/fixed-workflow design is useful evidence, but `ctx.workflowEngine` is removed from the production path. A worker workflow cannot enforce filesystem, Git, process, timeout, cancellation, or recovery invariants.
- A single host-owned `AutoresearchRunController` is the sole orchestration/state-machine owner.
- SQLite is the durable source of truth. TSV is a deterministic compatibility export only.
- Use built-in `node:sqlite`; retain Node engine `^22.19.0 || >=24.0.0`; verify the exact API during implementation.
- Use one dedicated Git worktree and branch per run. Both names include immutable `run_id` (for example `branchPrefix + runTag + '-' + runId`); `runTag` is only the active exclusion key. Resume identity is `run_id`, not branch/tag alone, and retained terminal worktrees therefore do not prevent later reuse of a tag.
- Public evaluator input is `{ command, args, cwd? }`. Remove recovered `evaluation_command` shell-string compatibility.
- Default metric protocol is exactly one dedicated final-line JSON object with exactly the configured metric key and a finite number. No regex/text parser initially.
- Baseline failure produces `baseline-blocked`, no `best`, no candidate, and no experiment-budget consumption beyond the baseline attempt.
- Rejected candidates remain addressable by full commit and audit ref.
- The package remains both code plugin and installable bundle until demonstrated reuse pressure justifies a split.
- Do not create redundant Harness persistence events; existing tool/job/session records and plugin SQLite have separate authority.
- Public Schemastery must be registry-resolvable. `^3.18.1` is a compatibility-review starting point, not an assumed final answer.
- The archived aborted test annotation cleanup is optional style work and is neither recoverable content nor a prerequisite.
- Configuration changes that affect evaluator comparability, policy, mutable scope, objective, parser, dataset, or environment require a new run rather than mutation of a resumed run.

## Recovery strategy

### Authoritative snapshot recovery

Create only these 12 recovered paths from Git objects, preserving bytes exactly:

| Path | Durable recovery ref | Blob |
|---|---|---|
| `.gitignore` | `refs/recovery/autoresearch/gitignore` | `e17975f37c2e5871018ed4cee7b190d022e11b87` |
| `pnpm-lock.yaml` | `refs/recovery/autoresearch/pnpm-lock` | `8555ed23387507503686e931818284961aaebc00` |
| `README.md` | `refs/recovery/autoresearch/readme` | `878fed41726089151600c4205a9f4a3571fd9c4a` |
| `tests/autoresearch.spec.ts` | `refs/recovery/autoresearch/unit-tests` | `a8c6214ecd99f0c2fe9ada08fcf00588040c5c07` |
| `cordis.patch.yml` | `refs/recovery/autoresearch/patch` | `2983549a5f076b657f7793e65fe6baa1bd9a92ce` |
| `tsconfig.json` | `refs/recovery/autoresearch/tsconfig` | `4a73dda7e2035dc42ece6532a3fb4a005dce3f90` |
| `package.json` | `refs/recovery/autoresearch/package` | `cbf644cfc0fcc38dc904e716d576d2feee8c4602` |
| `tests/workflow.integration.spec.ts` | `refs/recovery/autoresearch/integration-tests` | `cf39877043d803411ded03061defc7cd6a73a929` |
| `LICENSE` | `refs/recovery/autoresearch/license` | `114b31ff345b2b547a4cc070163e86a34d6f86fb` |
| `AGENTS.md` | `refs/recovery/autoresearch/agents` | `732a04d9d2f809031da3e8c2f6fce4a0fe2dca0d` |
| `vitest.config.ts` | `refs/recovery/autoresearch/vitest` | `f8f64617446fcf5790b200c5c0d22d9b59b7ac35` |
| `src/index.ts` | `refs/recovery/autoresearch/source` | `3bb484965e3e80df22c644bd48478cdc3a6cc739` |

Before the planning-only commit, the orchestrator must create and record one durable direct ref under `refs/recovery/autoresearch/*` for each authoritative object, verify each ref resolves to the exact expected object id, verify each resolved object type is `blob`, and set repository-local `git config gc.auto 0` as additional defense in depth. These durable refs, not `gc.auto`, protect the snapshot from pruning. At Chunk 01 start, resolve the recorded refs again and verify exact ref-to-hash identity plus blob type before any materialization. Materialize each file from the verified ref/object, create only necessary directories, verify every path with `git hash-object`, stage exactly the 12 recovered paths, and commit a provenance-only recovery snapshot separate from the already-committed planning artifacts. Do not use `git checkout`: there is no authoritative source tree/commit. Do not format, repair dependencies, or include the aborted test cleanup.

Immediately after recovery, run the recovered source-tree frozen install, typecheck, five-test suite, build, and pack as provenance. The install may use the recovered repository-local link dependencies; if that source-tree link target is unavailable, record the frozen-install failure as expected Chunk 01 provenance and defer the registry-resolvable Schemastery repair to Chunk 02. This proves only byte-exact recovery behavior, not the final architecture.

### Runtime recovery

- Initialization may perform only read-only repository discovery first: resolve repository identity, Git common directory, caller path, and immutable start SHA without locks, refs, worktrees, tracker files, or other repository mutation. This is necessary to derive `stateRoot` and the initial run identity.
- Immediately after discovery, create/open the tracker and initial `runs` row containing the discovered identity and immutable start SHA. The tracker row must exist before lock acquisition, branch/ref creation, worktree allocation, evaluator spawn, or any other mutating/allocating side effect.
- Resume by `run_id`; load the immutable policy snapshot and verify repository identity, start SHA, evaluator/config/provenance hash, run-id-bearing branch/worktree registration, current full HEAD, unresolved experiment, artifact completeness, and recorded evaluator attempt state.
- Persist evaluator spawn intent before spawn, then persist the provider-observed PID and attempt facts immediately after spawn. A PID is diagnostic evidence, not portable ownership proof. Within the same live host/provider session, use only provider-supported handle identity to await or terminate the owned process tree. After host restart, never signal a recorded PID unless the subprocess provider exposes and verifies a stable recoverable identity stronger than PID reuse. Rerun is permitted only when durable/provider evidence proves the entire provider-owned process tree for the prior attempt is quiescent—parent and every descendant have exited and cannot continue evaluator work. Parent-process death alone is insufficient. If whole-tree quiescence cannot be proven, transition to typed `blocked` for operator reconciliation; do not signal or duplicate execution.
- Interrupted baseline or candidate evaluation follows that conservative process rule: if entire prior provider-owned process-tree quiescence is proven, retain the interrupted attempt and rerun the exact evaluator from the immutable start or recorded candidate commit; if any descendant survival is uncertain, block and do not duplicate execution.
- Interrupted decision: recompute from durable measured facts and idempotently apply the deterministic outcome/expected accepted HEAD.
- Durably committed decision: idempotently reconcile worktree HEAD to the expected accepted commit.
- Cancellation/unload: persist cancellation intent; abort controller; terminate and await child/evaluator resources; reconcile to last durable accepted commit; atomically persist terminal cancellation/outcome and quiescent facts; only then release the repository/run-tag lock as the final idempotent operation. Recovery may release a stale lock whose owner is already durably terminal.
- Missing commits, protected changes, provenance mismatch, ambiguous tracker state, uncertain surviving evaluator, or external branch/worktree mutation produce typed `blocked` evidence. Preserve evidence before any repair; never use destructive reset as the only provenance record.
- Evidence retention and operational resource release are distinct: terminal runs release locks after terminal persistence, while dedicated run-id-bearing worktrees are removed only through the configured explicit worktree-retention/cleanup operation. Cancellation/failure never implicitly deletes tracker, artifacts, commits, or audit refs.

## Architecture

### Module ownership

| File | Responsibility |
|---|---|
| `src/index.ts` | Named Cordis exports, service injection, tool/input/output schemas, registration, prompt guidance, jobs adaptation, lifecycle wiring. No orchestration logic beyond composition. |
| `src/config.ts` | Exported Schemastery `Config`, Loader defaults, semantic resolver, cross-field limits, normalized immutable run policy. |
| `src/types.ts` | Canonical public/internal discriminated types, durable states, exact result variants, decode boundaries. |
| `src/render.ts` | Pure bounded renderers/summaries; no decisions or persistence. |
| `src/tracker.ts` | `node:sqlite` schema/versioning, WAL/foreign keys, transactions, transition validation, repositories, artifact references, recovery queries, deterministic atomic TSV export. |
| `src/git.ts` | Repository identity/common-dir discovery, lock/allocation, worktrees/branches, diff and mutable-scope enforcement, staging, full-SHA commits, audit refs, accepted-HEAD reconciliation. |
| `src/evaluator.ts` | Provenance freezing/hashing, subprocess spawn, argv/cwd/env, timers, output caps, process-tree termination, exit facts, strict final-line JSON metric parsing. |
| `src/agent.ts` | Fresh in-host Agent creation through `ctx.agents.create`, new session identity and worktree-bound durable metadata, inherited explicit model route, child-scoped report tool/prompt contract, bounded handoff/report validation, cancellation, and mandatory handle disposal. |
| `src/controller.ts` | Sole run loop and deterministic state machine: baseline, proposals, candidate preparation, evaluation, decision, target/budget termination, durable sequencing. |
| `src/recovery.ts` | Reconcile tracker, Git, process liveness, artifacts, unresolved attempt, and idempotent next action. |

Avoid generic utility layers. Extract only domain modules with clear authority.

### Durable model

SQLite entities:

- `runs`: run id, repository identity, caller path, start SHA, run-id-bearing branch/worktree, immutable objective/policy snapshot and hashes, lifecycle state, timestamps, agent/session identity, best facts, terminal reason.
- `experiments`: full experiment/attempt ids, parent/candidate/full SHAs, state, command argv/cwd, spawn intent, provider-observed PID/attempt identity facts, exit/signal/timeout facts, parsed metric, decision, failure/blocker reason. PID facts are evidence only unless a provider supplies stable recoverable identity proof.
- `artifacts`: kind, bounded metadata, content location, size/hash, ownership, retention facts.
- `transitions`: run/experiment scope, monotonic sequence, from/to state, intent/outcome facts, timestamp.

Enable foreign keys and WAL. All state transitions and associated facts are transactional. Process/agent waits occur outside transactions. Refuse unknown newer schema versions with typed `blocked` status.

Run states: `initializing`, `baseline-running`, `ready`, `candidate-prepared`, `candidate-running`, `deciding`, `completed`, `baseline-blocked`, `blocked`, `round-failed`, `cancelled`.

Experiment states: `baseline-pending`, `running`, `accepted`, `rejected`, `crashed`, `timed-out`, `policy-violation`, `cancelled`.

### Run sequence

1. Normalize/validate configuration and immutable tool policy inputs that do not require repository mutation.
2. Perform read-only repository/common-directory/start-SHA discovery so `stateRoot` and run identity can be derived.
3. Create/open tracker, schema, and initial run intent with discovered repository identity/start SHA.
4. Acquire repository/run-tag lock and allocate the run-id-bearing dedicated branch/worktree without touching caller HEAD/index.
5. Freeze/hash evaluator, files, dataset/version, environment overrides, parser, metric direction, target/tie policy, mutable policy, and budgets.
6. Run baseline on immutable starting commit. Parse trusted metric or terminate `baseline-blocked`.
7. If baseline meets target, complete `target-reached` without spawning a child.
8. Create a fresh worktree-bound in-host Agent with a new session id, explicit inherited model route, child-scoped schema-validating report tool/prompt contract, objective, policy, experiment number, best measured facts, and bounded tracker-derived history; drive it to idle, capture its bounded report, and dispose its handle before the round settles.
9. Snapshot parent, inspect all staged/unstaged/untracked changes, enforce allowlist/protected surfaces, stage only validated paths, and create a full candidate commit/audit ref.
10. Run the independent evaluator from the recorded candidate commit; persist exit facts, artifacts, and finite metric.
11. Host computes strict accept/reject and target state. Persist decision before moving accepted HEAD; reconcile idempotently.
12. Stop on target, budget, proven blocker, round failure, or cancellation; otherwise begin the next proposal only after terminal experiment persistence.
13. Publish atomic deterministic TSV after terminal experiment commits; TSV never drives recovery.

### Public contracts

`AutoresearchToolResult`:

- `{ kind: 'background', runId, jobId, tracker, branch, worktree }`, returned only after durable readiness
- `{ kind: 'background-start-failed', jobId, runId?, status: 'failed' | 'cancelled', reason, evidence }`, returned when deferred initialization fails before readiness; it never fabricates tracker/branch/worktree facts
- `{ kind: 'foreground', run: AutoresearchRunResult }`

`AutoresearchRunResult.status` variants:

- `target-reached`
- `budget-limited`
- `baseline-blocked`
- `blocked`
- `round-failed`
- `cancelled`

Success variants require `best: { metric, commit, experimentId }`, counts, and tracker/artifact references. `baseline-blocked` requires baseline attempt/reason/exit/artifacts and forbids `best`. Post-baseline `blocked` requires current best and blocker evidence. `round-failed` carries infrastructure/contract failure and current best when established. `cancelled` records the last quiescent state. Decode boundaries reject unknown keys, non-finite numbers, impossible required/forbidden combinations, inconsistent target/best facts, and oversized serialized results.

The tool execute body treats `exec.agent` as the authoritative parent/session/workspace identity. It derives each child Agent's `parentSession` and delegation metadata and explicit provider/model/optional `maxTokens` from that exact Agent, supplies it as each background job's `owner`, and records it as the durable `runs` agent/session identity source; no ambient agent is inferred.

## Safety invariants

1. Exactly one isolated candidate worktree per run.
2. Caller worktree HEAD, index, staged/unstaged/untracked changes are never mutated.
3. Repository/run-tag allocation is locked; colliding branches are rejected unless resuming the same tracker identity.
4. Starting repository identity and full SHA are recorded; all lineage uses full SHAs.
5. Read-only repository discovery may precede tracker creation; tracker/run intent containing repository identity and start SHA must exist before every mutating or allocating external setup side effect.
6. No child starts before a successful baseline or baseline-target completion decision.
7. No experiment N+1 starts until N is terminal and its artifacts are referenced.
8. Child output cannot select command/cwd/env/parser/metric/direction/target/tie policy/budget or authoritative status.
9. Every candidate is validated against mutable globs and protected surfaces, including staged, unstaged, and untracked paths.
10. Submodule, Git config, dependency, evaluator, dataset, and policy changes are rejected unless explicitly allowlisted.
11. Stage only host-validated paths; never use broad staging as authority.
12. Evaluator/Git execution is argv-only and shell-free.
13. Environment is explicit/scrubbed; ambient secrets are not forwarded.
14. Timeouts terminate the whole provider-owned process tree, await exit, and persist spawn PID/attempt plus actual exit/signal/timeout facts. After host restart, never signal by PID alone. Rerun requires proof that the parent and every descendant in the prior owned process tree are quiescent; parent death alone is insufficient, and uncertain descendant survival blocks.
15. Metrics are accepted only from the strict configured parser, exact key, single result, finite number, and frozen provenance.
16. Strict comparison and target satisfaction are host recomputed; ties reject.
17. Rejected candidates retain full commit/audit provenance.
18. Every transition plus associated facts is atomic; waits never occur inside SQLite transactions.
19. Resume never trusts child reports or creates a duplicate candidate for unresolved work.
20. Job `done` and plugin disposal settle only after controller, every mandatory `AgentHandle.dispose()`, evaluator process tree, transactions, and Git reconciliation are quiescent.
21. Cancellation is synchronous/idempotent at the hook, persists terminal state before lock release, and never deletes durable evidence.
22. Unknown schema version, missing provenance, ambiguous state, uncertain surviving evaluator, or external mutation blocks safely.
23. Returned model-facing data is bounded references/summaries; large logs remain artifacts.

## Configuration contract

Export a Schemastery `Config`; materialize defaults at Loader time and perform semantic/cross-field checks in an explicit resolver.

Deployment fields:

- optional child `provider`, `model`, and `maxTokens` overrides; otherwise inherit the initiating Agent's explicit values
- `gitExecutable`
- `stateRoot` (default below repository Git common directory, outside candidate/user index)
- `branchPrefix`
- `defaultMaxExperiments`
- `maxExperiments`
- `maxHandoffChars`
- `maxResultChars`
- `maxStdoutBytes`
- `maxStderrBytes`
- `defaultTimeoutMs`
- `maxTimeoutMs`
- `terminationGraceMs` (positive)
- `maxActiveRunsPerRepository`
- artifact retention settings
- worktree retention and explicit cleanup settings
- TSV retention/export settings

Immutable tool/run policy:

- repository/cwd
- run tag or resume id
- objective and constraints
- mutable globs and explicit exceptional allowlists
- evaluation `{ command, args, cwd? }`
- metric name and direction
- timeout and experiment cap
- optional target
- dataset/evaluator provenance inputs
- explicit environment overrides
- foreground/background mode

## Dependency and package policy

- Single package remains code plugin plus DSH bundle.
- Share installation identities: Cordis and DSH service packages are peer dependencies, mirrored as link/dev dependencies for source development; never bundle a private Cordis copy.
- Add `@deepseek-ai/dsh-subprocess` as peer/dev dependency.
- Use the public core Agent registry/runtime that provides `ctx.agents.create`; do not add a subagent provider dependency or source-import unpublished structured-runtime helpers.
- Remove workflow runtime peers/dependencies after controller cutover.
- Runtime dependencies in the publishable manifest/tarball must contain no repository-local `link:` or `workspace:` ranges.
- Replace `@deepseek-ai/schemastery` runtime link with a reviewed public compatible range; begin compatibility review at observed `^3.18.1`, then regenerate lock from registry metadata.
- Use built-in `node:sqlite`; add no native/private tracker package.
- Retain Node engine `^22.19.0 || >=24.0.0` unless verified APIs require a justified adjustment.
- Package exports built `lib`, `./invariant`, `cordis.patch.yml`, README, LICENSE, and `./package.json` through explicit `exports`/`files` policy.
- Retain `dsh.bundle.patch` metadata and stable patch id/module.
- Add normal publication metadata: repository, homepage, bugs, keywords, license, and `publishConfig` as appropriate.
- Packed/install-time behavior must not depend on source checkout, local links, or unapproved build scripts. Because installed profile composition requires `dsh-tool-jobs`, add `@deepseek-ai/dsh-tool-jobs` as a peer dependency mirrored for source development, alongside the subprocess and other DSH service peers.

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| Dangling blobs expire before recovery | Before the planning commit, create and record durable `refs/recovery/autoresearch/*` refs for all authoritative blobs and verify exact hash/type; keep `gc.auto=0` only as defense in depth. Chunk 01 re-verifies refs, hashes, and blob types before materialization. |
| Archived implementation is mistaken for present work | Checklist marks research/history only; all absent implementation remains unchecked. |
| Two orchestration state machines diverge | Remove workflowEngine production path; controller alone owns state. |
| Caller work is damaged | Dedicated worktree, full identity/SHA checks, no caller checkout/reset/stage/clean. |
| Agent spoofs improvement or command | Independent host evaluator, frozen policy/provenance, strict parser, host decision. |
| Shell injection or secret leakage | argv-only subprocess, validated cwd, scrubbed environment, no shell. |
| Timeout leaves descendants alive | whole-provider-owned-tree termination, positive grace, awaited settlement, and fixture proof covering parent plus descendants. |
| Crash creates ambiguous state/duplicates | Intent/outcome transitions, transactions, terminal experiment gate, run-id recovery, persisted spawn attempt facts, and conservative restart policy: never signal PID-only identities or duplicate evaluation; rerun only after proof the entire prior provider-owned process tree is quiescent, otherwise block. |
| Rejected work loses auditability | full candidate commit and audit ref before decision/rollback. |
| SQLite API/version mismatch | verify exact `node:sqlite` API under supported engines before implementation; typed schema versioning. |
| Profile appears installed but lacks capabilities | explicit `inject`, core Agent registry/runtime composition tests, keyless composition tests, and clear startup failure. |
| Whole-row patch replacement drops defaults | materialize complete defaults in `cordis.patch.yml`; schema test the row. |
| Tarball works only inside Harness checkout | registry-backed pack/install consumer fixture and profile-qualified `dsh plugin --profile <name> add <tarball-or-package>`/`dsh --profile <name> --dump-config` smoke. |
| Result union drifts into prose/impossible states | canonical schemas, exact-key decoding, pure renderer, variant tests. |
| Cancellation reports done too early | Deferred job start after returned job-id persistence; readiness waits for durable tracker/branch/worktree facts; job `done` waits for mandatory Agent handle disposal plus whole-process-tree/tracker/Git quiescence and reports Harness status `killed` for plugin cancellation. |
| State cleanup destroys evidence | Distinguish lock/worktree resource release from evidence retention; terminal state is persisted before lock release, worktree removal is explicit, and cancellation/failure retain tracker/artifacts/commits/refs. |
| Concurrency corrupts repository state | Per-repository/run-tag active locks, immutable run-id-bearing branches/worktrees, active-run cap, serialized promotion/tracker updates, terminal persistence, then lock release. |

## Verification strategy

### Recovery provenance

- Planning-only commit containing `PLAN.md` and `CHECKLIST.md` precedes recovery.
- Exactly 12 expected recovered paths are staged and committed in the separate Chunk 01 provenance commit.
- Each `git hash-object <path>` equals the authoritative mapping.
- Recovered source-tree install (or recorded expected local-link failure), typecheck, five tests when installable, build, and pack run once as provenance.

### Contracts/config/rendering

- Defaults, upper limits, cross-field constraints, normalized immutable snapshots.
- Every run/experiment result variant and impossible-state decoder rejection.
- Finite metric, exact keys, bounded serialization, target recomputation in both directions.
- Patch parses through Harness `entryListSchema`; whole-row defaults are complete.

### Tracker/recovery

- First creation after read-only repository discovery, WAL/foreign keys, idempotent reopen, transactional forward migration, refusal of newer schema.
- Transition ordering, invalid transitions, atomic experiment/result/artifact writes, crash between intent/outcome, and terminal persistence before lock release.
- Persisted spawn intent/PID/attempt facts; same-session provider-handle settlement; after restart, PID-only records are never signalled and uncertain survival blocks without duplicate evaluation.
- Deterministic atomic TSV export/rebuild; recovery does not read TSV; resume from every safely reconcilable nonterminal durable state without duplicate candidates.

### Real Git and subprocess behavior

Use temporary real repositories and short real fixture programs for:

- clean setup; dirty caller preservation; immutable run-id-bearing branch/worktree identity; same-tag active lock; later tag reuse despite retained prior worktree; independent run tags/worktrees; full-SHA lineage;
- protected/out-of-allowlist staged, unstaged, and untracked changes; dependency/submodule/config policy;
- candidate commits/audit refs; accepted/rejected HEAD reconciliation;
- exact evaluator argv/cwd/env; stdout/stderr caps; nonzero/signal facts; wall-clock timeout; descendants terminated; persisted spawn attempt facts; same-session cancellation; restart with proof the entire prior provider-owned process tree is quiescent reruns once; restart without whole-tree proof blocks and never signals a PID-only record or duplicates execution; quiescent settlement;
- baseline success, target already reached, nonzero, timeout, malformed/duplicate/non-finite metric, and provenance mismatch;
- strict keep, equal reject, regression reject, crash, timeout, and policy violation.

### DSH composition and lifecycle

- Real in-process Loader/AgentLoop/agents/jobs/subprocess composition; mock only model proposal content.
- Tool execution derives each fresh child's new `SessionId`, durable worktree `meta.cwd`, parent/delegation metadata, and explicit provider/model/optional `maxTokens` from `exec.agent`; background job ownership and durable run identity use that same authority anchor.
- The child-scoped schema-validating report tool and matching prompt section exist only in the child setup scope; missing, duplicate, malformed, stale, or oversized reports fail the round without becoming authority.
- Every `AgentHandle` is disposed exactly once/idempotently in `finally`, and controller/job/unload completion waits for disposal.
- LocalJobRegistry-compatible background startup defers controller execution until `ctx.jobs.start` returns and the job id is durable; readiness returns tracker/branch/worktree only after those facts are committed, with typed pre-readiness failure/cancellation.
- A registered background job survives the outer tool call's `exec.signal` abort because its job-owned controller governs the run; job cancellation settles as `killed` only after cleanup.
- HMR/unload removes registrations and awaits active resources.
- Missing jobs tool, subprocess, core Agent registry/runtime, or required child setup capability fails clearly.
- Two concurrent run tags isolate state; the same run tag is excluded only while active and can run again after terminal persistence and lock release because branch/worktree identity includes `run_id`.

### Release gate

From a clean registry-backed environment: frozen install; typecheck; focused contract/behavior/integration tests and required per-file coverage; build; real pack; inspect packed manifest/content; install tarball into separate consumer/profile with no Harness source checkout; run `dsh plugin --profile <name> add <tarball-or-package>`, `dsh --profile <name> --dump-config`, plugin load, and one temporary-repository smoke.

The final smoke must externally observe: caller worktree unchanged; dedicated run-id-bearing branch/worktree; read-only repository discovery followed by tracker creation before mutation/baseline; baseline row; one accepted and one rejected candidate with full SHA/audit records; strict metric decision; atomic TSV; deferred background readiness and job output; mandatory Agent handle disposal; cancellation cleanup; and safe resume after deliberately interrupting evaluation only when evidence proves the entire prior provider-owned process tree is quiescent. A separate restart scenario must show absent whole-tree quiescence proof becomes `blocked` without signalling a PID-only record or duplicating evaluation.

## Dependency-ordered implementation chunks

### 01 — Recover authoritative snapshot

**Depends on:** the orchestrator-created and recorded durable `refs/recovery/autoresearch/*` protection refs with exact hash/type verification, repository-local `gc.auto=0` as defense in depth, then the planning-only commit containing `PLAN.md` and `CHECKLIST.md`.  
**Exclusive files:** exactly the 12 recovered paths; no planning artifacts or redesign files.  
**Parallel safety:** not parallel-safe with any worktree edit. This is the current recovery chunk and must land as a byte-exact provenance implementation commit separate from the planning commit and its subsequent tracker-accounting commit.

Re-verify every recorded recovery ref resolves to the exact expected hash and blob type, materialize and hash-verify the files, commit exactly the 12 paths, then record its SHA and command/output provenance in a separate tracker-accounting commit.

### 02 — Fix publishability and package contract

**Depends on:** 01.  
**Primary ownership:** `package.json`, `pnpm-lock.yaml`, `tsconfig.json`, `src/invariant.ts` if required, package/bundle fixtures.  
**Parallel safety:** package/lock ownership is exclusive. Documentation and runtime redesign wait because exports/dependency identities are established here.

Replace runtime local link, review range, add subprocess and jobs-tool peer/dev dependencies, confirm the public core Agent registry/runtime dependency identity, add publication metadata, `./invariant`, explicit files/exports, and tarball-safe scripts. Prove registry pack/install.

### 03 — Define discriminated contract and config

**Depends on:** 02.  
**Primary ownership:** `src/types.ts`, `src/config.ts`, `src/render.ts`, `cordis.patch.yml`, contract/config tests; narrow schema-related `src/index.ts` edits.  
**Parallel safety:** types/config/render can be implemented in parallel only after their exact interfaces are fixed; one owner integrates `src/index.ts` and patch defaults.

Define tool inputs, normalized policy, results, baseline semantics, exact decoders, pure bounded rendering, and complete patch defaults. Remove workflow-specific public contract.

### 04 — Create durable tracker

**Depends on:** 03.  
**Primary ownership:** `src/tracker.ts`, tracker fixtures/tests.  
**Parallel safety:** tracker internals are isolated; may run in parallel with test-fixture preparation that does not edit shared contracts. Do not start Git/controller implementation against an unsettled tracker API.

Implement SQLite schema/versioning, transitions, artifacts, policy snapshots, recovery queries, locks/identity records, and atomic TSV export.

### 05 — Build host Git and evaluator boundaries

**Depends on:** 04.  
**Primary ownership split:** Git lane owns `src/git.ts` and Git fixtures/tests; evaluator lane owns `src/evaluator.ts` and process fixtures/tests.  
**Parallel safety:** these two lanes are genuinely parallel-safe once tracker/types interfaces are frozen. They must not edit each other's files; shared contract changes go through the chunk integrator.

Implement worktree/branch/lock/diff/staging/commit/audit safety and argv-only evaluator/provenance/parser/timeout/output/process-tree behavior. Integrate baseline-blocked causes.

### 06 — Implement recoverable controller

**Depends on:** 05.  
**Primary ownership:** `src/controller.ts`, `src/agent.ts`, `src/recovery.ts`, controller/recovery tests; removal of workflow production dependency/path.  
**Parallel safety:** proposal adapter and recovery reconciler may be developed in parallel against frozen interfaces; controller integration is exclusive. No parallel edits to tracker/Git/evaluator contracts without coordinated version change.

Implement the sole state owner, baseline gate, fresh worktree-bound in-host Agent proposal rounds with child-scoped validated reports, host validation/evaluation/decision, target/budget termination, durable sequencing, and resume reconciliation.

### 07 — Wire tool, jobs, lifecycle, and HMR

**Depends on:** 06.  
**Primary ownership:** `src/index.ts`, job-kind augmentation, prompt/tool/job/lifecycle tests, `cordis.patch.yml` only if composition defaults need final adjustment.  
**Parallel safety:** test authoring can parallelize by foreground/background/lifecycle fixture; `src/index.ts` integration has one owner.

Wire services through named Cordis exports, canonical foreground/background outputs, generic job control, status mapping, idempotent cancellation, and convergent disposal.

### 08 — Add real DSH composition and recovery tests

**Depends on:** 07.  
**Primary ownership:** integration/composition/concurrency/interruption fixtures and tests.  
**Parallel safety:** Loader composition, interruption/resume, and concurrency suites may be separate lanes with separate files/fixtures. Shared helpers have one owner; production edits are defect fixes only and reviewed centrally.

Replace fixed workflow-report integration with the real Harness stack; mock only model proposal content. Verify transcript, child Agent setup/report isolation, bundle/profile boot, jobs, subprocess, Git, tracker, recovery, HMR, and concurrency.

### 09 — Complete docs and release gate

**Depends on:** 08.  
**Primary ownership:** `README.md`, package metadata finalization, release/consumer fixtures.  
**Parallel safety:** documentation sections and release fixture preparation may parallelize after schemas/defaults are frozen; package manifest/lock and final README each have one owner.

Document actual install/config/evaluator protocol/state/recovery/cancellation/security/results/TSV/worktree behavior and complete the clean release gate.

## Review and commit discipline

Each chunk is independently reviewable and commit-ready. Before an implementation commit: all required pre-commit implementation/verification/review checkboxes are complete; affected contracts/callsites/tests/docs are updated; focused review is performed; no unrelated changes are included. Commit-SHA/content confirmation and durable command-output recording are post-commit accounting items and are expressly exempt from the pre-commit rule. After each implementation commit, update `CHECKLIST.md` with its full SHA, exact-content confirmation, and any required durable provenance in a separate tracker-accounting commit; never amend those records into the implementation commit. For Chunk 01 this preserves the exact 12-path recovery commit. The planning-only commit precedes Chunk 01. Required items classified `EXTERNAL` still block release until the named prerequisite is available and the item is completed; `DEFERRED` is permitted only for non-required work with prior recorded user/maintainer approval. After Chunk 09 implementation accounting and the final split reviews/classification pass, create one final release-accounting commit recording the completed release evidence and confirming that every required implementation and accounting commit is present; release is forbidden before that commit exists.
