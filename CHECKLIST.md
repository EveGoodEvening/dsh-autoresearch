# dsh-autoresearch Implementation Checklist

## Status rules

- `[x]` means verified in the current worktree or completed research/planning evidence.
- `[ ]` means not present or not verified in the current worktree.
- Archived implementation activity was historical evidence only until the authoritative snapshot was recovered. Chunk 01 is now closed by implementation commit `3ca85a17c03d15488269b3dbc339e3ec135d98c3`, tracker-accounting commit `4095697a6b7256937f535d739ca09678b47e333d`, review-fix commit `6524bdf`, and a clean independent correctness/accounting/security re-review after `6524bdf` with zero findings.
- **Current phase: final split review and unchecked-item classification before release.** Chunk 02 is closed by implementation commit `cf4302c0197d4dc7f77a15cc5230abf9f6d74fc4`, tracker-accounting commit `fa4bf06ef24b590a81f883037b940f18d97c5cfc`, review-fix commit `7671499`, focused clean-generated-state verification, and clean independent package/accounting re-reviews. Chunk 03 is closed by implementation commits `9b18630` and `e22d99a`, tracker-accounting commit `99babc5dc3432be7c078fd6e792c97164ebfb19b`, review-fix commit `5e990acb1df3bcf8b7e2612c91f38443d364d2db`, passing post-fix frozen-install/typecheck/3-file-54-test/build/pack gates, and a clean independent correctness/security/accounting re-review. Chunk 04 is closed by implementation commit `cfc2e45366961c10b97b6fab63ffea9abfb3b5dd`, tracker-accounting commit `a1fca4c61fbf241b716a8e423a12788d16e3c71d`, review-fix commits `c9ba821923cd233c8c3112a7b3cdd2b8d311ec36`, `5ada9cd`, and `e7fb2e6`, passing final typecheck/4-file-79-test/build gates, completed correctness/security/concurrency/accounting reviews, a frozen tracker API, and a clean final re-review. Chunk 05 is closed by its recorded implementation/review-fix commits, final clean Git/evaluator/security/tracker-concurrency reviews, and final tracker/accounting commit `89f50fba279e8c2156394763f1357bd9377996b7`. Chunk 06 is closed through final fix `e613e549e0fb4f40f0921ecd585c25d2dd6a9a03`, passing final typecheck/9-file-229-test/build gates, clean independent controller/recovery/security/accounting reviews, post-`3e9e44c57c94ad9fcbff411d0cec485a580e9832` accounting commit `bc09f43278c2ecc41acde60d3b2cd204d5eff466`, and zero unresolved Chunk 06 findings. Chunk 07 is closed by production cutover commit `952267ba41689cf21c63092e37cb61c34ccd5e61`, lifecycle hardening commit `8b17077feaf3f9458120d1b2acf4ec6978000733`, durable startup completion commit `7a66971a5f01e8b0fd50abe807b6e9bc7037690e`, accounting commit `19edce27785f016a02614fe9b3d447343d1ecac7`, passing final verification, and a clean final independent implementation/security/accounting review. Chunk 08 is closed by its recorded implementation/test commits through `a591dca237580e4cf3e5cbfc550a36334ddc643b`, accounting commit `ff3a136c8f270d781d2a3ce8722ee1e641234139`, passing final verification, and clean definitive implementation and accounting reviews with zero findings. Chunk 09 is closed by documentation/release implementation commit `b978619b89ce589f4a3eb95d9509d78e4f7f4309`, installed release-scenario commit `a8e2f7209d5764011dea001240e6bdfa327b4058`, clean-cutover fix commit `aee26142acfa4530c43d34d57705b0803fe5415f`, its recorded prior accounting commits, passing final release gates, and a clean independent documentation/security/package/clean-cutover review. The new Chunk 09 closure-accounting commit and all final split-review, classification, and release-accounting items remain unchecked.

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
- [~] If `git fsck --full` reports `missing tree 4b825dc642cb6eb9a060e54bf8d69288fbee4904` for this unborn repository, record it as the benign empty-tree warning rather than a missing recovery blob. — OBSOLETE: the repository is no longer unborn, and exact protected-ref/blob verification plus the completed recovery commit superseded this conditional warning path.
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
- [~] If a recovered local-link target is unavailable, record the frozen-install failure as expected provenance and defer the registry-resolvable dependency repair to Chunk 02; do not modify the recovery snapshot. — OBSOLETE: the recovered local-link targets were available, the frozen install succeeded, and Chunk 02 completed the registry-resolvable dependency repair.
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

# Chunk 06 — `06-implement-recoverable-controller` (CLOSED)

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
- [x] Document in code/tests that `SubagentStartRequest` is unsuitable because it has no per-run cwd/session-meta hook, `agentOptions` cannot carry cwd, and prompt paths do not create isolation.
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
- [x] Chunk 07 clean-cutover dependency: make `AutoresearchRunController` the sole production orchestration/state owner while migrating production wiring away from the legacy path.
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
- [x] Surface a host-proven post-baseline blocker separately; child blocker claims remain non-authoritative, while proposal disposal/quiescence uncertainty transitions the run to host-authored `blocked` / `attempt-uncertain` without releasing ownership.
- [x] Surface infrastructure/contract failure as `round-failed`.
- [x] Handle cancellation at a quiescent durable boundary.
- [x] Chunk 07 clean-cutover dependency (production owner): remove `ctx.workflowEngine` production orchestration.
- [x] Chunk 07 clean-cutover dependency (workflow coverage): replace or remove the four workflow-based unit tests in `tests/autoresearch.spec.ts` and the competing workflow integration coverage.
- [x] Chunk 07 clean-cutover dependency (dependency cleanup): remove the no-longer-used workflow runtime dependency/peer.
- [x] Chunk 07 clean-cutover dependency (schema cutover): remove temporary legacy `evaluation_command` and workflow-specific public patch/tool schema runtime compatibility.
- [x] Keep rejected candidate commits/audit refs.
- [x] Reconcile isolated worktree to last durable accepted commit.
- [x] Mint the attempt artifact writer from owner-only `StateLayout` only after durable attempt identity exists; transactionally link artifact ownership before terminal transition or the next experiment.
- [x] Persist terminal/quiescent run facts, completed Git reconciliation, and artifact references before active-lock release; make release the controller's final idempotent repository action.

## Chunk 06 verification gate
- [x] Record final Chunk 06 verification after final fix `e613e549e0fb4f40f0921ecd585c25d2dd6a9a03`: `pnpm run typecheck` passed; Vitest passed 9 files / 229 tests; `pnpm run build` passed. This supersedes the verification recorded after `3e9e44c57c94ad9fcbff411d0cec485a580e9832`.

- [x] Test baseline-target shortcut spawns no child.
- [x] Test strict accepted improvement.
- [x] Test equal metric rejection.
- [x] Test regression rejection.
- [x] Test evaluator crash with proven prior whole-process-tree quiescence can safely rerun once.
- [x] Test evaluator timeout.
- [x] Test restart where only parent death is known becomes `blocked`, never signals the PID, and never duplicates execution while descendant survival is uncertain.
- [x] Test policy violation.
- [x] Test child blocker cannot self-authorize terminal status.
- [x] Test child metric/status/command/Git fields cannot spoof authority: the closed report schema rejects every undeclared authority-bearing field, with an injected metric field covered as the representative schema rejection.
- [x] Test fresh `SessionId`, durable worktree `meta.cwd`, parent/delegation metadata, and explicit inherited provider/model/optional `maxTokens` on every child.
- [x] Test child-scoped report tool/prompt registration, exact schema validation, and rejection of missing/duplicate/malformed/stale/wrong-experiment/oversized reports.
- [x] Test `AgentHandle.dispose()` is awaited exactly once/idempotently for success, report failure, cancellation, controller failure, and unload.
- [x] Test proposal Agent/tool/process/job quiescence and exclusive worktree ownership; a scheduled late writer cannot mutate after disposal or overlap evaluator spawn.
- [x] Test exact start/candidate commit handoff, absence of hidden ignored/untracked inputs, and pre/post string-cwd/file identity substitution detection without claiming hostile same-UID race prevention.
- [x] Test every baseline success/blocking outcome, durable artifacts, zero-child target shortcut, and no candidate-budget consumption.
- [x] Test terminal experiment persistence before the next child and terminal/quiescent run persistence before final lock release, including initialization and crash-window retry ordering; closure-fix coverage proves a proposal-uncertain terminal run durably records `terminal_quiescent = 0`, retains its active lock, and returns the same retain directive across repeated recovery.
- [x] Test target behavior for minimize/maximize.
- [x] Test budget-limited completion.
- [x] Test the safely reconcilable nonterminal run-state matrix, including fresh initialization, matching-lock initialization reuse, ready-state replay, baseline-running crash windows, rejection of a false run-level quiescence claim without partial terminal mutation, and terminal-lock crash replay from the durable run-level quiescence fact.
- [x] Test the safely reconcilable nonterminal experiment-state matrix, including missing/pending/running/terminal baseline states, incomplete artifacts, canonical attempt-scoped stdout/stderr artifact identity/ownership/retention/metadata, secure owner-only artifact-file recovery, candidate preparation before/after audit publication, and conservative blocking for uncertain survivors.
- [x] Test recovered terminal evaluator evidence is validated against the canonical durable attempt artifacts before terminal lock release, and that valid failed-baseline evidence replays idempotently with the recovered stdout/stderr references.
- [x] Test missing, tampered, or extraneous canonical terminal artifact evidence returns typed `artifact-incomplete`, retains the active lock, and does not claim terminal recovery completion.
- [x] Test the crash-replay window after evaluator outcome and terminal experiment persistence settles the same durable baseline decision idempotently without creating another attempt or prematurely advancing run state.
- [x] Test no duplicate candidate creation during recovery.
- [x] Test deterministic decision replay.
## Chunk 06 review gate

- [x] Chunk 07 clean-cutover dependency (production owner): review the controller as the sole production state machine after competing workflow logic is removed.
- [x] Complete an independent controller review of intent/outcome ordering around side effects; clean with zero findings after final fix `e613e549e0fb4f40f0921ecd585c25d2dd6a9a03`.
- [x] Complete an independent security review of acceptance/target logic and strict host authority; clean with zero findings after final fix `e613e549e0fb4f40f0921ecd585c25d2dd6a9a03`.
- [x] Complete an independent recovery review for idempotence and evidence preservation; clean with zero findings after final fix `e613e549e0fb4f40f0921ecd585c25d2dd6a9a03`.
- [x] Chunk 07/09 clean-cutover dependency: review removal of obsolete workflow code, runtime dependencies, compatibility schema, comments, and shipped README/current composition guidance after Chunk 09 documentation migration; completed cleanly after `aee26142acfa4530c43d34d57705b0803fe5415f` with no obsolete authority path or alias remaining.

## Chunk 06 implementation commit gate

- [x] Integrate proposal/recovery lanes into controller.
- [x] Chunk 07 clean-cutover dependency (workflow migration): confirm every prior production caller migrates to the controller and legacy workflow/tool wiring is removed.
- [x] Commit recoverable controller and focused tests in foundation commit `ca184254e3681fea00cbf53ec4d377c9803928a0`, proposal/recovery commit `b690a56f7df0b97dd5fb03d32201b8a933928718`, controller commit `99b7aa12a7036b5f8cf10c634a455779141d956f`, review-fix commit `b1a0e1b0cf9825d19ddbbed246a9ff790fdf410e`, recovery-matrix test commit `e28d78ad2edeb7158370b568539e27d6fecadc85`, final review-fix commit `2e45cbc7d04a558d8b55b4ef863a5aad083dc05c`, ownership-retention review-fix commit `afd2621fbb95ddc10d7ba3c3b15e76699cb59008`, final quiescence/disposal test commit `aeafc7458b7c7697fc62501f1dd06ed7c62f6e46`, terminal-lock/artifact/crash-replay closure-fix commit `2c106113ca95fa231f6942cd6886dd1ef3af364a`, terminal replay evidence validation commit `3e9e44c57c94ad9fcbff411d0cec485a580e9832`, and final fix commit `e613e549e0fb4f40f0921ecd585c25d2dd6a9a03`.

## Chunk 06 tracker-accounting gate

- [x] Record Chunk 06 implementation commits: `ca184254e3681fea00cbf53ec4d377c9803928a0`, `b690a56f7df0b97dd5fb03d32201b8a933928718`, and `99b7aa12a7036b5f8cf10c634a455779141d956f`; review-fix commits: `b1a0e1b0cf9825d19ddbbed246a9ff790fdf410e`, `2e45cbc7d04a558d8b55b4ef863a5aad083dc05c`, `afd2621fbb95ddc10d7ba3c3b15e76699cb59008`, and final fix `e613e549e0fb4f40f0921ecd585c25d2dd6a9a03`; recovery-matrix test commit: `e28d78ad2edeb7158370b568539e27d6fecadc85`; final quiescence/disposal test commit: `aeafc7458b7c7697fc62501f1dd06ed7c62f6e46`; terminal-lock/artifact/crash-replay closure-fix commit: `2c106113ca95fa231f6942cd6886dd1ef3af364a`; and terminal replay evidence validation commit: `3e9e44c57c94ad9fcbff411d0cec485a580e9832`.
- [x] Record the earlier Chunk 06 checklist accounting commits separately from implementation and review-fix work: `9215f6a` and `16f97d06627a72281db8ec39bd116ffebc597512`.
- [x] Record prior final-controller-recovery checklist accounting commit `a3db166c488596056d786de2697364dd6bc83377` as a separate accounting-only commit.
- [x] Record post-`aeafc7458b7c7697fc62501f1dd06ed7c62f6e46` accounting commit `612eb4db75d7b0797f0ace79ac6847934adb54bd` (`docs: record controller quiescence verification`) as complete and separate from implementation, review-fix, and test commits.
- [x] Complete clean independent controller, recovery, security, and accounting reviews after final fix `e613e549e0fb4f40f0921ecd585c25d2dd6a9a03`; record zero unresolved Chunk 06 findings and close Chunk 06.
- [x] Record post-`2c106113ca95fa231f6942cd6886dd1ef3af364a` accounting commit `0abff2f38fdccf81eb2d2fa4ed62f8101060eec7` (`docs: record terminal recovery verification`) as complete and separate from implementation, review-fix, test, closure-fix, and prior accounting commits.
- [x] Record post-`3e9e44c57c94ad9fcbff411d0cec485a580e9832` accounting commit `bc09f43278c2ecc41acde60d3b2cd204d5eff466` as complete and separate from implementation, review-fix, test, closure-fix, validation, and prior accounting commits.
- [x] Record Chunk 06 closure-accounting commit `99a03707559c2d5fc02903dd215792e56848eb31` (`docs: close recoverable controller chunk`) as complete and separate from implementation, review-fix, test, validation, and prior accounting commits.

# Chunk 07 — `07-wire-tool-jobs-lifecycle-and-hmr` (CLOSED)

## Plugin wiring (`src/index.ts`)

- [x] Keep named exports only: `name`, `inject`, `Config`, `apply`; built-root runtime inspection returned exactly `Config,apply,inject,name`.
- [x] Inject `tools`.
- [x] Inject `agents`.
- [x] Inject `subprocess`.
- [x] Inject `jobs`.
- [x] Inject `systemPrompt`.
- [x] Treat the tool execute body's `exec.agent` as the sole parent/session/workspace authority anchor; do not infer an ambient agent.
- [x] Populate the durable `runs` agent/session identity from `exec.agent`.
- [x] Register exactly one `autoresearch` tool through `ctx.tools.register`/`defineTool`.
- [x] Add direct-human-request system guidance.
- [x] Return canonical foreground result union.
- [x] Start background jobs by default with `owner: exec.agent`.
- [x] Honor explicit foreground mode.
- [x] In the synchronous LocalJobRegistry `run()` callback, create the job-owned `AbortController`, idempotent cancellation hook, deferred execution gate, `done` promise, and readiness promise without starting controller work.
- [x] Call `ctx.jobs.start`, receive the returned job id, and durably record it before releasing the deferred execution gate.
- [x] Ensure failures before gate release settle `done` and readiness without orphaning resources.
- [x] Run durable initialization under the job-owned signal after gate release; resolve readiness only after tracker, run-id-bearing branch, and worktree facts are committed.
- [x] Return background `{ kind, runId, jobId, tracker, branch, worktree }` only from the readiness result.
- [x] Return typed startup failure/cancellation when initialization fails before readiness; do not fabricate tracker/branch/worktree values.
- [x] Declare `autoresearch` job kind through type augmentation.
- [x] Use generic jobs control rather than private job tools.
- [x] Chunk 08 composition dependency: require and verify compatible jobs registry plus generic jobs-tool composition through the real Harness stack; proven by real profile composition with the local jobs registry and generic list/output/kill tools.
- [x] Map `target-reached` and `budget-limited` to completed jobs, and map every uncertain `blocked` result to failed while preserving its canonical durable result.
- [x] Map `baseline-blocked` and `round-failed` to failed jobs.
- [x] Map plugin-internal cancellation to Harness job outcome status `killed` while preserving the plugin result variant `cancelled`.
- [x] Ensure job `done` waits for controller/child-dispose/process/tracker/Git quiescence and resolves only after cleanup, not merely after cancellation is requested.
- [x] Implement synchronous/idempotent job cancellation hook.
- [x] Sever background lifetime from the outer tool call's `exec.signal` before releasing deferred controller execution.
- [x] Pass the job-owned controller signal to `AutoresearchRunController`, child Agent cancellation, evaluator subprocesses, and Git subprocesses.
- [x] Persist cancellation intent before aborting resources.
- [x] Await `AgentHandle.dispose()`, entire owned process-tree termination, and worktree reconciliation.
- [x] Atomically persist terminal cancellation/quiescent facts without deleting evidence.
- [x] Release repository/run-tag active lock only after terminal persistence, as the final idempotent operation.
- [x] Remove tool registration on plugin disposal/HMR.
- [x] Remove prompt contribution on plugin disposal/HMR.
- [x] Settle active controllers/children/evaluators/jobs on disposal/HMR.
- [x] Add no redundant durable Harness session event.

## Bundle/composition

- [x] Retain stable patch row id `autoresearch`.
- [x] Retain module name `dsh-autoresearch`.
- [x] Retain complete Loader defaults in patch config.
- [x] Chunk 09 documentation dependency: document current installed-profile prerequisites for the jobs registry plus `dsh-tool-jobs`; Chunk 08 validated the real composition.
- [x] Chunk 09 documentation dependency: document the subprocess provider requirement; Chunk 08 validated the real composition and failure path.
- [x] Chunk 09 documentation dependency: document the core Agent registry/runtime and child setup requirement, with no subagent provider; Chunk 08 validated the real composition and failure path.
- [x] Chunk 08 composition dependency: verify activation is opt-in through real profile installation; the keyless base profile omitted autoresearch and the assembled installed layer activated it.
- [x] Chunk 08 composition dependency: verify service ordering is expressed by injection, not YAML row order, through real Harness composition; the equivalent profile entries were deliberately reversed, `autoresearch` followed `jobs` in row order, and injection still produced a successful boot and end-to-end run.

## Chunk 07 verification gate

- [x] Test foreground tool result.
- [x] Test background tool result waits for durable readiness facts.
- [x] Test actual LocalJobRegistry ordering: the real registry invoked `run()` synchronously, returned its generated job id, the plugin durably recorded that exact id before worktree/evaluator side effects, and controller work then ran under the job-owned signal with cancellation aborting and quiescing the evaluator.
- [x] Test typed initialization failure/cancellation before readiness and no orphaned resources.
- [x] Test background job output consumption through the actual local jobs registry and generic output tool.
- [x] Test generic job list/output/kill compatibility through real Harness composition.
- [x] Test jobs-controller absence fails clearly; real composition without the jobs provider failed synchronously, and missing `dsh-tool-jobs` failed clearly with the registry present.
- [x] Test missing/incompatible core Agent registry/runtime or child setup capability fails clearly; real composition without the Agent provider failed synchronously.
- [x] Test cancellation idempotence.
- [x] Test a registered background job survives the outer tool call's `exec.signal` abort.
- [x] Test child creation derives `parentSession`/delegation/model route from `exec.agent`, background job start receives `owner: exec.agent`, and a real controller-created tracker run row records the same authority identity.
- [x] Test fresh child durable cwd is the canonical isolated worktree and differs from the caller workspace.
- [x] Test plugin cancellation maps to Harness job status `killed`.
- [x] Test cancellation/job completion waits for mandatory Agent handle disposal and whole-process-tree quiescence.
- [x] Test job status mapping for every terminal run status.
- [x] Test HMR/unload removes tool.
- [x] Test HMR/unload removes prompt.
- [x] Test HMR/unload settles active resources.
- [x] Record production-cutover verification for `952267ba41689cf21c63092e37cb61c34ccd5e61`: `pnpm install --frozen-lockfile` passed; `pnpm run typecheck` passed; Vitest passed 8 files / 229 tests; `pnpm run build` passed; `pnpm pack` passed.

## Chunk 07 review gate

- [x] Review lifecycle/disposal symmetry for every registration/resource.
- [x] Review job completion is not reported before durable settlement.
- [x] Review canonical result data is not replaced by prose.
- [x] Review plugin does not modify DeepSeek Harness AgentLoop.

## Chunk 07 implementation commit gate

- [x] Commit tool/jobs/lifecycle/HMR wiring and focused tests in production cutover commit `952267ba41689cf21c63092e37cb61c34ccd5e61` (`feat: wire autoresearch controller lifecycle`).
- [x] Record lifecycle hardening commit `8b17077feaf3f9458120d1b2acf4ec6978000733` (`fix(plugin): harden jobs and lifecycle wiring`); focused verification passed typecheck, 8 files / 239 tests, build, and pack.
- [x] Record durable startup completion commit `7a66971a5f01e8b0fd50abe807b6e9bc7037690e` (`fix(plugin): complete durable background startup`).

## Chunk 07 tracker-accounting gate

- [x] Record Chunk 07 implementation commit full SHA: `952267ba41689cf21c63092e37cb61c34ccd5e61`.
- [x] Record separate Chunk 07 checklist-accounting commit `a0cbd7d1b819155b9debdc0ddc0e57b7951633a5` (`docs: record production cutover verification`) as complete and separate from implementation commit `952267ba41689cf21c63092e37cb61c34ccd5e61`.
- [x] Record final post-`7a66971a5f01e8b0fd50abe807b6e9bc7037690e` verification: `pnpm run typecheck` passed; Vitest passed 8 files / 243 tests; `pnpm run build` passed; `pnpm pack` passed; built-root runtime export inspection returned exactly `Config,apply,inject,name`.
- [x] Complete the final independent Chunk 07 implementation, security, and accounting review; clean with zero findings, and close Chunk 07.
- [x] Record separate Chunk 07 accounting commit `19edce27785f016a02614fe9b3d447343d1ecac7` as complete after durable startup commit `7a66971a5f01e8b0fd50abe807b6e9bc7037690e`.

# Chunk 08 — `08-add-real-dsh-composition-and-recovery-tests` (CLOSED)

## Real Harness composition

- [x] Replace the fixed-report workflow integration test and replace/remove the four workflow-based unit tests in `tests/autoresearch.spec.ts`; the obsolete workflow integration file is absent and the remaining unit coverage targets production wiring and input validation.
- [x] Compose the real Loader/app agent stack in process through profile loading, overlay composition, Cordis plugin fibers, and `boot()`.
- [x] Include the real tools registry.
- [x] Include the real system-prompt registry.
- [x] Include the real jobs registry and generic jobs tools.
- [x] Include the real local subprocess provider.
- [x] Include the real core Agent registry/runtime capable of `ctx.agents.create`, parent ownership, child-scoped setup, and child disposal.
- [x] Mock only model proposal content; Loader, profile composition, ToolRuntime, Agent creation/setup/disposal, evaluator subprocess, jobs, Git, and filesystem boundaries remain production paths.
- [x] Observe `autoresearch` tool registration through real composition and execute it through ToolRuntime with the initiating `agent`.
- [x] Observe prompt guidance through real composition.
- [x] Exercise host filesystem/Git validation against a temporary real Git repository and verify the caller checkout remains clean on `main` under concurrent controllers.
- [x] Exercise the evaluator fixture through the real local subprocess provider.
- [x] Exercise background publication, owner-scoped collection, foreign-session rejection, completion, and cancellation through the actual local jobs registry and generic list/output/kill tools.
- [x] Verify the real parent session owns the job, the child session records its parent and run worktree, production Agent setup is used, and the child Agent is removed after settlement.
- [x] Verify plugin disposal/HMR removes tool and prompt registrations, cancellation settles the published job as killed before unload completes, active child Agents are disposed, and reapply creates no duplicate registrations.

## Bundle/profile and failure composition

- [x] Parse the shipped `cordis.patch.yml` through the real Harness profile/overlay loader and entry composer.
- [x] Verify the stable `autoresearch` id, `dsh-autoresearch` module name, configured defaults, and profile layer.
- [x] Boot the shipped base profile keylessly, prove autoresearch is absent without its bundle, and boot the assembled opt-in profile with the installed autoresearch layer and test model provider.
- [x] Verify missing `dsh-tool-jobs` fails clearly even when the jobs registry is present.
- [x] Verify missing tools, system-prompt, jobs, subprocess, or Agent providers fail clearly.
- [x] Verify required profile providers include Agent, jobs, subprocess, system-prompt, tools, and tool-jobs, and the installed test model provider is visible through the real LLM registry.
- [x] Verify no tested missing-service path hangs; every omitted required service fails synchronously.

## Recovery/concurrency integration

- [x] Test deliberate interruption during baseline where entire prior evaluator process-tree quiescence is proven and safe rerun occurs once; the public controller recovery test records quiescence before the missing outcome, permits one rerun, and then durably stops with `recovery-rerun-exhausted` rather than running a third attempt.
- [x] Test deliberate interruption during candidate evaluation where entire prior evaluator process-tree quiescence is proven and safe rerun occurs once; restart reuses the recorded candidate commit, permits exactly one rerun, and durably terminates with `recovery-rerun-exhausted` without a third candidate attempt or duplicate candidate audit commit.
- [x] Test restart without proof that every prior evaluator descendant is quiescent blocks without PID signalling or duplicate execution, including the parent-dead/descendant-uncertain case.
- [x] Test deliberate interruption during decision before and after Git publication for both accept and reject; restart deterministically and idempotently reconciles the candidate decision, best commit, worktree HEAD, audit ref, single evaluator attempt, and single terminal experiment transition.
- [x] Test restart after durable allocation through the public controller: resume by run id preserves the same run/tracker/branch/worktree identity and completes with exactly one baseline experiment and one evaluator attempt.
- [x] Test controller ownership fencing across restart: an expired claim whose recorded process identity is still live blocks a competing controller until explicit owner release.
- [x] Test dead-owner takeover: a mismatched process start token proves the recorded owner stale and permits a replacement controller claim.
- [x] Test the losing controller leaves the durable run, transitions, experiments, and attempts unchanged before the owning controller releases and the lineage resumes exactly once.
- [x] Test same repository/run-tag active exclusion through the shared SQLite authority.
- [x] Test repository active-capacity exclusion through that same shared SQLite authority.
- [x] Test later same-tag reuse after terminal cancellation releases the active lock, with a new immutable run id while prior run-id-bearing state remains distinct.
- [x] Test two independent run tags concurrently through separate controller instances sharing one repository tracker.
- [x] Verify separate immutable run-id-bearing worktrees/branches.
- [x] Verify no caller HEAD/index/ledger interference.
- [x] Verify serialized promotion/tracker updates; two concurrent restart controllers at each decision publication window produce one successful reconciliation, one canonical Git result, one candidate attempt, and one terminal tracker transition.
- [x] Test shared-release crash recovery: inject a crash after the per-run tracker lock is released but before shared authority deletion, then resume the same terminal run to remove the identity-checked shared lock and permit a new same-tag run with a distinct immutable run id.
- [x] Test production cancellation plus plugin/HMR disposal with an active run: generic kill settles the job, unload waits for controller/evaluator quiescence, and the child Agent handle is disposed before completion.

## Chunk 08 verification gate

- [x] Observe actual Loader exposes `autoresearch` and the generic job controls.
- [x] Observe actual Loader contributes guidance.
- [x] Observe production `autoresearch` execution facts end to end across ToolRuntime initiating-Agent ownership, child Agent setup, real Git worktree identity, local subprocess evaluation, durable background job publication/output, and terminal child cleanup; direct tracker-row inspection remains covered by the restart integration test rather than claimed here.
- [x] Observe concurrent run isolation through independent active run tags and immutable run-id-bearing Git identities.
- [x] Observe same-tag collision and repository-capacity blocks from one shared tracker authority.
- [x] Observe controller restart after allocation resumes successfully by run id without duplicating the baseline experiment or evaluator attempt.
- [x] Run focused per-file coverage expected by project policy; `pnpm run test:coverage` passed 10 files / 267 tests and enforced the configured thresholds for `src/agent.ts` (86.47% statements / 78.03% branches / 85.71% functions / 95.08% lines), `src/controller.ts` (83.73% / 65.12% / 91.17% / 92.55%), `src/git.ts` (88.76% / 77.27% / 96.73% / 97.76%), `src/index.ts` (84.73% / 75.80% / 62.50% / 93.45%), and `src/recovery.ts` (79.18% / 72.06% / 91.66% / 91.30%).

- [x] Record final post-`a591dca237580e4cf3e5cbfc550a36334ddc643b` gates: `pnpm install --frozen-lockfile` passed; `pnpm run typecheck` passed; Vitest and the focused coverage gate passed 10 files / 267 tests, with all five configured per-file statement/branch/function/line thresholds satisfied; `pnpm run build` passed; `pnpm pack` passed and produced `dsh-autoresearch-0.1.0.tgz`.

## Chunk 08 review gate

- [x] Record the clean composition-focused review evidence established for the pre-`a591dca237580e4cf3e5cbfc550a36334ddc643b` suite across observable contracts, mock boundaries, real Git/subprocess/SQLite fixtures, and deterministic cleanup; the definitive final post-`a591dca237580e4cf3e5cbfc550a36334ddc643b` implementation and accounting reviews below also completed with zero findings.
- [x] Complete the independent definitive implementation review that tests assert observable contracts rather than source/plumbing; clean with zero findings.
- [x] Complete the independent definitive implementation review that only model proposal content is mocked; clean with zero findings.
- [x] Complete the independent definitive implementation review that fixtures use real Git/subprocess/SQLite boundaries; clean with zero findings.
- [x] Complete the independent definitive implementation review that all terminal and recovery paths clean resources deterministically; clean with zero findings.
- [x] Close Chunk 08 after its definitive implementation review and accounting review completed with zero findings and accounting commit `ff3a136c8f270d781d2a3ce8722ee1e641234139` was recorded.

## Chunk 08 implementation commit gate

- [x] Record earlier real DSH composition/recovery/concurrency implementation commit `3b5b819bb66ca3cc34fe561c84b8bdec324d9eb6` (`test(integration): add real dsh composition coverage`).
- [x] Record final Loader/composition/restart implementation and test commit `896d440aeeb50697b8159724779ddb1b30115f81` (`test(integration): complete loader and restart coverage`).
- [x] Record profile-reload/run-ownership hardening implementation commit `bf9fb505578ff8c1f296f420270b8c8d5d2aa6cc` (`fix(integration): harden profile reload and run ownership`).
- [x] Record controller-ownership fencing implementation commit `900521fc9326e6bcfeaceaab64e6a3c5c11e9938` (`fix(integration): fence controller ownership across restart`).
- [x] Record restart-reconciliation implementation and test commit `2a8ed8eed4337fbe1615e51e0a3283bfc1a60b8e` (`test(integration): cover restart reconciliation windows`).
- [x] Record final recovery/order/coverage implementation and test commit `a591dca237580e4cf3e5cbfc550a36334ddc643b` (`test(integration): enforce recovery and coverage gates`); it contains exactly 10 changed files and covers shared-release crash recovery, injection-vs-row-order composition, actual LocalJobRegistry durable job-id ordering, and focused per-file coverage thresholds.

## Chunk 08 tracker-accounting gate

- [x] Record separate earlier Chunk 08 checklist-accounting commit `87735c734264d20ccf74db0296619b9cfb48ae29` (`docs: record real composition verification`) as complete and separate from implementation commits.
- [x] Record final post-`896d440aeeb50697b8159724779ddb1b30115f81` checklist update as separate accounting-only commit `d53fea5dfd94e194616b2c2fbaa898d28db5f896` (`docs: record complete integration verification`).
- [x] Record post-`2a8ed8eed4337fbe1615e51e0a3283bfc1a60b8e` accounting-only commit `d33df24e3733494a1734b30e66e658eec56e1b14` (`docs: record restart reconciliation verification`) as complete and separate from implementation work.
- [x] Record post-`a591dca237580e4cf3e5cbfc550a36334ddc643b` accounting-only commit `ff3a136c8f270d781d2a3ce8722ee1e641234139` as complete and separate from implementation work; the definitive accounting review was clean with zero findings.
- [x] Record Chunk 08 closure-accounting commit `454de4c5b31dd0dfdc8f81d9fd917b940e623126` (`docs: close real composition chunk`) as complete and separate from implementation and prior accounting commits.

# Chunk 09 — `09-complete-docs-and-release-gate` (CLOSED)

## Documentation

- [x] Rewrite README from prompt-enforced workflow description to host-enforced controller contract.
- [x] Document installation with `dsh plugin --profile <name> add <package-or-tarball>`.
- [x] Document profile composition prerequisites.
- [x] Document opt-in activation and stable patch row.
- [x] Document every deployment configuration field/default/limit.
- [x] Document immutable tool/run policy inputs.
- [x] Document argv evaluator format.
- [x] Document strict final-line JSON metric protocol.
- [x] Document minimize/maximize strict improvement and tie rejection.
- [x] Document baseline and `baseline-blocked` semantics.
- [x] Document state root/tracker/artifact/TSV locations.
- [x] Document SQLite authority and TSV compatibility-only role.
- [x] Document dedicated branch/worktree and caller-worktree safety.
- [x] Document candidate commits/audit refs for accepted/rejected work.
- [x] Document recovery/resume by `run_id` and immutable run-id-bearing branch/worktree identity.
- [x] Document evaluator spawn PID/attempt evidence, the prohibition on post-restart PID-only signalling, safe rerun only with proof the entire provider-owned process tree is quiescent, parent-death insufficiency, and uncertain-descendant `blocked` behavior.
- [x] Document interruption handling and other blocked reconciliation cases.
- [x] Document cancellation, mandatory Agent handle disposal, terminal persistence before lock release, and quiescent job completion.
- [x] Document retention/explicit cleanup policy and same-tag reuse with retained run-id-bearing worktrees.
- [x] Document canonical foreground/background/run result unions.
- [x] Document security boundary: host authority, argv, environment, mutable scope, provenance, and the requirement for an external OS sandbox for untrusted code.
- [x] Document whole-row patch override behavior.
- [x] Document migration from recovered 0.1.0 workflow behavior.
- [x] Add complete temporary-repository example matching actual schema/defaults.

## Final package/release gate

- [x] Finalize repository/homepage/bugs/keywords/publishConfig metadata.
- [x] Verify ESM root export.
- [x] Verify `./invariant` export.
- [x] Verify explicit files allowlist.
- [x] Verify README/LICENSE/patch/lib/package.json present in tarball.
- [x] Verify no source-only local paths.
- [x] Verify no runtime or self local-link dependency closure.
- [x] Run clean registry-backed frozen install.
- [x] Run typecheck.
- [x] Run focused unit/behavior/integration tests.
- [x] Run required coverage gate.
- [x] Run build.
- [x] Run actual pack.
- [x] Inspect packed manifest and contents.
- [x] Install tarball into separate consumer/profile fixture without Harness checkout.
- [x] Run `dsh plugin --profile <name> add <tarball-or-package>` against the packed artifact.
- [x] Run `dsh --profile <name> --dump-config` and observe the `autoresearch` row/defaults.
- [x] Load and apply the plugin from the installed profile artifact, not the source tree; post-`37660dd87544b0aba04cb9a98f45e039c2f95858` smoke evidence recorded `profileBoot.sourceTreeResolved=false`, tool registration `autoresearch`, and prompt registration `tool:autoresearch`. This corrects the earlier installed-profile overmark, which had proved installation/config dump but not actual installed-module `apply()`.
- [x] Execute temporary-repository smoke run through the installed profile; structured scenario evidence reported every required item `840` and `845`–`857` with `ok:true`.
- [x] Record final post-fix release gates after implementation fix `09ab3095fd23e9a5a54333f1ccf52b94bd5f772a` (`fix: close final durability and release evidence gaps`): `pnpm install --frozen-lockfile` passed; `pnpm run typecheck` passed; Vitest passed 11 files with 1 skipped / 280 tests with 6 skipped; `pnpm run test:coverage` passed the focused per-file thresholds; `pnpm run build` passed; clean `pnpm pack` rebuilt through `prepack` with the allowlisted manifest/content and no runtime or self local-link closure; and `pnpm run release:smoke -- ./dsh-autoresearch-0.1.0.tgz` emitted structured success with `ok:true`.

## Final smoke observations

- [x] Observe caller worktree remains unchanged; item `845` emitted accepted and rejected before/after caller `HEAD`, index tree, and porcelain status evidence.
- [x] Observe immutable run-id-bearing dedicated worktree and branch created; item `846` emitted distinct accepted/rejected run identities with run-id-bearing branch/worktree data.
- [x] Observe read-only repository discovery followed by tracker creation before any mutating setup or baseline; item `847` recorded durable run and baseline transitions asserted before candidate mutation.
- [x] Observe baseline row recorded; item `848` emitted the accepted scenario baseline experiment with `kind=baseline` and its durable metric/commit facts.
- [x] Observe one accepted candidate with full SHA/audit record; item `849` emitted `strictDecision=accept`, the full candidate commit, and matching audit commit evidence.
- [x] Observe one rejected candidate with full SHA/audit record; item `850` emitted `strictDecision=reject`, the full candidate commit, and matching audit commit evidence.
- [x] Observe strict metric decision; item `851` emitted better=`accept`, tie=`reject`, and worse=`reject` with their concrete metrics.
- [x] Observe atomic deterministic TSV export; item `852` emitted the TSV location/hash evidence and `deterministic=true` after repeated publication.
- [x] Observe deferred background readiness and output through generic jobs control; item `853` emitted `listed=true`, `kill=true`, and `noLiveJobs=true`.
- [x] Observe mandatory Agent handle disposal and cancellation resource cleanup, entire evaluator process-tree quiescence, terminal persistence before lock release, and retained evidence; item `854` emitted `agentDisposed=true`, `terminalBeforeLockRelease=true`, retained candidate/audit evidence, and process-tree quiescence.
- [x] Deliberately interrupt evaluation and prove the entire prior provider-owned process tree is quiescent; item `855` emitted the evaluator parent/child PIDs and `processTreeQuiescent=true` after cancellation.
- [x] Resume by run id and observe completion without duplicate candidate; item `856` emitted the resumed terminal status, exactly one attempt, and `duplicateCandidate=false`.
- [x] Separately simulate restart without whole-process-tree quiescence proof and observe typed `blocked` without signalling the recorded PID or duplicating evaluation; item `857` emitted `status=blocked`, the typed evidence code, `pidSignalled=false`, `duplicateEvaluation=false`, and `lockRetained=true`.

## Chunk 09 review gate

- [x] Review documentation examples against actual schemas/defaults; clean with zero findings.
- [x] Review security/recovery statements against verified behavior; clean with zero findings.
- [x] Review packed artifact independently of source tree; clean with zero findings.
- [x] Review no implementation/reference still describes workflowEngine as authority; clean after `aee26142acfa4530c43d34d57705b0803fe5415f`.
- [x] Review no obsolete aliases/shims/dependencies/comments remain; clean after `aee26142acfa4530c43d34d57705b0803fe5415f`.

## Chunk 09 implementation commit gate

- [x] Commit documentation, metadata finalization, and release fixtures in `b978619b89ce589f4a3eb95d9509d78e4f7f4309` (`docs(release): complete autoresearch release guidance`).
- [x] Record installed release-scenario commit `a8e2f7209d5764011dea001240e6bdfa327b4058` (`docs: record installed release scenarios`).
- [x] Record clean-cutover fix commit `aee26142acfa4530c43d34d57705b0803fe5415f` (`fix(config): remove legacy workflow aliases`).
- [x] Record final implementation fix commit `09ab3095fd23e9a5a54333f1ccf52b94bd5f772a` (`fix: close final durability and release evidence gaps`).

## Chunk 09 tracker-accounting gate

- [x] Record Chunk 09 implementation commit `b978619b89ce589f4a3eb95d9509d78e4f7f4309`.
- [x] Confirm Chunk 09 implementation plus all Chunk 01–08 implementation commits and their separate tracker-accounting commits are reviewable; the not-yet-created Chunk 09 accounting commit is not required to confirm itself.
- [x] Record Chunk 09 checklist-accounting commit `5615c97554820dbd20c64b6abed8374958bc87da` (`docs: record release candidate verification`) as complete and separate from implementation and release-fix commit `37660dd87544b0aba04cb9a98f45e039c2f95858`.
- [x] Complete the final independent Chunk 09 documentation, security/recovery, packed-artifact, authority-cutover, obsolete-surface, and split-slice reviews; the final foundation, runtime, and integration-release reviews were clean with zero findings, all actionable findings were resolved by `09ab3095fd23e9a5a54333f1ccf52b94bd5f772a`, and Chunk 09 closure evidence is complete.
- [x] Record post-`09ab3095fd23e9a5a54333f1ccf52b94bd5f772a` closure-accounting commit `f9f143f4c1c8714dcd3b3a2ef9dc77cbc4ad6096` (`docs: record final split reviews`) as complete and separate from implementation, prior accounting, and the still-pending final release-accounting commit.

# Final split review

## Review A — Foundation

- [x] Complete the final foundation slice review covering durable tracker invariants, transactional intent/outcome ordering, worktree/branch/lock concurrency, path enforcement, evaluator safety, strict decisions, and recovery; clean with zero findings after `09ab3095fd23e9a5a54333f1ccf52b94bd5f772a`.
- [x] Resolve every actionable foundation-review finding; the post-fix re-review reported zero remaining findings.

## Review B — Runtime

- [x] Complete the final runtime slice review covering controller authority, child-report non-authority, cancellation/HMR quiescence, evidence retention, Cordis exports/injection, and tool/systemPrompt/agents/subprocess/jobs seams; clean with zero findings after `09ab3095fd23e9a5a54333f1ccf52b94bd5f772a`.
- [x] Resolve every actionable runtime-review finding; the post-fix re-review reported zero remaining findings.

## Review C — Integration and release

- [x] Complete the final integration-release slice review covering generic jobs behavior, patch/profile composition, dependency identities, packed artifact and consumer installation, README/config examples, AgentLoop non-modification, and absence of redundant durable Harness events; clean with zero findings after `09ab3095fd23e9a5a54333f1ccf52b94bd5f772a`.
- [x] Resolve every actionable integration-release-review finding; the post-fix re-review reported zero remaining findings.

# Unchecked-item classification before release

After all three final reviews above are performed and every review checkbox is checked, inspect only remaining unchecked implementation/evidence items in Chunks 01–09. Final-review checkboxes and the instructions in this section are outside the classification candidate set.

For each candidate that remains `[ ]`, replace it with exactly one auditable classification form:

- `- [ ] original text — BLOCKER: rationale` — required behavior/evidence is missing; release cannot proceed.
- `- [ ] original text — DEFERRED: approval-ref; rationale` — non-required future work only, with prior recorded user/maintainer approval identified by `approval-ref`; an item may never be deferred merely to ship.
- `- [~] original text — OBSOLETE: rationale` — superseded by a documented clean-cutover decision; keep the entry in place with this non-checkbox marker.
- `- [ ] original text — EXTERNAL: named unavailable prerequisite; attempted evidence and reachable work completed` — the unavailable prerequisite does not waive a required item; required `EXTERNAL` items block release until completed.

Then mechanically inspect Chunks 01–09: every remaining `- [ ]` line must contain exactly one of `BLOCKER:`, `DEFERRED:`, or `EXTERNAL:`; every obsolete line must use `- [~]` and exactly one `OBSOLETE:`; no entry may contain multiple classification tokens. Release may be declared only when this check is recorded, every `DEFERRED` item names prior recorded approval and is non-required, no required `EXTERNAL` item remains incomplete, no candidate is unclassified or multiply classified, no `BLOCKER` remains, and final evidence exactly matches the commands/scenarios actually exercised.

## Final release-accounting commit gate

- [x] After Chunk 09 accounting, the final split review, and the classification pass, record the exact final implementation/accounting commit set: Chunk 01 `3ca85a17c03d15488269b3dbc339e3ec135d98c3`, `4095697a6b7256937f535d739ca09678b47e333d`, `6524bdf7eb23d0e5a81975aa7769655d72ec89cc`, `17335c8698fe7b2e5b7599f01553acbb259df2ae`; Chunk 02 `cf4302c0197d4dc7f77a15cc5230abf9f6d74fc4`, `fa4bf06ef24b590a81f883037b940f18d97c5cfc`, `7671499fbb00333347f050a53dfc5220c503f1c3`, `72bb00256b819753edb6c441d35dfcc3c23e7993`; Chunk 03 `9b18630236eb1abbc307ae1533734d6de0a17746`, `e22d99aa5c652912f3820a2a833af2efd2210c4b`, `99babc5dc3432be7c078fd6e792c97164ebfb19b`, `5e990acb1df3bcf8b7e2612c91f38443d364d2db`, `10e0842eeb8becd4627ad7024148db7be511a8c5`; Chunk 04 `cfc2e45366961c10b97b6fab63ffea9abfb3b5dd`, `a1fca4c61fbf241b716a8e423a12788d16e3c71d`, `c9ba821923cd233c8c3112a7b3cdd2b8d311ec36`, `5ada9cd0a1b507f2b4281e1bcadb152bd9f82ceb`, `e7fb2e627473cfe53782c8183b9be79ef224771b`, `ad255fddd1dcc7b1991aa9769cbfb06d2d0fb2ab`; Chunk 05 `33acd67cf37d6a01de167c8c8279dcd4f3deda8f`, `ad273870e3cf71676a87fc8cbb2d09b86c9cd3d2`, `118f345cb1e994d0f9e7540e8c5dd4a04b4ed932`, `dffb00ebcab22a07f8c8c22e0f58bb2a706fd7a6`, `185cbe2d0159522099e2965590158cee62d8d97b`, `3e2af56c331fad84aed99a7be0357622bddfb8b3`, `5ba42d51f97116d31f816bb279dc97c134128ed9`, `294d3c5e7d65995478d41bc61b22dcb6359de901`, `89f50fba279e8c2156394763f1357bd9377996b7`, `20949d94fe20a70543fbc286f640d2ad688c6e67`; Chunk 06 `ca184254e3681fea00cbf53ec4d377c9803928a0`, `b690a56f7df0b97dd5fb03d32201b8a933928718`, `99b7aa12a7036b5f8cf10c634a455779141d956f`, `9215f6a78b5c1b52ee701272b1be8fcf44266c07`, `b1a0e1b0cf9825d19ddbbed246a9ff790fdf410e`, `e28d78ad2edeb7158370b568539e27d6fecadc85`, `16f97d06627a72281db8ec39bd116ffebc597512`, `2e45cbc7d04a558d8b55b4ef863a5aad083dc05c`, `a3db166c488596056d786de2697364dd6bc83377`, `afd2621fbb95ddc10d7ba3c3b15e76699cb59008`, `aeafc7458b7c7697fc62501f1dd06ed7c62f6e46`, `612eb4db75d7b0797f0ace79ac6847934adb54bd`, `2c106113ca95fa231f6942cd6886dd1ef3af364a`, `0abff2f38fdccf81eb2d2fa4ed62f8101060eec7`, `3e9e44c57c94ad9fcbff411d0cec485a580e9832`, `bc09f43278c2ecc41acde60d3b2cd204d5eff466`, `e613e549e0fb4f40f0921ecd585c25d2dd6a9a03`, `99a03707559c2d5fc02903dd215792e56848eb31`; Chunk 07 `952267ba41689cf21c63092e37cb61c34ccd5e61`, `a0cbd7d1b819155b9debdc0ddc0e57b7951633a5`, `8b17077feaf3f9458120d1b2acf4ec6978000733`, `7a66971a5f01e8b0fd50abe807b6e9bc7037690e`, `19edce27785f016a02614fe9b3d447343d1ecac7`, `120d24e02ec3d1d3def1a16479984448f08626ee`; Chunk 08 `3b5b819bb66ca3cc34fe561c84b8bdec324d9eb6`, `87735c734264d20ccf74db0296619b9cfb48ae29`, `896d440aeeb50697b8159724779ddb1b30115f81`, `d53fea5dfd94e194616b2c2fbaa898d28db5f896`, `bf9fb505578ff8c1f296f420270b8c8d5d2aa6cc`, `900521fc9326e6bcfeaceaab64e6a3c5c11e9938`, `2a8ed8eed4337fbe1615e51e0a3283bfc1a60b8e`, `d33df24e3733494a1734b30e66e658eec56e1b14`, `a591dca237580e4cf3e5cbfc550a36334ddc643b`, `ff3a136c8f270d781d2a3ce8722ee1e641234139`, `454de4c5b31dd0dfdc8f81d9fd917b940e623126`; Chunk 09 `b978619b89ce589f4a3eb95d9509d78e4f7f4309`, `5615c97554820dbd20c64b6abed8374958bc87da`, `37660dd87544b0aba04cb9a98f45e039c2f95858`, `a8e2f7209d5764011dea001240e6bdfa327b4058`, `aee26142acfa4530c43d34d57705b0803fe5415f`, `965beb42f4b98f4d78944dd62d0c60caa49c6e9e`, `09ab3095fd23e9a5a54333f1ccf52b94bd5f772a`; and final split-review/closure-accounting commit `f9f143f4c1c8714dcd3b3a2ef9dc77cbc4ad6096`. Final release evidence: `pnpm install --frozen-lockfile` passed; `pnpm run typecheck` passed; Vitest passed 11 files with 1 skipped / 280 tests with 6 skipped; focused per-file coverage passed; clean build and pack passed with exactly 56 tarball entries; and the installed-profile release smoke proved items `840` and `845`–`857` with structured `ok:true` evidence.
- [x] Confirm zero required `EXTERNAL` items, zero `DEFERRED` items, and all required tasks complete. The only obsolete items are lines 35, 72, and 158, each with exactly one `OBSOLETE:` rationale: line 35's unborn-repository empty-tree warning was superseded by protected-ref/blob verification and completed recovery; line 72's unavailable-local-link contingency was superseded by the successful recovered frozen install and Chunk 02 registry repair; line 158's missed historical pre-commit assertion was superseded by auditable post-commit review/fix, verification, and clean re-review. No candidate is unclassified or multiply classified.
- [x] Commit this final release accounting separately: `dd19b4111aba68af279dd6f9a7ffa903ce474566` (`docs: finalize release accounting`).
