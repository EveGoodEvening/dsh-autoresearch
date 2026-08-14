# dsh-autoresearch Implementation Checklist

## Status rules

- `[x]` means verified in the current worktree or completed research/planning evidence.
- `[ ]` means not present or not verified in the current worktree.
- Archived implementation activity was historical evidence only until the authoritative snapshot was recovered. Chunk 01 is now closed by implementation commit `3ca85a17c03d15488269b3dbc339e3ec135d98c3`, tracker-accounting commit `4095697a6b7256937f535d739ca09678b47e333d`, review-fix commit `6524bdf`, and a clean independent correctness/accounting/security re-review after `6524bdf` with zero findings.
- **Current dependency-ready chunk: `06-implement-recoverable-controller`.** Chunk 02 is closed by implementation commit `cf4302c0197d4dc7f77a15cc5230abf9f6d74fc4`, tracker-accounting commit `fa4bf06ef24b590a81f883037b940f18d97c5cfc`, review-fix commit `7671499`, focused clean-generated-state verification, and clean independent package/accounting re-reviews. Chunk 03 is closed by implementation commits `9b18630` and `e22d99a`, tracker-accounting commit `99babc5dc3432be7c078fd6e792c97164ebfb19b`, review-fix commit `5e990acb1df3bcf8b7e2612c91f38443d364d2db`, passing post-fix frozen-install/typecheck/3-file-54-test/build/pack gates, and a clean independent correctness/security/accounting re-review. Chunk 04 is closed by implementation commit `cfc2e45366961c10b97b6fab63ffea9abfb3b5dd`, tracker-accounting commit `a1fca4c61fbf241b716a8e423a12788d16e3c71d`, review-fix commits `c9ba821923cd233c8c3112a7b3cdd2b8d311ec36`, `5ada9cd`, and `e7fb2e6`, passing final typecheck/4-file-79-test/build gates, completed correctness/security/concurrency/accounting reviews, a frozen tracker API, and a clean final re-review. Chunk 05 is closed by its recorded implementation/review-fix commits, final clean Git/evaluator/security/tracker-concurrency reviews, and final tracker/accounting commit `89f50fba279e8c2156394763f1357bd9377996b7`.

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

# Chunk 02 — `02-fix-publishability-and-package-contract` (CLOSED)

## Package/dependency work

- [x] Confirm registry compatibility for public `@deepseek-ai/schemastery` beginning at `^3.18.1`; the frozen registry-backed install resolved `3.18.1`.
- [x] Replace the runtime repository-local Schemastery `link:` with the public `^3.18.1` range.
- [x] Regenerate `pnpm-lock.yaml` from registry metadata.
- [x] Add `@deepseek-ai/dsh-subprocess` as peer dependency.
- [x] Add/mirror `@deepseek-ai/dsh-subprocess` as development dependency for source development.
- [x] Add `@deepseek-ai/dsh-tool-jobs` as a peer dependency.
- [x] Add/mirror `@deepseek-ai/dsh-tool-jobs` as a development dependency for source development.
- [x] Confirm the public core Agent registry/runtime dependency identity that provides `ctx.agents.create` and add publishable `@deepseek-ai/dsh-agent` peer/development ranges; no unpublished source import was added.
- [x] Keep Cordis and DSH service identities as publishable peer dependencies mirrored for development rather than bundled private copies. The current-runtime workflow/subagent dependencies remain temporarily as publishable peer/development dependencies to keep the intermediate tree green and are removed at the controller cutover.
- [x] Retain Node engine `^22.19.0 || >=24.0.0`.

## Publication contract

- [x] Add/review repository metadata.
- [x] Add/review homepage metadata.
- [x] Add/review bugs metadata.
- [x] Add/review keywords.
- [x] Add/review `publishConfig`.
- [x] Retain license metadata and include `LICENSE`.
- [x] Add `src/invariant.ts` as the package-owned invariant companion source required for `./invariant`.
- [x] Export built package root from `lib`.
- [x] Export `./invariant` from built `lib`.
- [x] Export `./package.json`.
- [x] Include `cordis.patch.yml`, README, LICENSE, and required built files in the explicit `files` allowlist.
- [x] Retain `"dsh":{"bundle":{"patch":"./cordis.patch.yml"}}`.
- [x] Ensure scripts are tarball-safe and do not assume a Harness source checkout; remove the pack/install-time `prepare` build.
- [x] Ensure packed/install-time behavior does not depend on unapproved build scripts; fresh external tarball installation succeeded without a Harness checkout.

## Chunk 02 verification gate

- [x] Perform a clean frozen registry-backed install; it succeeded with a registry-resolvable lock.
- [x] Build package outputs needed for packing; typecheck passed, 2 files / 5 tests passed, and the standalone build passed.
- [x] Run actual package pack; `pnpm pack` produced `dsh-autoresearch-0.1.0.tgz`.
- [x] Inspect the packed package contract for zero runtime `link:` values.
- [x] Inspect the packed package contract for zero runtime `workspace:` values.
- [x] Inspect tarball contents for the built `./invariant` declaration, declaration map, JavaScript, and source map; the packed contract also retains the root/package exports and explicit patch, README, and LICENSE allowlist.
- [x] Install the tarball into a fresh external temporary consumer with no Harness source checkout; `pnpm add dsh-autoresearch-0.1.0.tgz` succeeded and resolved registry packages including `@deepseek-ai/schemastery@3.18.1` and DSH `0.1.0-rc.6` packages.
- [x] Import package root in the fresh external consumer fixture; Node ESM imported `dsh-autoresearch` successfully and printed `imports-ok`.
- [x] Import `./invariant` in the fresh external consumer fixture; Node ESM imported `dsh-autoresearch/invariant` successfully and printed `imports-ok`.

## Chunk 02 review gate

Implementation commit `cf4302c0197d4dc7f77a15cc5230abf9f6d74fc4` landed before the required independent review gate. The post-commit review/fix closure repaired that process miss with review-fix commit `7671499`, focused verification, and clean independent re-review.

- [x] Review dependency identity and peer/dev mirroring.
- [x] Review packed manifest rather than only source manifest.
- [x] Review absence of source-only paths/local links.
- [x] Review scope: no controller/tracker redesign mixed into packaging fix.

## Chunk 02 implementation commit gate

- [~] Confirm every Chunk 02 required pre-commit item is complete. — OBSOLETE: this historical pre-commit assertion was permanently missed because `cf4302c0197d4dc7f77a15cc5230abf9f6d74fc4` landed before independent review; it was not performed and is replaced by the auditable post-commit review/fix, verification, and re-review evidence recorded below.
- [x] Commit publishability/package contract separately from recovery and redesign as `cf4302c0197d4dc7f77a15cc5230abf9f6d74fc4` (`fix(package): make autoresearch plugin publishable`).

## Chunk 02 tracker-accounting gate

- [x] Record Chunk 02 implementation commit full SHA after it exists: `cf4302c0197d4dc7f77a15cc5230abf9f6d74fc4`.
- [x] Commit the checklist update separately from the Chunk 02 implementation commit as tracker-accounting commit `fa4bf06ef24b590a81f883037b940f18d97c5cfc`.

## Chunk 02 post-commit closure

- [x] Record the review-fix commit: `7671499`.
- [x] Verify the review fix from clean generated state: focused typecheck passed, the 2-file / 5-test suite passed, and the prepack build and pack passed.
- [x] Complete independent package re-review after `7671499`; all four Chunk 02 review lenses were clean.
- [x] Complete independent accounting re-review; the remaining Chunk 02 accounting finding is addressed by the obsolete historical assertion and replacement post-commit evidence above.
- [x] Close Chunk 02 only after its implementation, tracker-accounting, review-fix, focused verification, package re-review, and accounting re-review evidence is recorded.

# Chunk 03 — `03-define-discriminated-contract-and-config` (CLOSED)

## Types and canonical results

- [x] Create `src/types.ts`.
- [x] Define immutable normalized run policy.
- [x] Define full run, experiment, attempt, artifact, transition, and provenance identities.
- [x] Define run durable states.
- [x] Define experiment durable states.
- [x] Define `AutoresearchToolResult` background-ready variant.
- [x] Define `AutoresearchToolResult` typed background-start-failed variant for initialization failure/cancellation before readiness.
- [x] Define `AutoresearchToolResult` foreground variant.
- [x] Define `target-reached` run result.
- [x] Define `budget-limited` run result.
- [x] Define `baseline-blocked` run result that forbids `best`.
- [x] Define post-baseline `blocked` run result requiring current best and evidence.
- [x] Define `round-failed` run result with best only when established.
- [x] Define quiescent `cancelled` run result.
- [x] Define separately discriminated experiment results.
- [x] Require full commit and parent SHAs where applicable.
- [x] Reject unknown keys and impossible required/forbidden combinations at decode boundaries.
- [x] Enforce finite metrics.
- [x] Enforce target/best/report consistency.
- [x] Enforce bounded serialized result size.

## Configuration

- [x] Create `src/config.ts`.
- [x] Export Schemastery `Config`.
- [x] Materialize defaults at Loader time.
- [x] Implement explicit semantic/cross-field resolver.
- [x] Add optional child `provider`, `model`, and `maxTokens` overrides with initiating-Agent inheritance as the default.
- [x] Add `gitExecutable`.
- [x] Add `stateRoot` default below repository Git common directory.
- [x] Add `branchPrefix`.
- [x] Add `defaultMaxExperiments`.
- [x] Add `maxExperiments`.
- [x] Add `maxHandoffChars`.
- [x] Add `maxResultChars`.
- [x] Add `maxStdoutBytes`.
- [x] Add `maxStderrBytes`.
- [x] Add `defaultTimeoutMs`.
- [x] Add `maxTimeoutMs`.
- [x] Add positive `terminationGraceMs`.
- [x] Add `maxActiveRunsPerRepository`.
- [x] Add artifact retention settings.
- [x] Add worktree retention and explicit cleanup settings.
- [x] Add TSV export/retention settings.
- [x] Define tool repository/cwd input.
- [x] Define run tag or resume id input.
- [x] Define objective and constraints inputs.
- [x] Define mutable globs and exceptional allowlists.
- [x] Define argv evaluation `{ command, args, cwd? }`.
- [x] Define the canonical argv evaluation contract; removal of temporary legacy `evaluation_command` runtime compatibility is explicitly deferred to the Chunk 06 clean cutover.
- [x] Define metric name and minimize/maximize direction.
- [x] Define timeout and experiment cap.
- [x] Define optional target.
- [x] Define evaluator/dataset provenance inputs.
- [x] Define explicit environment overrides.
- [x] Define foreground/background mode.

## Rendering and patch

- [x] Create `src/render.ts`.
- [x] Implement pure bounded renderers only.
- [x] Keep renderers out of decision/persistence logic.
- [x] Update `cordis.patch.yml` stable row id to/retain `autoresearch`.
- [x] Update patch module name to/retain `dsh-autoresearch`.
- [x] Materialize complete explicit defaults in the patch row.
- [x] Define the canonical public patch/tool schema; removal of temporary workflow-specific runtime compatibility is explicitly deferred to the Chunk 06 clean cutover.

- [x] Record Chunk 03 pre-review implementation verification: `pnpm run typecheck` passed; Vitest passed 3 files / 26 tests for the then-current contract, configuration, and rendering invariants; `pnpm run build` passed. This was pre-review evidence, not complete post-review closure evidence.
- [x] Record the intentional intermediate compatibility state: temporary internal legacy runtime compatibility remains solely to keep the workflow runtime green until the Chunk 06 clean cutover; its later removal is tracked as a distinct Chunk 06 item and is not a Chunk 03 failure.

## Chunk 03 verification gate

- [x] Test every config default.
- [x] Test configured upper/lower limits.
- [x] Test all cross-field validation.
- [x] Test immutable normalization/snapshot behavior.
- [x] Test every run result variant.
- [x] Test every experiment result variant.
- [x] Test baseline-blocked forbids `best`.
- [x] Test blocked requires post-baseline best and evidence.
- [x] Test target threshold recomputation for minimize.
- [x] Test target threshold recomputation for maximize.
- [x] Test finite metric rejection.
- [x] Test exact-key/unknown-key rejection.
- [x] Test bounded result rendering/serialization.
- [x] Parse patch with Harness `entryListSchema`.
- [x] Verify whole-row patch defaults are complete.

## Chunk 03 review gate

- [x] Review unions for impossible states.
- [x] Review public JSON for losslessness and Code Mode usability.
- [x] Review config authority: evaluator policy is host input, never child output.
- [x] Review module boundaries and remove duplicated old contract code.

## Chunk 03 implementation commit gate

- [x] Confirm all callers/tests affected by the Chunk 03 canonical contract are updated; temporary legacy runtime removal remains a separate Chunk 06 clean-cutover item.
- [x] Commit contracts/config/render/patch as reviewable implementation commits: `9b18630` (`feat(contract): define autoresearch contracts and config`) and `e22d99a` (focused contract/config/render invariant tests).

## Chunk 03 tracker-accounting gate

- [x] Record Chunk 03 implementation commits: `9b18630` and `e22d99a`.
- [x] Commit the checklist update separately from the Chunk 03 implementation commit as tracker-accounting commit `99babc5dc3432be7c078fd6e792c97164ebfb19b`.

## Chunk 03 review closure

- [x] Record review-fix commit `5e990acb1df3bcf8b7e2612c91f38443d364d2db`.
- [x] Record post-fix gates: frozen install passed; typecheck passed; Vitest passed 3 files / 54 tests; build passed; pack passed.
- [x] Complete an independent correctness, security, and accounting re-review after `5e990acb1df3bcf8b7e2612c91f38443d364d2db`; the re-review returned clean with zero findings.
- [x] Close Chunk 03 only after its implementation, tracker-accounting, review-fix, post-fix verification, and clean re-review evidence is recorded.

# Chunk 04 — `04-create-durable-tracker` (CLOSED)

## SQLite schema and repositories

- [x] Create `src/tracker.ts`.
- [x] Use built-in `node:sqlite`.
- [x] Verify exact `node:sqlite` APIs on the supported Node engine floor.
- [x] Create explicit schema version table/metadata.
- [x] Enable foreign keys on every connection.
- [x] Enable WAL.
- [x] Create `runs` table with complete identity, policy, state, timestamps, and best/terminal facts.
- [x] Create `experiments` table with full lineage, command, exit, metric, decision, and failure facts.
- [x] Create `artifacts` table with kind/location/size/hash/ownership/retention facts.
- [x] Create `transitions` table with monotonic sequence and from/to intent/outcome facts.
- [x] Add required indexes and uniqueness constraints.
- [x] Implement first-use atomic creation after allowed read-only repository/common-directory/start-SHA discovery.
- [x] Implement idempotent reopen.
- [x] Implement forward transactional migrations only.
- [x] Refuse unknown newer schema with typed `blocked` reason.
- [x] Store discovered repository identity and immutable start SHA in the initial run row.
- [x] Require initial run creation before lock acquisition, ref/branch/worktree allocation, evaluator spawn, or any other mutating/allocating setup side effect.
- [x] Implement transactional state-transition validation.
- [x] Implement atomic transition plus associated facts/artifact references.
- [x] Keep agent/process waits outside transactions.
- [x] Implement immutable policy/provenance snapshots.
- [x] Implement repository/run-tag active-lock identity and immutable run-id-bearing branch/worktree records needed for reconciliation.
- [x] Persist evaluator spawn intent, provider-observed PID, and attempt facts; document PID as diagnostic only without provider-supported stable recovery identity.
- [x] Implement queries for unresolved experiment and conservative recovery state, including terminal-owner stale-lock release.
- [x] Implement deterministic TSV compatibility export.
- [x] Rebuild TSV atomically after terminal experiment commits.
- [x] Ensure TSV is never read as recovery/decision authority.

## Chunk 04 verification gate

- [x] Test first tracker creation after read-only repository discovery.
- [x] Test foreign keys enabled.
- [x] Test WAL enabled.
- [x] Test idempotent reopen.
- [x] Test forward migration.
- [x] Test refusal of newer schema.
- [x] Test monotonic transition ordering.
- [x] Test invalid transition rejection.
- [x] Test atomic experiment/result/artifact writes.
- [x] Test crash between persisted intent and observed outcome.
- [x] Test transaction rollback leaves no partial authority.
- [x] Test evaluator spawn intent/PID/attempt persistence.
- [x] Test terminal state is durable before lock release and a stale lock owned by a terminal run is safely releasable.
- [x] Test deterministic TSV export.
- [x] Test TSV rebuild from SQLite.
- [x] Test recovery succeeds with TSV absent/corrupted.

- [x] Record final Chunk 04 verification after all review fixes, superseding the earlier 4-file / 61-test and 4-file / 70-test evidence: `pnpm run typecheck` passed; Vitest passed 4 files / 79 tests; `pnpm run build` passed.

## Chunk 04 review gate

- [x] Review transaction boundaries for no awaits/external side effects.
- [x] Review constraints/indexes against recovery queries.
- [x] Review source-of-truth rule: SQLite authoritative, TSV derived.
- [x] Review schema captures every required provenance/exit/artifact fact.

## Chunk 04 implementation commit gate

- [x] Confirm tracker API is frozen enough for Git/evaluator lanes.
- [x] Commit tracker and focused tests as `cfc2e45366961c10b97b6fab63ffea9abfb3b5dd` (`feat(tracker): add durable autoresearch state`).

## Chunk 04 tracker-accounting gate

- [x] Record Chunk 04 implementation commit full SHA after it exists: `cfc2e45366961c10b97b6fab63ffea9abfb3b5dd`.
- [x] Commit the checklist update separately from the Chunk 04 implementation commit as tracker-accounting commit `a1fca4c61fbf241b716a8e423a12788d16e3c71d`.

## Chunk 04 review closure

- [x] Record review-fix commits `c9ba821923cd233c8c3112a7b3cdd2b8d311ec36`, `5ada9cd`, and `e7fb2e6`.
- [x] Complete correctness, security, concurrency, and accounting reviews after the review fixes.
- [x] Complete a final independent re-review after `e7fb2e6`; the re-review returned clean with zero findings.
- [x] Close Chunk 04 only after its implementation, tracker-accounting, review-fix, final verification, tracker API freeze, completed reviews, and clean final re-review evidence is recorded.

# Chunk 05 — `05-build-host-git-and-evaluator-boundaries` (CLOSED)

## Supported threat model and Harness limit

- [x] Treat model-authored edits/reports, repository/worktree/config mutations, evaluator output, cancellation, and host crashes as untrusted and in scope.
- [x] Treat the DSH subprocess provider, configured Git binary, configured evaluator selection, controller code, OS/kernel, and owner-only state root as trusted deployment/runtime inputs.
- [x] Record that `ctx.subprocess.spawn` receives argv and a string `cwd`; Chunk 05 validates canonical non-symlink cwd/worktree/file identities immediately before and after spawn, terminates through the provider handle, and awaits provider-observable tree quiescence.
- [x] Do not claim fd-bound cwd, immutable mounts, observation of deliberate daemon/`setsid` escape, or protection from an independent hostile same-UID racer. Such deployments require an external sandbox/read-only execution provider and cannot reuse the Chunk 05 claim.

## Git boundary (`src/git.ts`)

- [x] Create `src/git.ts`.
- [x] Perform read-only caller repository, Git common directory, repository identity, and immutable start-SHA discovery before tracker creation; make no lock/ref/worktree/index mutation during discovery.
- [x] Resolve the deployment-only `gitExecutable` once through `ctx.subprocess.resolveExecutable`, reuse the canonical provider path, include it in immutable provenance, and forbid child-selected or relative-with-separator executable guesses.
- [x] Invoke the resolved Git executable through `ctx.subprocess` with argv and a timeout for every call.
- [x] Require positive termination grace, short-circuit pre-aborted calls, terminate the live provider-observable Git process tree on timeout/cancellation, await `waitForExit()`, and enforce stdout/stderr byte caps.
- [x] Remove ambient `GIT_*`, expose only a typed minimal override surface, and make mandatory Git safety variables non-overridable.
- [x] Preflight common/worktree configuration before checkout/allocation; reject includes and applicable executable helpers, and neutralize hooks/fsmonitor for every invocation. Exceptional config-path allowlisting permits file mutation only, never executable helpers.
- [x] Acquire repository/run-tag active exclusion only after the tracker/run row exists and enforce `maxActiveRunsPerRepository`.
- [x] Create dedicated run-id-bearing branch/worktree identities; use `runTag` only as the active exclusion key so a later run can reuse a terminal run's tag.
- [x] Reject branch/worktree identity collision unless resuming the same `run_id`; on same-run resume, verify registered path, branch/HEAD/start commit, and accepted ref before repair/allocation.
- [x] Never checkout/reset/stage/clean the caller worktree; preserve caller staged, unstaged, and untracked work.
- [x] Inspect staged, unstaged, untracked, and ignored state; enforce mutable/protected/dependency/submodule/evaluator/dataset/policy/config rules; stage only validated paths.
- [x] Expose exact start/candidate worktree verification for full commits, including branch/HEAD/ref identity, index and tracked bytes, and absence of untracked/ignored extras.
- [x] Create every candidate as a deterministic full commit, record full parent/candidate SHAs, and retain accepted/rejected audit refs across rejection, failed publication, later promotion, and explicit cleanup.
- [x] Expose typed inspect/prepare/publish reconciliation operations: prepare worktree/index without moving accepted refs, verify exact state, then atomically publish branch plus accepted ref; rejection restore/cleanup is retryable after audit evidence exists.
- [x] Block unexpected state without durable repair authorization; leave the end-to-end durable reconciliation-intent/restart proof to Chunk 06.
- [x] Reject active-lock release unless its owning run is durably terminal and quiescent; leave proof that release is the controller's final idempotent repository action to Chunk 06.
- [x] Recover and release a stale lock only when its owning run is durably terminal.
- [x] Implement explicit configured worktree removal/release without deleting tracker, artifact, commit, or audit-ref evidence; never use destructive reset as the sole provenance record.

## Evaluator boundary (`src/evaluator.ts`)

- [x] Create `src/evaluator.ts`; represent evaluation as command plus argv, never a shell line.
- [x] Own a structured-cloned, deeply frozen evaluator identity containing argv/cwd, normalized-policy hash, worktree identity, declared evaluator-file manifest, and evaluation/provenance digests; compare digests rather than shared live objects.
- [x] Require relative canonical contained non-symlink cwd and declared evaluator files under the exact worktree; read files no-follow with identity checks and revalidate identities immediately before and after string-cwd spawn.
- [x] Freeze/hash declared evaluator files, dataset/version identifiers, metric name/direction/parser version, and normalized policy.
- [x] Build an explicit scrubbed environment and keep raw explicit environment values only in the live subprocess spec.
- [x] Use one recursive secret-aware serializer to redact raw environment values from spawn intents, policy/provenance, experiment argv/cwd, transitions, errors, results, logs, artifacts, and metadata while retaining immutable hashes for comparison/resume.
- [x] Accept only an attempt-scoped artifact writer minted from owner-only `StateLayout`; make writes unique, exclusive, no-follow, identity-checked, bounded, hashed, mode `0600`, and attached to the exact attempt; reject arbitrary paths, symlinks, replacement, and overwrite.
- [x] Persist evaluator spawn intent before spawn and provider PID/attempt facts immediately after spawn; treat PID as diagnostic evidence only and never signal PID alone after restart.
- [x] Enforce stdout/stderr caps, real wall-clock timeout, positive termination grace, and pre-abort short-circuiting; terminate only through the live provider handle and await `waitForExit()`/provider-observable tree quiescence.
- [x] Persist exit code, signal, timeout, and bounded log artifacts.
- [x] Parse exactly one dedicated final-line JSON object; require exactly the configured metric; reject missing, duplicate, malformed, or non-finite results; treat stdout as evidence, never agent authority.

## Chunk 06-owned orchestration dependencies

- [x] Chunk 06: prove proposal Agent, tool, process, and job quiescence; await `whenIdle()` and memoized `AgentHandle.dispose()` before any snapshot/commit/evaluation handoff.
- [x] Chunk 06: prove exclusive worktree ownership after child disposal, exact start/candidate commit-backed state, and no late/concurrent writer until evaluator settlement.
- [x] Chunk 06: run and durably settle the baseline before child creation; cover target shortcut, every baseline-blocked outcome, immutable provenance, and no candidate-budget consumption.
- [x] Chunk 06: persist each experiment/outcome/artifact set before admitting the next child and persist accept/reject plus reconciliation intent before applying Chunk 05 reconciliation primitives.
- [x] Chunk 06: prove authorized restart reconciliation converges and ambiguous/external state blocks without duplicate candidates or lost audit refs.
- [x] Chunk 06: atomically persist terminal/quiescent run state, completed reconciliation, and artifact references before releasing the active lock as the controller's final idempotent repository action.
- [x] Chunk 06: do not claim that a malicious independent same-UID racer cannot execute against string `cwd`; require an external sandbox/read-only provider for that stronger guarantee.

## Chunk 05 verification gate

- [x] Two consecutive final gates passed; each gate ran `pnpm run typecheck`, focused Vitest suites (`6` files / `143` tests), and `pnpm run build`.
- [x] Test clean temporary Git repository setup and read-only discovery before tracker/mutation.
- [x] Test dirty caller work preservation, immutable run-id branch/worktree identities, active same-tag exclusion, terminal tag reuse, and independent run-tag worktrees.
- [x] Test same-run collision verification and full-SHA lineage.
- [x] Test staged, unstaged, and untracked protected-path violations.
- [x] Test dependency, submodule, common/worktree config, include, hooks/fsmonitor/filter-helper, and exceptional-path policies without executing repository-controlled helpers.
- [x] Test deterministic candidate commit/audit recovery across preparation/publication faults, rejected audit preservation through later promotion/cleanup, and exact commit-backed worktree verification.
- [x] Test exact evaluator argv/cwd/env, immutable alias capture, normalized policy/evaluation digests, and canonical no-follow cwd/file manifest validation.
- [x] Test attempt artifact containment, parent/destination symlinks, collisions/replacement, owner-only modes, provider spill validation, and no writes outside state root.
- [x] Test recursive secret redaction when the same raw value appears in env, argv, cwd, nested policy/facts, errors, logs, artifacts, and metadata.
- [x] Test stdout/stderr caps including oversized/lossy stderr; returned and durable nonzero exit/signal/timeout facts; wall-clock timeout; pre-abort; descendant termination; cancellation idempotence; and awaited quiescence.
- [x] Test explicit worktree cleanup retains durable tracker/artifact/commit/audit evidence and stale terminal-owner lock recovery is idempotent.

## Chunk 05 review findings and dispositions

- [x] Prior reviews found and fixes addressed: ambient/overridable Git environment and executable repository config; non-convergent reset publication; evaluator shared-alias identity; cwd/file capability overclaim; artifact symlink/path ownership; durable secret aliases; missing unstaged-protected coverage; and under-marked tests.
- [x] Reassign the unavailable fd-bound/string-cwd stability guarantee, proposal-resource quiescence, pre-child/baseline ordering, late-writer prevention, durable reconciliation authorization, and final lock-release ordering to Chunk 06.
- [x] Review mutable/protected policy across staged/unstaged/untracked paths.
- [x] Review candidate commit/audit evidence retention across rejection and failure; keep controller restart sequencing as a separate Chunk 06 review.
- [x] Complete a final clean independent Git command/caller-worktree/config-execution review through `5ba42d51f97116d31f816bb279dc97c134128ed9`.
- [x] Complete a final clean independent evaluator/security shell/secret/provenance/filesystem/artifact/process review through `294d3c5e7d65995478d41bc61b22dcb6359de901`.
- [x] Complete a clean review of the tracker concurrency fix with no unresolved finding.

## Chunk 05 implementation and review-fix commits

- [x] Integrate Git/evaluator lanes against frozen tracker/types APIs in `33acd67cf37d6a01de167c8c8279dcd4f3deda8f` (`feat(boundaries): add host Git and evaluator safety`).
- [x] Record tracker-accounting commit `ad273870e3cf71676a87fc8cbb2d09b86c9cd3d2`.
- [x] Record prior review-fix commit `118f345cb1e994d0f9e7540e8c5dd4a04b4ed932` (`fix(boundaries): harden recovery and process isolation`).
- [x] Record implementation/review-fix commit `dffb00ebcab22a07f8c8c22e0f58bb2a706fd7a6` (`fix(boundaries): complete restart-safe host controls`).
- [x] Record final review-fix commit `185cbe2d0159522099e2965590158cee62d8d97b` (`fix(boundaries): enforce trusted Git and evaluator state`).
- [x] Record threat-model wording commit `3e2af56c331fad84aed99a7be0357622bddfb8b3` (`docs: record host boundary threat model`).
- [x] Record Git review-fix commit `5ba42d51f97116d31f816bb279dc97c134128ed9` (`fix(boundaries): close candidate and provenance gaps`).
- [x] Record evaluator/security and tracker-concurrency review-fix commit `294d3c5e7d65995478d41bc61b22dcb6359de901` (`fix: stabilize secure autoresearch boundaries`).

## Chunk 05 closure and accounting

- [x] Complete final clean Git and evaluator/security re-reviews, complete the tracker concurrency fix review, and record zero unresolved Chunk 05 findings.
- [x] Commit the final Chunk 05 tracker/accounting update separately and record its full SHA: `89f50fba279e8c2156394763f1357bd9377996b7`.
- [x] Close Chunk 05 and advance Chunk 06 to dependency-ready after recording the separate closure commit; every Chunk 06 implementation and dependency checkbox remains unchecked.

# Chunk 06 — `06-implement-recoverable-controller`

## Proposal agent (`src/agent.ts`)

- [x] Create `src/agent.ts`.
- [x] Create every proposal child directly with `ctx.agents.create`; do not route worktree-bound rounds through `ctx.subagents.start`.
- [x] Generate a fresh `SessionId` for every proposal round.
- [x] Persist canonical isolated worktree path in child `meta.cwd`.
- [x] Set `parentSession`, origin, and delegation-depth metadata from `exec.agent`.
- [x] Pass explicit `agentOptions.provider`, `model`, and optional `maxTokens`, inherited from the initiating Agent unless configured overrides apply.
- [x] During `setup(childCtx)`, compose the required parent preset/policy surface before publication.
- [x] During the same setup window, register an autoresearch-only schema-validating report tool in the child scope.
- [x] Register a matching child-scoped system-prompt section that requires exactly one report-tool submission.
- [ ] Document in code/tests that `SubagentStartRequest` is unsuitable because it has no per-run cwd/session-meta hook, `agentOptions` cannot carry cwd, and prompt paths do not create isolation.
- [x] Bound handoff size and report size.
- [x] Supply immutable objective/policy, experiment number, best measured facts, bounded prior summary, and tracker-derived workspace facts.
- [x] Instruct the child to inspect/edit only the isolated worktree represented by its durable cwd.
- [x] Define the validated child report with hypothesis, intended edits, implementation summary, and optional blocker claim only.
- [x] Exclude authoritative metric/status/command/Git decision fields.
- [x] Drive the child with `followup(...)`, await `whenIdle()`, and reject missing, duplicate, malformed, stale, wrong-experiment, or oversized reports.
- [x] Propagate controller cancellation through `agent.cancel(...)`.
- [x] Always await `AgentHandle.dispose()` in `finally` on success, report failure, cancellation, controller failure, and unload; the host remains authoritative.
- [x] Prove every proposal-owned tool/process/job is structured and quiescent before ownership transfer; remove background/detach capabilities or retain and await every handle so a late writer cannot survive disposal.

## Recovery (`src/recovery.ts`)

- [x] Create `src/recovery.ts`.
- [x] Resume by `run_id`, not branch/tag alone.
- [x] Verify repository identity and start SHA.
- [x] Verify immutable policy and evaluator/provenance hash.
- [x] Verify run-id-bearing branch/worktree registration and current full HEAD.
- [x] Verify unresolved experiment, artifact completeness, and recorded evaluator spawn/attempt facts.
- [x] Within the same live provider session, use only the provider-owned handle for evaluator process-tree liveness/termination.
- [x] After host restart, never signal a recorded PID without provider-supported stable identity proof stronger than PID reuse.
- [x] Rerun an interrupted baseline/candidate evaluator only when durable/provider evidence proves the entire prior provider-owned process tree—parent and every descendant—is quiescent; parent death alone is insufficient.
- [x] Mark missing whole-process-tree quiescence proof typed `blocked`; do not signal or duplicate evaluation.
- [x] When safe rerun is proven, retain the interrupted baseline attempt, restore the isolated worktree to immutable start, and rerun the exact evaluator.
- [x] When safe rerun is proven, restore recorded candidate commit for interrupted candidate evaluation and rerun without creating a new candidate.
- [x] Recompute interrupted decision from durable measured facts.
- [x] Idempotently restore expected accepted HEAD for committed decision.
- [x] Never create duplicate candidate for unresolved experiment.
- [x] Block on protected changes.
- [x] Block on missing commits.
- [x] Block on provenance mismatch.
- [x] Block on ambiguous tracker state.
- [x] Block on uncertain surviving evaluator.
- [x] Block on external worktree/branch mutation.
- [x] Preserve evidence before repair/reconciliation.
- [x] Persist deterministic accept/reject and reconcile intent before applying Chunk 05 prepare/cleanup/ref-transaction primitives; authorize restart repair only when durable intent, audit ref, lineage, and observed Git state agree.
- [x] Restore and exactly reverify the recorded start/candidate commit, including no untracked or ignored extras, before resumed evaluation; admit no writer until settlement.

## Controller (`src/controller.ts`)

- [x] Create `src/controller.ts`.
- [ ] Make the controller the sole production orchestration/state owner during the Chunk 07 wiring clean cutover; `AutoresearchRunController` currently owns only the new recoverable-controller path.
- [x] Normalize and freeze run policy before execution.
- [x] Allow only read-only repository/common-directory/start-SHA discovery before tracker creation.
- [x] Create tracker/run row with discovered repository identity and start SHA before every mutating/allocating external setup effect.
- [x] Persist intent before crash-recovery-critical external effects at the implemented controller checkpoints.
- [x] Persist observed outcomes after those checkpointed crash-recovery-critical effects; do not claim universal per-effect coverage for every child lifecycle, verification, cleanup, or lock-release operation.
- [x] Resolve/freeze Git executable identity and normalized policy once; mint evaluator boundary identities only from those immutable facts and block resume on any executable/evaluation/policy hash mismatch.
- [x] After allocation, verify the dedicated worktree exactly equals `startCommit`; persist baseline intent, artifacts, and terminal outcome before creating any child. Cover target shortcut and every nonzero/timeout/signal/parser/provenance/isolation `baseline-blocked` result without consuming candidate budget.
- [x] Run baseline gate.
- [x] Handle baseline-target shortcut.
- [x] Request one fresh proposal at a time.
- [x] Validate child-authored filesystem changes on host.
- [x] Create candidate commit/audit record before evaluation.
- [x] Execute independent evaluator on recorded candidate commit.
- [x] Enforce event order `whenIdle -> dispose resolved -> candidate audit commit -> exact worktree verification -> declared-file revalidation -> spawn intent -> string-cwd spawn`; admit no next proposal/writer until evaluator outcome, artifacts, and terminal experiment state are durable.
- [x] Parse trusted metric on host.
- [x] Compute strict minimize acceptance with `<`.
- [x] Compute strict maximize acceptance with `>`.
- [x] Reject ties.
- [x] Reject regressions.
- [x] Recompute target satisfaction after accepted result.
- [x] Persist terminal experiment before next proposal.
- [x] Stop at experiment budget.
- [ ] Surface a host-proven post-baseline blocker separately; child blocker claims remain non-authoritative and the controller path is not yet implemented/evidenced.
- [x] Surface infrastructure/contract failure as `round-failed`.
- [x] Handle cancellation at a quiescent durable boundary.
- [ ] Chunk 07 clean-cutover dependency: remove `ctx.workflowEngine` production orchestration.
- [ ] Chunk 07 clean-cutover dependency: replace or remove the four workflow-based unit tests in `tests/autoresearch.spec.ts` and the competing workflow integration coverage.
- [ ] Chunk 07 clean-cutover dependency: remove the no-longer-used workflow runtime dependency/peer.
- [ ] Chunk 07 clean-cutover dependency: remove temporary legacy `evaluation_command` and workflow-specific public patch/tool schema runtime compatibility.
- [x] Keep rejected candidate commits/audit refs.
- [x] Reconcile isolated worktree to last durable accepted commit.
- [x] Mint the attempt artifact writer from owner-only `StateLayout` only after durable attempt identity exists; transactionally link artifact ownership before terminal transition or the next experiment.
- [x] Persist terminal/quiescent run facts, completed Git reconciliation, and artifact references before active-lock release; make release the controller's final idempotent repository action.

## Chunk 06 verification gate
- [x] Record focused Chunk 06 implementation verification: `pnpm install --frozen-lockfile` passed; `pnpm run typecheck` passed; Vitest passed 9 files / 172 tests; `pnpm run build` passed. Granular tests, independent review, and closure remain unchecked pending their separate gates; the separate accounting commit is recorded below.

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
- [ ] Test proposal Agent/tool/process/job quiescence and exclusive worktree ownership; a scheduled late writer cannot mutate after disposal or overlap evaluator spawn.
- [ ] Test exact start/candidate commit handoff, absence of hidden ignored/untracked inputs, and pre/post string-cwd/file identity substitution detection without claiming hostile same-UID race prevention.
- [ ] Test every baseline success/blocking outcome, durable artifacts, zero-child target shortcut, and no candidate-budget consumption.
- [ ] Test terminal experiment persistence before the next child and terminal/quiescent run persistence before final lock release, including crash/retry ordering.
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

- [x] Integrate proposal/recovery lanes into controller.
- [ ] Confirm all prior callers migrate to the controller clean cutover in Chunk 07; legacy workflow/tool wiring remains live and assigned to Chunk 07.
- [x] Commit recoverable controller and focused tests in foundation commit `ca184254e3681fea00cbf53ec4d377c9803928a0`, proposal/recovery commit `b690a56f7df0b97dd5fb03d32201b8a933928718`, and controller commit `99b7aa12a7036b5f8cf10c634a455779141d956f`.

## Chunk 06 tracker-accounting gate

- [x] Record Chunk 06 implementation commits: `ca184254e3681fea00cbf53ec4d377c9803928a0`, `b690a56f7df0b97dd5fb03d32201b8a933928718`, and `99b7aa12a7036b5f8cf10c634a455779141d956f`.
- [x] Commit the Chunk 06 checklist accounting update separately from the implementation commits: `9215f6a`. Independent review and Chunk 06 closure remain pending.

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
