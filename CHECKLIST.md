# dsh-autoresearch Implementation Checklist

## Status rules

- `[x]` means verified in the current worktree or completed research/planning evidence.
- `[ ]` means not present or not verified in the current worktree.
- Archived implementation activity was historical evidence only until the authoritative snapshot was recovered. Chunk 01 is now closed by implementation commit `3ca85a17c03d15488269b3dbc339e3ec135d98c3`, tracker-accounting commit `4095697a6b7256937f535d739ca09678b47e333d`, review-fix commit `6524bdf`, and a clean independent correctness/accounting/security re-review after `6524bdf` with zero findings.
- **Current dependency-ready chunk: `02-fix-publishability-and-package-contract`.** Do not begin a later chunk until Chunk 02's implementation and separate tracker-accounting commits land.

## Established research and planning state

- [x] Research Karpathy autoresearch principles and bounded propose/evaluate/keep-or-discard loop.
- [x] Research DeepSeek Harness Everything-is-a-Plugin architecture.
- [x] Identify public integration seams: tools, system prompt, core agents, subprocess, jobs, Loader/bundle patch, lifecycle/HMR.
- [x] Identify the recovered implementation's useful product shape and unsafe workflow-owned enforcement boundary.
- [x] Resolve host-owned controller, SQLite tracker, dedicated worktree, argv evaluator, strict JSON metric, baseline gate, and canonical result decisions.
- [x] Identify the 12 authoritative dangling blobs and exact path/hash mapping.
- [x] Define dependency-ordered chunks, file ownership, and parallel-safety rules in `PLAN.md`.
- [x] Confirm current repository state is unborn `master` with no implementation files or commits before planning artifacts were created.
- [x] Recover the 12 implementation files into the current worktree.
- [x] Create the exact 12-path recovery implementation commit `3ca85a17c03d15488269b3dbc339e3ec135d98c3` (`feat: recover autoresearch plugin snapshot`).

# Chunk 01 — `01-recover-authoritative-snapshot` (CLOSED)

## Recovery prerequisites

- [x] Confirm the orchestrator created and recorded all 12 durable direct refs under `refs/recovery/autoresearch/*` before the planning-only commit; verified post hoc against the refs protected before planning commit `e7e896d8bebc51d4f2f9139d645c686d5a60bf2b`, without treating this prerequisite as Chunk 01 implementation work.
- [x] Confirm every recorded recovery ref resolved to its exact authoritative object id and object type `blob` before the planning-only commit; independently reverified after recovery.
- [x] Confirm the orchestrator set repository-local `git config gc.auto 0` as defense in depth, not as the snapshot-protection mechanism.
- [x] At Chunk 01 start, resolve every recorded recovery ref and re-confirm exact ref-to-hash identity plus object type `blob` before materialization or other implementation Git operations.
- [x] Re-confirm `git config --get gc.auto` is `0` as defense in depth.
- [x] Confirm no implementation source path already exists with conflicting content.
- [x] Confirm only planning artifacts are present before materialization.
- [x] Confirm planning-only commit `e7e896d8bebc51d4f2f9139d645c686d5a60bf2b` contains `PLAN.md` and `CHECKLIST.md` and no recovered implementation path.
- [ ] If `git fsck --full` reports `missing tree 4b825dc642cb6eb9a060e54bf8d69288fbee4904` for this unborn repository, record it as the benign empty-tree warning rather than a missing recovery blob.
- [x] Create `src/` and `tests/` directories only as required for recovered files.

## Materialize exact blobs

- [x] Materialize `.gitignore` from `e17975f37c2e5871018ed4cee7b190d022e11b87`.
- [x] Materialize `pnpm-lock.yaml` from `8555ed23387507503686e931818284961aaebc00`.
- [x] Materialize `README.md` from `878fed41726089151600c4205a9f4a3571fd9c4a`.
- [x] Materialize `tests/autoresearch.spec.ts` from `a8c6214ecd99f0c2fe9ada08fcf00588040c5c07`.
- [x] Materialize `cordis.patch.yml` from `2983549a5f076b657f7793e65fe6baa1bd9a92ce`.
- [x] Materialize `tsconfig.json` from `4a73dda7e2035dc42ece6532a3fb4a005dce3f90`.
- [x] Materialize `package.json` from `cbf644cfc0fcc38dc904e716d576d2feee8c4602`.
- [x] Materialize `tests/workflow.integration.spec.ts` from `cf39877043d803411ded03061defc7cd6a73a929`.
- [x] Materialize `LICENSE` from `114b31ff345b2b547a4cc070163e86a34d6f86fb`.
- [x] Materialize `AGENTS.md` from `732a04d9d2f809031da3e8c2f6fce4a0fe2dca0d`.
- [x] Materialize `vitest.config.ts` from `f8f64617446fcf5790b200c5c0d22d9b59b7ac35`.
- [x] Materialize `src/index.ts` from `3bb484965e3e80df22c644bd48478cdc3a6cc739`.
- [x] Do not reconstruct any source file from archived transcript payloads; independent review confirmed all 12 paths are byte-identical to their protected recovery blobs.
- [x] Do not apply the aborted test annotation cleanup; independent review confirmed it is absent.
- [x] Do not fix the Schemastery link, formatting, code, tests, docs, or metadata in the recovery snapshot; independent review confirmed the recovered snapshot remained unchanged.

## Recovery verification gate

- [x] Verify `.gitignore` hashes to `e17975f37c2e5871018ed4cee7b190d022e11b87`.
- [x] Verify `pnpm-lock.yaml` hashes to `8555ed23387507503686e931818284961aaebc00`.
- [x] Verify `README.md` hashes to `878fed41726089151600c4205a9f4a3571fd9c4a`.
- [x] Verify `tests/autoresearch.spec.ts` hashes to `a8c6214ecd99f0c2fe9ada08fcf00588040c5c07`.
- [x] Verify `cordis.patch.yml` hashes to `2983549a5f076b657f7793e65fe6baa1bd9a92ce`.
- [x] Verify `tsconfig.json` hashes to `4a73dda7e2035dc42ece6532a3fb4a005dce3f90`.
- [x] Verify `package.json` hashes to `cbf644cfc0fcc38dc904e716d576d2feee8c4602`.
- [x] Verify `tests/workflow.integration.spec.ts` hashes to `cf39877043d803411ded03061defc7cd6a73a929`.
- [x] Verify `LICENSE` hashes to `114b31ff345b2b547a4cc070163e86a34d6f86fb`.
- [x] Verify `AGENTS.md` hashes to `732a04d9d2f809031da3e8c2f6fce4a0fe2dca0d`.
- [x] Verify `vitest.config.ts` hashes to `f8f64617446fcf5790b200c5c0d22d9b59b7ac35`.
- [x] Verify `src/index.ts` hashes to `3bb484965e3e80df22c644bd48478cdc3a6cc739`.
- [x] Verify the recovered tracked/staged set for Chunk 01 is exactly the 12 expected paths; `PLAN.md` and `CHECKLIST.md` already belong to the separate planning-only commit and must not enter the recovery commit.
- [x] Run the recovered frozen install once using the recovered source-tree link dependencies when their targets are available. `pnpm install --frozen-lockfile` succeeded using local Harness links and ran the package build.
- [ ] If a recovered local-link target is unavailable, record the frozen-install failure as expected provenance and defer the registry-resolvable dependency repair to Chunk 02; do not modify the recovery snapshot.
- [x] Run the recovered typecheck once when the recovered install succeeds. `pnpm run typecheck` passed.
- [x] Run the recovered five-test suite (four unit tests plus one integration test) once when the recovered install succeeds. `pnpm run test` passed 2 files / 5 tests.
- [x] Run the recovered build once when the recovered install succeeds. `pnpm run build` passed.
- [x] Run the recovered pack once when the recovered install succeeds. `pnpm pack` produced `dsh-autoresearch-0.1.0.tgz`.
- [x] Preserve every attempted recovery command/output for the post-implementation tracker-accounting commit; command/output provenance was recorded in `CHECKLIST.md`, and no provenance file entered recovery commit `3ca85a17c03d15488269b3dbc339e3ec135d98c3`.

## Recovery review gate

- [x] Review the staged recovery diff for exact path set and no content edits; independent reviews confirmed commit `3ca85a17c03d15488269b3dbc339e3ec135d98c3` contains exactly the 12 authoritative blobs.
- [x] Confirm no generated files, dependency repairs, formatting, or planning-driven redesign entered the recovery snapshot.
- [x] Confirm the known runtime Schemastery link defect remains unchanged for Chunk 02.
- [x] Confirm the aborted test typing/style edit is absent.

## Recovery implementation commit gate

- [x] Stage exactly the 12 recovered paths and no planning/checklist/provenance artifact.
- [x] Commit the byte-exact recovered implementation as a provenance implementation commit separate from the planning-only commit: `3ca85a17c03d15488269b3dbc339e3ec135d98c3` (`feat: recover autoresearch plugin snapshot`).

## Recovery tracker-accounting gate (after the implementation commit)

- [x] Record the recovery implementation commit full SHA and command/output provenance in `CHECKLIST.md`: `3ca85a17c03d15488269b3dbc339e3ec135d98c3`; frozen install/build, typecheck, 2-file/5-test suite, standalone build, and pack all succeeded; pack produced `dsh-autoresearch-0.1.0.tgz`.
- [x] Confirm the recovery implementation commit contains exactly the 12 authoritative blobs and no Chunk 02 or accounting work.
- [x] Commit that checklist/provenance update as separate tracker-accounting commit `4095697a6b7256937f535d739ca09678b47e333d` (`docs: record recovered snapshot verification`).

## Recovery review closure

- [x] Record review-fix commit `6524bdf` applied after the recovery implementation and tracker-accounting commits.
- [x] Complete an independent correctness, accounting, and security re-review after `6524bdf`; the re-review returned clean with zero findings.
- [x] Close Chunk 01 with implementation blob commit `3ca85a17c03d15488269b3dbc339e3ec135d98c3`, tracker-accounting commit `4095697a6b7256937f535d739ca09678b47e333d`, and review-fix commit `6524bdf` recorded.

# Chunk 02 — `02-fix-publishability-and-package-contract` (CURRENT — NEXT DEPENDENCY-READY)

## Package/dependency work

- [ ] Review public `@deepseek-ai/schemastery` compatibility beginning at `^3.18.1`.
- [ ] Replace the runtime repository-local Schemastery `link:` with the reviewed public range.
- [ ] Regenerate `pnpm-lock.yaml` from registry metadata.
- [ ] Add `@deepseek-ai/dsh-subprocess` as peer dependency.
- [ ] Add/mirror `@deepseek-ai/dsh-subprocess` as development dependency for source development.
- [ ] Add `@deepseek-ai/dsh-tool-jobs` as a peer dependency.
- [ ] Add/mirror `@deepseek-ai/dsh-tool-jobs` as a development dependency for source development.
- [ ] Confirm the public core Agent registry/runtime dependency identity that provides `ctx.agents.create`; do not add a subagent provider dependency or unpublished source import.
- [ ] Verify Cordis and DSH service identities remain peer dependencies rather than bundled private copies.
- [ ] Retain Node engine `^22.19.0 || >=24.0.0` unless API verification proves a necessary change.

## Publication contract

- [ ] Add/review repository metadata.
- [ ] Add/review homepage metadata.
- [ ] Add/review bugs metadata.
- [ ] Add/review keywords.
- [ ] Add/review `publishConfig`.
- [ ] Retain license metadata and include `LICENSE`.
- [ ] Add `src/invariant.ts` or the project-conventional invariant source required for `./invariant`.
- [ ] Export built package root from `lib`.
- [ ] Export `./invariant` from built `lib`.
- [ ] Export `./package.json`.
- [ ] Include `cordis.patch.yml`, README, LICENSE, and required built files in explicit `files` allowlist.
- [ ] Retain `"dsh":{"bundle":{"patch":"./cordis.patch.yml"}}`.
- [ ] Ensure scripts are tarball-safe and do not assume Harness source checkout.
- [ ] Ensure packed/install-time behavior does not depend on unapproved build scripts.

## Chunk 02 verification gate

- [ ] Perform a clean registry-backed install.
- [ ] Build package outputs needed for packing.
- [ ] Run actual package pack.
- [ ] Inspect packed `package.json` for zero runtime `link:` values.
- [ ] Inspect packed `package.json` for zero runtime `workspace:` values.
- [ ] Inspect tarball contents for root export, `./invariant`, patch, README, LICENSE, and package metadata.
- [ ] Install tarball into a separate consumer fixture with no Harness source checkout.
- [ ] Import package root in the consumer fixture.
- [ ] Import `./invariant` in the consumer fixture.

## Chunk 02 review gate

- [ ] Review dependency identity and peer/dev mirroring.
- [ ] Review packed manifest rather than only source manifest.
- [ ] Review absence of source-only paths/local links.
- [ ] Review scope: no controller/tracker redesign mixed into packaging fix.

## Chunk 02 implementation commit gate

- [ ] Confirm every Chunk 02 required pre-commit item is complete.
- [ ] Commit publishability/package contract separately from recovery and redesign.

## Chunk 02 tracker-accounting gate

- [ ] Record Chunk 02 implementation commit full SHA after it exists.
- [ ] Commit the checklist update separately from the Chunk 02 implementation commit.

# Chunk 03 — `03-define-discriminated-contract-and-config`

## Types and canonical results

- [ ] Create `src/types.ts`.
- [ ] Define immutable normalized run policy.
- [ ] Define full run, experiment, attempt, artifact, transition, and provenance identities.
- [ ] Define run durable states.
- [ ] Define experiment durable states.
- [ ] Define `AutoresearchToolResult` background-ready variant.
- [ ] Define `AutoresearchToolResult` typed background-start-failed variant for initialization failure/cancellation before readiness.
- [ ] Define `AutoresearchToolResult` foreground variant.
- [ ] Define `target-reached` run result.
- [ ] Define `budget-limited` run result.
- [ ] Define `baseline-blocked` run result that forbids `best`.
- [ ] Define post-baseline `blocked` run result requiring current best and evidence.
- [ ] Define `round-failed` run result with best only when established.
- [ ] Define quiescent `cancelled` run result.
- [ ] Define separately discriminated experiment results.
- [ ] Require full commit and parent SHAs where applicable.
- [ ] Reject unknown keys and impossible required/forbidden combinations at decode boundaries.
- [ ] Enforce finite metrics.
- [ ] Enforce target/best/report consistency.
- [ ] Enforce bounded serialized result size.

## Configuration

- [ ] Create `src/config.ts`.
- [ ] Export Schemastery `Config`.
- [ ] Materialize defaults at Loader time.
- [ ] Implement explicit semantic/cross-field resolver.
- [ ] Add optional child `provider`, `model`, and `maxTokens` overrides with initiating-Agent inheritance as the default.
- [ ] Add `gitExecutable`.
- [ ] Add `stateRoot` default below repository Git common directory.
- [ ] Add `branchPrefix`.
- [ ] Add `defaultMaxExperiments`.
- [ ] Add `maxExperiments`.
- [ ] Add `maxHandoffChars`.
- [ ] Add `maxResultChars`.
- [ ] Add `maxStdoutBytes`.
- [ ] Add `maxStderrBytes`.
- [ ] Add `defaultTimeoutMs`.
- [ ] Add `maxTimeoutMs`.
- [ ] Add positive `terminationGraceMs`.
- [ ] Add `maxActiveRunsPerRepository`.
- [ ] Add artifact retention settings.
- [ ] Add worktree retention and explicit cleanup settings.
- [ ] Add TSV export/retention settings.
- [ ] Define tool repository/cwd input.
- [ ] Define run tag or resume id input.
- [ ] Define objective and constraints inputs.
- [ ] Define mutable globs and exceptional allowlists.
- [ ] Define argv evaluation `{ command, args, cwd? }`.
- [ ] Remove `evaluation_command` string compatibility.
- [ ] Define metric name and minimize/maximize direction.
- [ ] Define timeout and experiment cap.
- [ ] Define optional target.
- [ ] Define evaluator/dataset provenance inputs.
- [ ] Define explicit environment overrides.
- [ ] Define foreground/background mode.

## Rendering and patch

- [ ] Create `src/render.ts`.
- [ ] Implement pure bounded renderers only.
- [ ] Keep renderers out of decision/persistence logic.
- [ ] Update `cordis.patch.yml` stable row id to/retain `autoresearch`.
- [ ] Update patch module name to/retain `dsh-autoresearch`.
- [ ] Materialize complete explicit defaults in the patch row.
- [ ] Remove workflow-specific public configuration from patch/tool schemas.

## Chunk 03 verification gate

- [ ] Test every config default.
- [ ] Test configured upper/lower limits.
- [ ] Test all cross-field validation.
- [ ] Test immutable normalization/snapshot behavior.
- [ ] Test every run result variant.
- [ ] Test every experiment result variant.
- [ ] Test baseline-blocked forbids `best`.
- [ ] Test blocked requires post-baseline best and evidence.
- [ ] Test target threshold recomputation for minimize.
- [ ] Test target threshold recomputation for maximize.
- [ ] Test finite metric rejection.
- [ ] Test exact-key/unknown-key rejection.
- [ ] Test bounded result rendering/serialization.
- [ ] Parse patch with Harness `entryListSchema`.
- [ ] Verify whole-row patch defaults are complete.

## Chunk 03 review gate

- [ ] Review unions for impossible states.
- [ ] Review public JSON for losslessness and Code Mode usability.
- [ ] Review config authority: evaluator policy is host input, never child output.
- [ ] Review module boundaries and remove duplicated old contract code.

## Chunk 03 implementation commit gate

- [ ] Confirm all callers/tests affected by the clean contract cutover are updated.
- [ ] Commit contracts/config/render/patch as one reviewable chunk.

## Chunk 03 tracker-accounting gate

- [ ] Record Chunk 03 implementation commit full SHA after it exists.
- [ ] Commit the checklist update separately from the Chunk 03 implementation commit.

# Chunk 04 — `04-create-durable-tracker`

## SQLite schema and repositories

- [ ] Create `src/tracker.ts`.
- [ ] Use built-in `node:sqlite`.
- [ ] Verify exact `node:sqlite` APIs on the supported Node engine floor.
- [ ] Create explicit schema version table/metadata.
- [ ] Enable foreign keys on every connection.
- [ ] Enable WAL.
- [ ] Create `runs` table with complete identity, policy, state, timestamps, and best/terminal facts.
- [ ] Create `experiments` table with full lineage, command, exit, metric, decision, and failure facts.
- [ ] Create `artifacts` table with kind/location/size/hash/ownership/retention facts.
- [ ] Create `transitions` table with monotonic sequence and from/to intent/outcome facts.
- [ ] Add required indexes and uniqueness constraints.
- [ ] Implement first-use atomic creation after allowed read-only repository/common-directory/start-SHA discovery.
- [ ] Implement idempotent reopen.
- [ ] Implement forward transactional migrations only.
- [ ] Refuse unknown newer schema with typed `blocked` reason.
- [ ] Store discovered repository identity and immutable start SHA in the initial run row.
- [ ] Require initial run creation before lock acquisition, ref/branch/worktree allocation, evaluator spawn, or any other mutating/allocating setup side effect.
- [ ] Implement transactional state-transition validation.
- [ ] Implement atomic transition plus associated facts/artifact references.
- [ ] Keep agent/process waits outside transactions.
- [ ] Implement immutable policy/provenance snapshots.
- [ ] Implement repository/run-tag active-lock identity and immutable run-id-bearing branch/worktree records needed for reconciliation.
- [ ] Persist evaluator spawn intent, provider-observed PID, and attempt facts; document PID as diagnostic only without provider-supported stable recovery identity.
- [ ] Implement queries for unresolved experiment and conservative recovery state, including terminal-owner stale-lock release.
- [ ] Implement deterministic TSV compatibility export.
- [ ] Rebuild TSV atomically after terminal experiment commits.
- [ ] Ensure TSV is never read as recovery/decision authority.

## Chunk 04 verification gate

- [ ] Test first tracker creation after read-only repository discovery.
- [ ] Test foreign keys enabled.
- [ ] Test WAL enabled.
- [ ] Test idempotent reopen.
- [ ] Test forward migration.
- [ ] Test refusal of newer schema.
- [ ] Test monotonic transition ordering.
- [ ] Test invalid transition rejection.
- [ ] Test atomic experiment/result/artifact writes.
- [ ] Test crash between persisted intent and observed outcome.
- [ ] Test transaction rollback leaves no partial authority.
- [ ] Test evaluator spawn intent/PID/attempt persistence.
- [ ] Test terminal state is durable before lock release and a stale lock owned by a terminal run is safely releasable.
- [ ] Test deterministic TSV export.
- [ ] Test TSV rebuild from SQLite.
- [ ] Test recovery succeeds with TSV absent/corrupted.

## Chunk 04 review gate

- [ ] Review transaction boundaries for no awaits/external side effects.
- [ ] Review constraints/indexes against recovery queries.
- [ ] Review source-of-truth rule: SQLite authoritative, TSV derived.
- [ ] Review schema captures every required provenance/exit/artifact fact.

## Chunk 04 implementation commit gate

- [ ] Confirm tracker API is frozen enough for Git/evaluator lanes.
- [ ] Commit tracker and focused tests.

## Chunk 04 tracker-accounting gate

- [ ] Record Chunk 04 implementation commit full SHA after it exists.
- [ ] Commit the checklist update separately from the Chunk 04 implementation commit.

# Chunk 05 — `05-build-host-git-and-evaluator-boundaries`

## Git boundary (`src/git.ts`)

- [ ] Create `src/git.ts`.
- [ ] Perform read-only caller repository, Git common directory, repository identity, and immutable start-SHA discovery before tracker creation; make no lock/ref/worktree/index mutation during discovery.
- [ ] Invoke configured Git executable through `ctx.subprocess` with argv.
- [ ] Use a wall-clock timeout for every Git subprocess call.
- [ ] Require positive termination grace for Git subprocess calls.
- [ ] Terminate the whole Git process tree on timeout or cancellation.
- [ ] Await Git `waitForExit()` before command settlement.
- [ ] Enforce stdout and stderr byte caps for Git invocations.
- [ ] Use an explicit/scrubbed environment for Git invocations.
- [ ] Acquire repository/run-tag active exclusion only after the tracker/run row exists.
- [ ] Enforce `maxActiveRunsPerRepository`.
- [ ] Create dedicated branch whose identity includes `branchPrefix`, `runTag`, and immutable `run_id`.
- [ ] Create dedicated worktree whose identity includes immutable `run_id` for every run.
- [ ] Treat `runTag` only as the active exclusion key; retained terminal branches/worktrees do not collide with later runs using the same tag.
- [ ] Reject branch/worktree identity collision unless resuming the same `run_id`.
- [ ] Never checkout/reset/stage/clean caller worktree.
- [ ] Preserve dirty caller staged/unstaged/untracked work.
- [ ] Snapshot candidate parent before child edits.
- [ ] Inspect staged changes.
- [ ] Inspect unstaged changes.
- [ ] Inspect untracked changes.
- [ ] Enforce mutable globs on host.
- [ ] Enforce protected surfaces on host.
- [ ] Reject dependency changes unless explicitly allowlisted.
- [ ] Reject submodule changes unless explicitly allowlisted.
- [ ] Reject Git config changes unless explicitly allowlisted.
- [ ] Reject evaluator/dataset/policy changes unless explicitly allowlisted.
- [ ] Stage only validated paths.
- [ ] Create every candidate as a full commit.
- [ ] Record full parent/candidate SHAs.
- [ ] Create/retain audit refs for accepted and rejected candidates.
- [ ] Implement idempotent accepted-HEAD reconciliation.
- [ ] Atomically persist terminal/quiescent run outcome before releasing the repository/run-tag active lock; make release the final idempotent operation.
- [ ] Recover and release a stale lock only when its owning run is durably terminal.
- [ ] Implement explicit configured worktree removal/release as an operational cleanup path without deleting tracker, artifact, commit, or audit-ref evidence.
- [ ] Avoid destructive reset as sole provenance record.

## Evaluator boundary (`src/evaluator.ts`)

- [ ] Create `src/evaluator.ts`.
- [ ] Represent evaluator as command plus argv, never shell line.
- [ ] Validate evaluator cwd against normalized policy.
- [ ] Build explicit/scrubbed environment.
- [ ] Prevent ambient secret forwarding.
- [ ] Freeze/hash evaluator argv.
- [ ] Freeze/hash evaluator files.
- [ ] Freeze/hash dataset/version identifiers.
- [ ] Freeze/hash environment overrides.
- [ ] Freeze/hash metric name/direction/parser version/policy.
- [ ] Persist evaluator spawn intent before calling `ctx.subprocess.spawn`.
- [ ] Persist provider-observed PID and attempt facts immediately after spawn.
- [ ] Treat PID as diagnostic evidence only; never use PID alone as ownership proof after host restart.
- [ ] Enforce stdout byte cap.
- [ ] Enforce stderr byte cap.
- [ ] Implement real wall-clock timeout.
- [ ] Require positive termination grace.
- [ ] Terminate whole process tree on timeout/cancel only through the live provider-owned handle.
- [ ] Await `waitForExit()` before settlement.
- [ ] Persist exit code/signal/timeout facts.
- [ ] Retain bounded log artifacts.
- [ ] Parse exactly one dedicated final-line JSON object.
- [ ] Require exactly configured metric key.
- [ ] Reject missing metric.
- [ ] Reject duplicate metric/result objects.
- [ ] Reject malformed JSON.
- [ ] Reject non-finite metric.
- [ ] Treat stdout as evidence, not agent authority.

## Baseline gate

- [ ] Run baseline on immutable starting commit before child creation.
- [ ] Record baseline attempt and artifacts durably.
- [ ] Complete target-reached without child when baseline meets target.
- [ ] Produce `baseline-blocked` on nonzero exit.
- [ ] Produce `baseline-blocked` on timeout.
- [ ] Produce `baseline-blocked` on signal.
- [ ] Produce `baseline-blocked` on malformed/missing/duplicate/non-finite metric.
- [ ] Produce `baseline-blocked` on evaluator/config provenance mismatch.
- [ ] Produce `baseline-blocked` on dirty protected surface/isolation failure.
- [ ] Ensure baseline-blocked has no best/candidate/acceptance decision.
- [ ] Ensure baseline attempt does not consume candidate experiment budget.

## Chunk 05 verification gate

- [ ] Test clean temporary Git repository setup.
- [ ] Test read-only repository discovery causes no lock/ref/worktree/index mutation and tracker creation precedes all such mutations.
- [ ] Test dirty caller work preservation.
- [ ] Test immutable `run_id` appears in branch/worktree identity.
- [ ] Test same repository/run-tag active exclusion.
- [ ] Test a later run may reuse a terminal run's tag while the prior run-id-bearing worktree is retained.
- [ ] Test independent run-tag worktrees.
- [ ] Test full-SHA lineage.
- [ ] Test staged protected-path violation.
- [ ] Test unstaged protected-path violation.
- [ ] Test untracked protected-path violation.
- [ ] Test dependency/submodule/config exceptional policies.
- [ ] Test candidate commit and rejected audit preservation.
- [ ] Test exact evaluator argv/cwd/env.
- [ ] Test stdout/stderr caps.
- [ ] Test nonzero/signal exit facts.
- [ ] Test wall-clock timeout.
- [ ] Test descendant-process termination through the live provider handle.
- [ ] Test cancellation idempotence.
- [ ] Test Git subprocess timeout, output caps, scrubbed environment, whole-tree termination, and awaited settlement.
- [ ] Test terminal persistence precedes lock release and stale terminal-owner lock recovery is idempotent.
- [ ] Test explicit worktree cleanup removes the registered worktree while retaining durable evidence.
- [ ] Test settlement waits for whole-tree quiescence.
- [ ] Test every baseline success/blocking outcome externally.

## Chunk 05 review gate

- [ ] Review every Git command for caller-worktree safety and argv use.
- [ ] Review mutable/protected policy for all staged/unstaged/untracked paths.
- [ ] Review evaluator for shell/secret/provenance/timeout risks.
- [ ] Review candidate evidence survives rejection and failure.

## Chunk 05 implementation commit gate

- [ ] Integrate parallel Git/evaluator lanes against frozen tracker/types APIs.
- [ ] Commit host Git/evaluator boundaries and focused real-behavior tests.

## Chunk 05 tracker-accounting gate

- [ ] Record Chunk 05 implementation commit full SHA after it exists.
- [ ] Commit the checklist update separately from the Chunk 05 implementation commit.

# Chunk 06 — `06-implement-recoverable-controller`

## Proposal agent (`src/agent.ts`)

- [ ] Create `src/agent.ts`.
- [ ] Create every proposal child directly with `ctx.agents.create`; do not route worktree-bound rounds through `ctx.subagents.start`.
- [ ] Generate a fresh `SessionId` for every proposal round.
- [ ] Persist canonical isolated worktree path in child `meta.cwd`.
- [ ] Set `parentSession`, origin, and delegation-depth metadata from `exec.agent`.
- [ ] Pass explicit `agentOptions.provider`, `model`, and optional `maxTokens`, inherited from the initiating Agent unless configured overrides apply.
- [ ] During `setup(childCtx)`, compose the required parent preset/policy surface before publication.
- [ ] During the same setup window, register an autoresearch-only schema-validating report tool in the child scope.
- [ ] Register a matching child-scoped system-prompt section that requires exactly one report-tool submission.
- [ ] Document in code/tests that `SubagentStartRequest` is unsuitable because it has no per-run cwd/session-meta hook, `agentOptions` cannot carry cwd, and prompt paths do not create isolation.
- [ ] Bound handoff size and report size.
- [ ] Supply immutable objective/policy, experiment number, best measured facts, bounded prior summary, and tracker-derived workspace facts.
- [ ] Instruct the child to inspect/edit only the isolated worktree represented by its durable cwd.
- [ ] Define the validated child report with hypothesis, intended edits, implementation summary, and optional blocker claim only.
- [ ] Exclude authoritative metric/status/command/Git decision fields.
- [ ] Drive the child with `followup(...)`, await `whenIdle()`, and reject missing, duplicate, malformed, stale, wrong-experiment, or oversized reports.
- [ ] Propagate controller cancellation through `agent.cancel(...)`.
- [ ] Always await `AgentHandle.dispose()` in `finally` on success, report failure, cancellation, controller failure, and unload; the host remains authoritative.

## Recovery (`src/recovery.ts`)

- [ ] Create `src/recovery.ts`.
- [ ] Resume by `run_id`, not branch/tag alone.
- [ ] Verify repository identity and start SHA.
- [ ] Verify immutable policy and evaluator/provenance hash.
- [ ] Verify run-id-bearing branch/worktree registration and current full HEAD.
- [ ] Verify unresolved experiment, artifact completeness, and recorded evaluator spawn/attempt facts.
- [ ] Within the same live provider session, use only the provider-owned handle for evaluator process-tree liveness/termination.
- [ ] After host restart, never signal a recorded PID without provider-supported stable identity proof stronger than PID reuse.
- [ ] Rerun an interrupted baseline/candidate evaluator only when durable/provider evidence proves the entire prior provider-owned process tree—parent and every descendant—is quiescent; parent death alone is insufficient.
- [ ] Mark missing whole-process-tree quiescence proof typed `blocked`; do not signal or duplicate evaluation.
- [ ] When safe rerun is proven, retain the interrupted baseline attempt, restore the isolated worktree to immutable start, and rerun the exact evaluator.
- [ ] When safe rerun is proven, restore recorded candidate commit for interrupted candidate evaluation and rerun without creating a new candidate.
- [ ] Recompute interrupted decision from durable measured facts.
- [ ] Idempotently restore expected accepted HEAD for committed decision.
- [ ] Never create duplicate candidate for unresolved experiment.
- [ ] Block on protected changes.
- [ ] Block on missing commits.
- [ ] Block on provenance mismatch.
- [ ] Block on ambiguous tracker state.
- [ ] Block on uncertain surviving evaluator.
- [ ] Block on external worktree/branch mutation.
- [ ] Preserve evidence before repair/reconciliation.

## Controller (`src/controller.ts`)

- [ ] Create `src/controller.ts`.
- [ ] Make `AutoresearchRunController` sole orchestration/state owner.
- [ ] Normalize and freeze run policy before execution.
- [ ] Allow only read-only repository/common-directory/start-SHA discovery before tracker creation.
- [ ] Create tracker/run row with discovered repository identity and start SHA before every mutating/allocating external setup effect.
- [ ] Persist intent before every external side effect.
- [ ] Persist observed outcome after every external side effect.
- [ ] Run baseline gate.
- [ ] Handle baseline-target shortcut.
- [ ] Request one fresh proposal at a time.
- [ ] Validate child-authored filesystem changes on host.
- [ ] Create candidate commit/audit record before evaluation.
- [ ] Execute independent evaluator on recorded candidate commit.
- [ ] Parse trusted metric on host.
- [ ] Compute strict minimize acceptance with `<`.
- [ ] Compute strict maximize acceptance with `>`.
- [ ] Reject ties.
- [ ] Reject regressions.
- [ ] Recompute target satisfaction after accepted result.
- [ ] Persist terminal experiment before next proposal.
- [ ] Stop at experiment budget.
- [ ] Surface proven post-baseline blocker separately.
- [ ] Surface infrastructure/contract failure as `round-failed`.
- [ ] Handle cancellation at a quiescent durable boundary.
- [ ] Remove `ctx.workflowEngine` production orchestration.
- [ ] Replace or remove the four workflow-based unit tests in `tests/autoresearch.spec.ts` during the controller clean cutover.
- [ ] Remove no-longer-used workflow runtime dependency/peer after cutover.
- [ ] Keep rejected candidate commits/audit refs.
- [ ] Reconcile isolated worktree to last durable accepted commit.

## Chunk 06 verification gate

- [ ] Test baseline-target shortcut spawns no child.
- [ ] Test strict accepted improvement.
- [ ] Test equal metric rejection.
- [ ] Test regression rejection.
- [ ] Test evaluator crash with proven prior whole-process-tree quiescence can safely rerun once.
- [ ] Test evaluator timeout.
- [ ] Test restart where only parent death is known becomes `blocked`, never signals the PID, and never duplicates execution while descendant survival is uncertain.
- [ ] Test policy violation.
- [ ] Test child blocker cannot self-authorize terminal status.
- [ ] Test child metric/status/command/Git fields cannot spoof authority.
- [ ] Test fresh `SessionId`, durable worktree `meta.cwd`, parent/delegation metadata, and explicit inherited provider/model/optional `maxTokens` on every child.
- [ ] Test child-scoped report tool/prompt registration, exact schema validation, and rejection of missing/duplicate/malformed/stale/wrong-experiment/oversized reports.
- [ ] Test `AgentHandle.dispose()` is awaited exactly once/idempotently for success, report failure, cancellation, controller failure, and unload.
- [ ] Test target behavior for minimize/maximize.
- [ ] Test budget-limited completion.
- [ ] Test resume from every safely reconcilable nonterminal run state.
- [ ] Test resume from every safely reconcilable nonterminal experiment state; uncertain survivor states block conservatively.
- [ ] Test no duplicate candidate creation during recovery.
- [ ] Test deterministic decision replay.
## Chunk 06 review gate

- [ ] Review controller as sole state machine; remove competing workflow logic.
- [ ] Review all intent/outcome ordering around side effects.
- [ ] Review acceptance/target logic for strict host authority.
- [ ] Review recovery for idempotence and evidence preservation.
- [ ] Review obsolete workflow code/dependencies/comments are removed.

## Chunk 06 implementation commit gate

- [ ] Integrate proposal/recovery lanes into controller.
- [ ] Confirm all prior callers migrated to the controller clean cutover.
- [ ] Commit recoverable controller and focused tests.

## Chunk 06 tracker-accounting gate

- [ ] Record Chunk 06 implementation commit full SHA after it exists.
- [ ] Commit the checklist update separately from the Chunk 06 implementation commit.

# Chunk 07 — `07-wire-tool-jobs-lifecycle-and-hmr`

## Plugin wiring (`src/index.ts`)

- [ ] Keep named exports only: `name`, `inject`, `Config`, `apply`.
- [ ] Inject `tools`.
- [ ] Inject `agents`.
- [ ] Inject `subprocess`.
- [ ] Inject `jobs`.
- [ ] Inject `systemPrompt`.
- [ ] Treat the tool execute body's `exec.agent` as the sole parent/session/workspace authority anchor; do not infer an ambient agent.
- [ ] Populate the durable `runs` agent/session identity from `exec.agent`.
- [ ] Register exactly one `autoresearch` tool through `ctx.tools.register`/`defineTool`.
- [ ] Add direct-human-request system guidance.
- [ ] Return canonical foreground result union.
- [ ] Start background jobs by default with `owner: exec.agent`.
- [ ] Honor explicit foreground mode.
- [ ] In the synchronous LocalJobRegistry `run()` callback, create the job-owned `AbortController`, idempotent cancellation hook, deferred execution gate, `done` promise, and readiness promise without starting controller work.
- [ ] Call `ctx.jobs.start`, receive the returned job id, and durably record it before releasing the deferred execution gate.
- [ ] Ensure failures before gate release settle `done` and readiness without orphaning resources.
- [ ] Run durable initialization under the job-owned signal after gate release; resolve readiness only after tracker, run-id-bearing branch, and worktree facts are committed.
- [ ] Return background `{ kind, runId, jobId, tracker, branch, worktree }` only from the readiness result.
- [ ] Return typed startup failure/cancellation when initialization fails before readiness; do not fabricate tracker/branch/worktree values.
- [ ] Declare `autoresearch` job kind through type augmentation.
- [ ] Use generic jobs control rather than private job tools.
- [ ] Require compatible jobs controller/tool composition.
- [ ] Map `target-reached`, `budget-limited`, and proven `blocked` to completed jobs.
- [ ] Map `baseline-blocked` and `round-failed` to failed jobs.
- [ ] Map plugin-internal cancellation to Harness job outcome status `killed` while preserving the plugin result variant `cancelled`.
- [ ] Ensure job `done` waits for controller/child-dispose/process/tracker/Git quiescence and resolves only after cleanup, not merely after cancellation is requested.
- [ ] Implement synchronous/idempotent job cancellation hook.
- [ ] Sever background lifetime from the outer tool call's `exec.signal` before releasing deferred controller execution.
- [ ] Pass the job-owned controller signal to `AutoresearchRunController`, child Agent cancellation, evaluator subprocesses, and Git subprocesses.
- [ ] Persist cancellation intent before aborting resources.
- [ ] Await `AgentHandle.dispose()`, entire owned process-tree termination, and worktree reconciliation.
- [ ] Atomically persist terminal cancellation/quiescent facts without deleting evidence.
- [ ] Release repository/run-tag active lock only after terminal persistence, as the final idempotent operation.
- [ ] Remove tool registration on plugin disposal/HMR.
- [ ] Remove prompt contribution on plugin disposal/HMR.
- [ ] Settle active controllers/children/evaluators/jobs on disposal/HMR.
- [ ] Add no redundant durable Harness session event.

## Bundle/composition

- [ ] Retain stable patch row id `autoresearch`.
- [ ] Retain module name `dsh-autoresearch`.
- [ ] Retain complete Loader defaults in patch config.
- [ ] Document/validate installed profile requires jobs registry plus `dsh-tool-jobs`.
- [ ] Document/validate subprocess provider requirement.
- [ ] Document/validate core Agent registry/runtime and child setup requirement; no subagent provider is required.
- [ ] Ensure activation is opt-in through profile installation.
- [ ] Ensure service ordering is expressed by injection, not YAML row order.

## Chunk 07 verification gate

- [ ] Test foreground tool result.
- [ ] Test background tool result waits for durable readiness facts.
- [ ] Test LocalJobRegistry ordering: `run()` remains synchronous, controller work stays gated until returned job id is durably recorded, then starts under the job-owned signal.
- [ ] Test typed initialization failure/cancellation before readiness and no orphaned resources.
- [ ] Test background job output consumption.
- [ ] Test generic job list/output/kill compatibility.
- [ ] Test jobs-controller absence fails clearly.
- [ ] Test missing/incompatible core Agent registry/runtime or child setup capability fails clearly.
- [ ] Test cancellation idempotence.
- [ ] Test a registered background job survives the outer tool call's `exec.signal` abort.
- [ ] Test child creation derives `parentSession`/delegation/model route from `exec.agent`, background job start receives `owner: exec.agent`, and the tracker records the same authority identity.
- [ ] Test fresh child durable cwd is the canonical isolated worktree and differs from the caller workspace.
- [ ] Test plugin cancellation maps to Harness job status `killed`.
- [ ] Test cancellation/job completion waits for mandatory Agent handle disposal and whole-process-tree quiescence.
- [ ] Test job status mapping for every terminal run status.
- [ ] Test HMR/unload removes tool.
- [ ] Test HMR/unload removes prompt.
- [ ] Test HMR/unload settles active resources.

## Chunk 07 review gate

- [ ] Review lifecycle/disposal symmetry for every registration/resource.
- [ ] Review job completion is not reported before durable settlement.
- [ ] Review canonical result data is not replaced by prose.
- [ ] Review plugin does not modify DeepSeek Harness AgentLoop.

## Chunk 07 implementation commit gate

- [ ] Commit tool/jobs/lifecycle/HMR wiring and focused tests.

## Chunk 07 tracker-accounting gate

- [ ] Record Chunk 07 implementation commit full SHA after it exists.
- [ ] Commit the checklist update separately from the Chunk 07 implementation commit.

# Chunk 08 — `08-add-real-dsh-composition-and-recovery-tests`

## Real Harness composition

- [ ] Replace the fixed-report workflow integration test and replace/remove the four workflow-based unit tests in `tests/autoresearch.spec.ts`.
- [ ] Compose real Loader/app agent stack in process.
- [ ] Include tools registry.
- [ ] Include system-prompt registry.
- [ ] Include jobs registry and generic jobs tools.
- [ ] Include subprocess provider.
- [ ] Include core Agent registry/runtime capable of `ctx.agents.create` and child-scoped setup.
- [ ] Mock only model proposal content.
- [ ] Observe tool registration through real composition.
- [ ] Observe prompt guidance through real composition.
- [ ] Exercise host filesystem/Git validation.
- [ ] Exercise real evaluator fixture.
- [ ] Exercise background publication/collection/cancellation.
- [ ] Verify persisted transcript/tool/job lifecycle.
- [ ] Verify HMR removal through real composition.

## Bundle/profile and failure composition

- [ ] Parse `cordis.patch.yml` through Harness schema.
- [ ] Verify stable id/module/config.
- [ ] Boot keyless assembled profile snapshot.
- [ ] Verify missing `dsh-tool-jobs` fails clearly.
- [ ] Verify missing subprocess provider fails clearly.
- [ ] Verify missing/incompatible Agent registry/runtime or child setup capability fails clearly.
- [ ] Verify no missing-service path hangs.

## Recovery/concurrency integration

- [ ] Test deliberate interruption during baseline where entire prior evaluator process-tree quiescence is proven and safe rerun occurs once.
- [ ] Test deliberate interruption during candidate evaluation where entire prior evaluator process-tree quiescence is proven and safe rerun occurs once.
- [ ] Test restart without proof that every prior evaluator descendant is quiescent blocks without PID signalling or duplicate execution, including the parent-dead/descendant-uncertain case.
- [ ] Test deliberate interruption during decision.
- [ ] Test safely reconcilable resume completes without duplicate candidate.
- [ ] Test same repository/run-tag active exclusion.
- [ ] Test later same-tag reuse with retained prior run-id-bearing worktree.
- [ ] Test two independent run tags concurrently.
- [ ] Verify separate immutable run-id-bearing worktrees/branches.
- [ ] Verify no caller HEAD/index/ledger interference.
- [ ] Verify serialized promotion/tracker updates.
- [ ] Test plugin/HMR disposal with active child/evaluator and mandatory Agent handle disposal plus whole-process-tree quiescence.

## Chunk 08 verification gate

- [ ] Observe actual Loader exposes `autoresearch` tool.
- [ ] Observe actual Loader contributes guidance.
- [ ] Observe temporary repository tracker/Git/evaluator/job facts end to end.
- [ ] Observe concurrent run isolation.
- [ ] Observe same-tag collision block.
- [ ] Observe interrupted run resumes successfully.
- [ ] Run focused per-file coverage expected by project policy.

## Chunk 08 review gate

- [ ] Review tests assert observable contracts rather than source/plumbing.
- [ ] Review only model proposal content is mocked.
- [ ] Review fixtures use real Git/subprocess/SQLite boundaries.
- [ ] Review all terminal and recovery paths clean resources deterministically.

## Chunk 08 implementation commit gate

- [ ] Commit real DSH composition/recovery/concurrency tests and required defect fixes.

## Chunk 08 tracker-accounting gate

- [ ] Record Chunk 08 implementation commit full SHA after it exists.
- [ ] Commit the checklist update separately from the Chunk 08 implementation commit.

# Chunk 09 — `09-complete-docs-and-release-gate`

## Documentation

- [ ] Rewrite README from prompt-enforced workflow description to host-enforced controller contract.
- [ ] Document installation with `dsh plugin --profile <name> add <package-or-tarball>`.
- [ ] Document profile composition prerequisites.
- [ ] Document opt-in activation and stable patch row.
- [ ] Document every deployment configuration field/default/limit.
- [ ] Document immutable tool/run policy inputs.
- [ ] Document argv evaluator format.
- [ ] Document strict final-line JSON metric protocol.
- [ ] Document minimize/maximize strict improvement and tie rejection.
- [ ] Document baseline and `baseline-blocked` semantics.
- [ ] Document state root/tracker/artifact/TSV locations.
- [ ] Document SQLite authority and TSV compatibility-only role.
- [ ] Document dedicated branch/worktree and caller-worktree safety.
- [ ] Document candidate commits/audit refs for accepted/rejected work.
- [ ] Document recovery/resume by `run_id` and immutable run-id-bearing branch/worktree identity.
- [ ] Document evaluator spawn PID/attempt evidence, the prohibition on post-restart PID-only signalling, safe rerun only with proof the entire provider-owned process tree is quiescent, parent-death insufficiency, and uncertain-descendant `blocked` behavior.
- [ ] Document interruption handling and other blocked reconciliation cases.
- [ ] Document cancellation, mandatory Agent handle disposal, terminal persistence before lock release, and quiescent job completion.
- [ ] Document retention/explicit cleanup policy and same-tag reuse with retained run-id-bearing worktrees.
- [ ] Document canonical foreground/background/run result unions.
- [ ] Document security boundary: host authority, argv, environment, mutable scope, provenance.
- [ ] Document whole-row patch override behavior.
- [ ] Document migration from recovered 0.1.0 workflow behavior.
- [ ] Add complete temporary-repository example matching actual schema/defaults.

## Final package/release gate

- [ ] Finalize repository/homepage/bugs/keywords/publishConfig metadata.
- [ ] Verify ESM root export.
- [ ] Verify `./invariant` export.
- [ ] Verify explicit files allowlist.
- [ ] Verify README/LICENSE/patch/lib/package.json present in tarball.
- [ ] Verify no source-only local paths.
- [ ] Verify no runtime local-link dependency closure.
- [ ] Run clean registry-backed frozen install.
- [ ] Run typecheck.
- [ ] Run focused unit/behavior/integration tests.
- [ ] Run required coverage gate.
- [ ] Run build.
- [ ] Run actual pack.
- [ ] Inspect packed manifest and contents.
- [ ] Install tarball into separate consumer/profile fixture without Harness checkout.
- [ ] Run `dsh plugin --profile <name> add <tarball-or-package>` against the packed artifact.
- [ ] Run `dsh --profile <name> --dump-config` and observe the `autoresearch` row/defaults.
- [ ] Load plugin from installed profile.
- [ ] Execute temporary-repository smoke run.

## Final smoke observations

- [ ] Observe caller worktree remains unchanged.
- [ ] Observe immutable run-id-bearing dedicated worktree and branch created.
- [ ] Observe read-only repository discovery followed by tracker creation before any mutating setup or baseline.
- [ ] Observe baseline row recorded.
- [ ] Observe one accepted candidate with full SHA/audit record.
- [ ] Observe one rejected candidate with full SHA/audit record.
- [ ] Observe strict metric decision.
- [ ] Observe atomic deterministic TSV export.
- [ ] Observe deferred background readiness and output through generic jobs control.
- [ ] Observe mandatory Agent handle disposal and cancellation resource cleanup, entire evaluator process-tree quiescence, terminal persistence before lock release, and retained evidence.
- [ ] Deliberately interrupt evaluation and prove the entire prior provider-owned process tree is quiescent.
- [ ] Resume by run id and observe completion without duplicate candidate.
- [ ] Separately simulate restart without whole-process-tree quiescence proof and observe typed `blocked` without signalling the recorded PID or duplicating evaluation.

## Chunk 09 review gate

- [ ] Review documentation examples against actual schemas/defaults.
- [ ] Review security/recovery statements against verified behavior.
- [ ] Review packed artifact independently of source tree.
- [ ] Review no implementation/reference still describes workflowEngine as authority.
- [ ] Review no obsolete aliases/shims/dependencies/comments remain.

## Chunk 09 implementation commit gate

- [ ] Commit documentation, metadata finalization, and release fixtures.

## Chunk 09 tracker-accounting gate

- [ ] Record Chunk 09 implementation commit full SHA after it exists.
- [ ] Confirm Chunk 09 implementation plus all Chunk 01–08 implementation commits and their separate tracker-accounting commits are reviewable; do not require the not-yet-created Chunk 09 accounting commit to confirm itself.
- [ ] Commit the Chunk 09 checklist update separately from the implementation commit.

# Final split review

## Review A — Safety, correctness, and recovery

- [ ] Re-review caller-worktree non-mutation.
- [ ] Re-review worktree/branch/lock concurrency.
- [ ] Re-review mutable/protected path enforcement.
- [ ] Re-review evaluator shell/env/provenance/timeout/process-tree safety.
- [ ] Re-review strict metric/acceptance/target behavior.
- [ ] Re-review transactional intent/outcome ordering.
- [ ] Re-review recovery from every nonterminal state.
- [ ] Re-review cancellation/HMR quiescence.
- [ ] Re-review rejected/failed evidence retention.
- [ ] Confirm child reports cannot become authoritative state.

## Review B — DSH integration, packaging, and documentation

- [ ] Re-review named Cordis exports and exact injected services.
- [ ] Re-review tool/systemPrompt/agents/subprocess/jobs seams.
- [ ] Re-review generic jobs control and status mapping.
- [ ] Re-review stable patch id/module/complete defaults.
- [ ] Re-review profile prerequisites and failure messages.
- [ ] Re-review peer/dev dependency identities.
- [ ] Re-review packed manifest/content and consumer install.
- [ ] Re-review README/config/examples against actual behavior.
- [ ] Confirm AgentLoop was not modified.
- [ ] Confirm no redundant durable Harness event was introduced.

# Unchecked-item classification before release

After both final reviews above are performed and every review checkbox is checked, inspect only remaining unchecked implementation/evidence items in Chunks 01–09. Final-review checkboxes and the instructions in this section are outside the classification candidate set.

For each candidate that remains `[ ]`, replace it with exactly one auditable classification form:

- `- [ ] original text — BLOCKER: rationale` — required behavior/evidence is missing; release cannot proceed.
- `- [ ] original text — DEFERRED: approval-ref; rationale` — non-required future work only, with prior recorded user/maintainer approval identified by `approval-ref`; an item may never be deferred merely to ship.
- `- [~] original text — OBSOLETE: rationale` — superseded by a documented clean-cutover decision; keep the entry in place with this non-checkbox marker.
- `- [ ] original text — EXTERNAL: named unavailable prerequisite; attempted evidence and reachable work completed` — the unavailable prerequisite does not waive a required item; required `EXTERNAL` items block release until completed.

Then mechanically inspect Chunks 01–09: every remaining `- [ ]` line must contain exactly one of `BLOCKER:`, `DEFERRED:`, or `EXTERNAL:`; every obsolete line must use `- [~]` and exactly one `OBSOLETE:`; no entry may contain multiple classification tokens. Release may be declared only when this check is recorded, every `DEFERRED` item names prior recorded approval and is non-required, no required `EXTERNAL` item remains incomplete, no candidate is unclassified or multiply classified, no `BLOCKER` remains, and final evidence exactly matches the commands/scenarios actually exercised.

## Final release-accounting commit gate

- [ ] After Chunk 09 accounting, both final reviews, and the classification pass are complete, record the exact implementation/accounting commit set and final release evidence in `CHECKLIST.md`.
- [ ] Confirm every required item is complete, no required `EXTERNAL` remains, and every `DEFERRED` item has prior recorded approval.
- [ ] Commit this final release accounting separately; release is blocked until the commit exists.
