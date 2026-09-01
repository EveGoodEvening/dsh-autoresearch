# Handoff 2026-08-30 Remediation Checklist

## Purpose and invariants

This is the durable remediation tracker for the findings in `docs/plan/handoff-2026-0830.md`, reconciled with the independent audits and plan proposals in `local://handoff-audits.json` and `local://handoff-plan-proposals.json`.

- `docs/plan/PLAN.md` and `docs/plan/CHECKLIST.md` are completed historical records. **Do not edit, reopen, or use them as the live tracker.**
- This file is the only live checklist for H-01 through H-15.
- The implementation order below is dependency order. For every implementation/documentation Chunk 00-08 plus corrective Chunk 03R: finish, verify, review, and land its implementation commit; then land the named tracker-accounting commit that modifies only this checklist and records that chunk's full implementation SHA and observed evidence. The accounting commit is required before the next implementation/documentation chunk starts. The append-only rechunk amendment itself lands as `docs(plan): rechunk activation corrections` and requires no recursive accounting commit.
- In the commit gate, “one concern” means one cohesive named chunk with one authority/recovery/documentation contract. Every implementation chunk owns 3-5 primary paths; documentation-only and tracker-accounting commits are explicit one-path exceptions. Genuinely unrelated work remains in separate focused chunks.
- Use a clean cutover. Preparatory Chunks 01-03 and corrective Chunk 03R may add or harden inert schema, types, helpers, and tests, but MUST NOT allow creation, resume, or interpretation of a new-contract run. Activation Chunk 04 is the sole route switch. Pre-cutover durable runs follow the explicit fail-closed legacy contract in Chunk 04; clean cutover does not mean silently reinterpreting their evidence.
- Each implementation/documentation Chunk 00-08 and corrective Chunk 03R has one conventional implementation commit and exactly one later tracker-accounting commit with subject `docs(plan): record handoff chunk NN` (using `03R` for the corrective chunk), modifying only `docs/plan/handoff-2026-0830-checklist.md`. That accounting commit records the implementation SHA, focused evidence, and review result and is required before the next implementation/documentation chunk. The planning amendment commit `docs(plan): rechunk activation corrections` is self-contained plan history and has no recursive accounting commit. Chunk 09 is the terminating tracker-accounting commit for immediately preceding documentation Chunk 08 plus final aggregate verification/classification; its subject is `docs(plan): record handoff chunk 08`, it cannot record its own SHA, and no recursive accounting commit follows.
- **Explicit product decision for H-02:** the currently supported boundary trusts the Host-selected evaluator registration and the managed DSH subprocess provider. DSH sandbox file-effects confinement is not adopted by this remediation. Therefore public and internal product claims must not promise hostile-code filesystem, process, privilege, or network isolation. Supporting that broader threat model is blocked on a separate explicit product change that adds and verifies a sandbox/deployment contract.
- The plan intentionally does **not** add a sandbox runtime, a second complexity score, a controller-owned compute-fairness mechanism, or an indefinite loop.
- All newly planned implementation, review, verification, and accounting boxes start unchecked. Planning this work is not evidence that the work is complete. A preparatory chunk may be complete only when its activation-gate tests prove the new contract remains unreachable. Historical checked boxes and evidence for completed Chunks 00-03 remain immutable.

## Status legend

- **Disposition — fix:** runtime behavior or runtime contract must change.
- **Disposition — document:** runtime behavior is intentional or already safe enough for the supported threat model, but the public contract must be corrected.
- **Disposition — no-fix:** claim exists, but no runtime or documentation remediation is required beyond preserving the stated product boundary.
- **Implementation:** owned source/document changes are complete.
- **Review:** focused review found no unresolved issue in the chunk's authority, durability, recovery, or documentation contract.
- **Accounting:** exact commit SHA and observed verification evidence have been recorded in this tracker.

## Finding ledger

### H-01 — The model can choose evaluator argv and environment

- **Exact claim:** The registered model-facing tool accepts evaluator `command`/`args`/`cwd`, environment overrides, and evaluator/dataset exceptional allowlists; validation is syntactic, so evaluator selection is not owned by a trusted Host.
- **Exists:** yes.
- **Disposition:** **fix** — runtime contract cutover.
- **Rationale:** Managed argv execution prevents implicit shell interpolation, but it does not make model-selected argv trusted. Evaluator selection, metric contract, environment, files, and dataset identity must originate in deployment configuration. The unified tool input is discriminated by run intent: a new-start branch (`resume_run_id` absent) requires `evaluator_id`, while a resume branch (`resume_run_id` present) forbids `evaluator_id`. This is the boring safe rule: resume locates the existing durable run by `resume_run_id`, derives evaluator identity exclusively from the tracker, and never accepts or uses a submitted evaluator ID for lookup, comparison, fallback, migration, or terminal replay.
- **Evidence:** current unified input/discriminants and model-selected authority at `src/types.ts:30-68`; registration at `src/index.ts:93-106`; pre-fix discovery/policy ordering at `src/controller.ts:131-153`; evaluator execution at `src/evaluator.ts:224-259,383-390`; Host config parsing at `src/config.ts:148-204`; README trust claims at `README.md:7-12`.
- **Owner chunks:** Chunks 01-04; Chunk 04 is the sole activation cutover.
- **Dependencies:** Chunks 01-03 prepare inert durable, file-boundary, and Host-contract machinery; Chunk 04 activates the complete authority and frozen-identity contract used by H-03/H-04/H-05.
- **Exact verification:** Reject removed raw evaluator/environment/provenance/metric keys as unknown model input. For the new-start branch, reject omitted or unknown `evaluator_id` before Git discovery, tracker creation, worktree/ref allocation, ownership, child creation, mutation, or spawn. For the resume branch, omission of `evaluator_id` is the only valid shape; any submitted value is rejected by the discriminated schema before repository/tracker lookup, whether it would be matching, mismatching, or unknown, and is never used for lookup. With the field omitted, allow only non-mutating repository discovery needed to locate the repo-scoped named tracker and recover its durable evaluator ID, registration fingerprint, manifest, and latest accepted HEAD; then permit an exact current registration match, but typed-block a missing/renamed ID or changed registration before Git mutation/worktree allocation, ownership acquisition/takeover, retention mutation, child/evaluator spawn, or attempt/candidate mutation. An omitted-field legacy terminal resume replays only durable terminal evidence without registration lookup, ownership, allocation, mutation, or spawn; every legacy resume that submits `evaluator_id` is rejected at schema discrimination first. Assert spawned argv/cwd/env/metric/direction exactly equal the Host registration selected for a new start or matched from durable identity on resume; assert hostile `bash -c`, `PATH`, `NODE_OPTIONS`, and model-supplied file allowlists cannot override it.
- [x] Implementation
- [x] Review
- [x] Accounting

### H-02 — Evaluator execution is managed but not sandbox-confined

- **Exact claim:** Evaluators run through `ctx.subprocess`, not the separate DSH sandbox seam; process lifecycle is managed, but filesystem, network, privilege, and same-UID effects are not OS-confined by this plugin.
- **Exists:** yes.
- **Disposition:** **document** — explicit product decision to retain the managed-subprocess boundary; no runtime sandbox change.
- **Rationale:** For the current supported product boundary, the Host-selected evaluator and managed DSH subprocess provider are trusted. Exact argv, bounded output, timeout/cancellation, process-tree termination, and quiescence are managed, but DSH sandbox file-effects confinement is not adopted and this plugin provides no hostile-code filesystem, process, privilege, same-UID, or network isolation. A broader threat model is not silently deferred implementation work: it is blocked on an explicit product change defining and verifying a sandbox/deployment contract.
- **Evidence:** `src/index.ts:29,75-84`; `src/controller.ts:279-282`; `src/evaluator.ts:252-259`; subprocess and sandbox contracts cited by the audit; this checklist's explicit product decision.
- **Owner chunk:** Chunk 08.
- **Dependencies:** Chunk 04, so documentation describes the activated Host-owned evaluator selection rather than model-owned argv.
- **Exact verification:** README must state the trusted Host/managed-subprocess boundary and the managed lifecycle guarantees, while explicitly denying OS/filesystem/process/network sandbox or privilege-boundary guarantees. It must prohibit claims that hostile evaluator or candidate code is isolated, direct deployments requiring that property to a separately selected external sandbox/read-only execution provider, and state that first-party support for that broader threat model requires an explicit product change.
- [ ] Implementation
- [ ] Review
- [ ] Accounting

### H-03 — Configured dataset provenance always mismatches at attempt time

- **Exact claim:** Initialization includes `provenance.dataset` in the frozen provenance, but production baseline/candidate attempts omit dataset metadata when calling `runEvaluator()`, producing a deterministic `provenance-mismatch` whenever the public dataset label is configured.
- **Exists:** yes.
- **Disposition:** **fix** — runtime provenance consistency.
- **Rationale:** This is a controller-boundary defect in an advertised input path. One canonical Host-owned dataset identity must feed initialization and every fresh/resumed attempt. Registration drift is resolved before attempt construction and yields the typed immutable-registration block activated in Chunk 04, not an attempt-time provenance mismatch.
- **Evidence:** `src/config.ts:148-182`; `src/controller.ts:147-153,269-296,432`; `src/evaluator.ts:140-158,202-210`; mismatch handling at `src/controller.ts:308-310`.
- **Owner chunks:** Chunks 01-04; behavior activates only in Chunk 04.
- **Dependencies:** Chunks 01-03 prepare the atomic Host-owned registration/manifest contract without making it runnable; Chunk 04 activates it.
- **Exact verification:** With a configured dataset, baseline and candidate must reach normal measurement/decision rather than `baseline-blocked`; persisted run provenance and every baseline/candidate/resumed attempt spawn provenance must be byte-identical. `provenance-mismatch` is reserved for attempt evidence that diverges from the already accepted durable registration/provenance; missing or changed current registrations block earlier as `evaluator-registration-mismatch`.
- [x] Implementation
- [x] Review
- [x] Accounting

### H-04 — Evaluator-file freezing exists only in the low-level helper

- **Exact claim:** `src/evaluator.ts` can hash and revalidate declared evaluator files, but production controller boundary creation never supplies `evaluatorFiles`, so controller runs have empty evaluator file hashes and a mutable scorer can escape name-based Git protection.
- **Exists:** yes.
- **Disposition:** **fix** — runtime fixed-judge enforcement.
- **Rationale:** Fixed evaluator bytes are a core trust invariant. The Host declares repository-relative regular-file paths, not expected local-file hashes. At run creation, after allocating an isolated worktree at exactly `start_commit`, SHA-256 content digests are derived from those checked-out bytes, persisted in the normalized registration manifest, and rechecked for every attempt/resume. Device/inode identity is attempt-local anti-swap evidence only and is never compared across worktrees or processes.
- **Evidence:** `src/evaluator.ts:107-158,201-205`; omissions at `src/controller.ts:147-150,278-282,432`; heuristic protection at `src/git.ts:201-216,399-400`; helper-only coverage in `tests/evaluator.spec.ts`.
- **Owner chunks:** Chunks 01, 02, and 04; Chunk 04 is the sole activation cutover.
- **Dependencies:** Chunk 01 defines inert durable manifest authority, Chunk 02 defines inert derivation/revalidation enforcement, and Chunk 04 wires both atomically as the sole runtime authority.
- **Exact verification:** A Host-declared scorer such as `scripts/score.mjs` must be protected even with `mutable_globs: ['**']`. Missing, symlinked, renamed, content-replaced, or attempt-local inode/dev-swapped files block before or after spawn as appropriate. SHA-256 digests derived at run creation from the isolated worktree at exactly `start_commit` must match baseline/candidate checks. On resume after one or more accepted candidates, reconcile the worktree to the latest durable accepted HEAD and independently recompute every frozen digest against the run-creation manifest. A dirty caller checkout must not influence either identity. Failure while allocating/checking out the initial isolated worktree or atomically persisting the run, manifest, and fingerprint must leave no resumable partial run, release any newly acquired claim/lock, and remove only newly allocated worktree/ref state.
- [x] Implementation
- [x] Review
- [x] Accounting

### H-05 — Dataset files are neither declared nor content-frozen

- **Exact claim:** Dataset provenance is only label/metadata; there is no production dataset-file manifest, hashing, protection, or pre/post-spawn revalidation, so mutable local data is not bound to the fixed evaluation contract.
- **Exists:** yes.
- **Disposition:** **fix** — runtime fixed-data enforcement through the same Host-owned evaluator/dataset contract as H-04.
- **Rationale:** Local datasets use the same path-and-derived-digest model as evaluator files. External datasets require a Host-supplied immutable identity with an explicit algorithm-qualified digest (for example `sha256:<64 lowercase hex>`). Model-submitted paths, labels, or allowlists would recreate the authority defect.
- **Evidence:** `src/types.ts:17-20,65`; `src/evaluator.ts:11-18,107-113,140-158`; `src/controller.ts:278-282,432`; heuristic dataset protection at `src/git.ts:399-400`.
- **Owner chunks:** Chunks 01, 02, and 04; Chunk 04 is the sole activation cutover.
- **Dependencies:** Chunk 01's inert durable identity plus Chunk 02's shared inert hash/revalidation machinery; Chunk 04 activates the Host-owned registration contract.
- **Exact verification:** For local data, Host-declared files such as `data/train.json` must be protected under broad mutable globs and replacement/rename/symlink/content changes must block; dev/inode checks are attempt-local only. For external data, the normalized algorithm-qualified immutable digest must remain stable across baseline/candidate/resume. Resume after accepted candidates must reconcile the latest durable accepted HEAD while independently proving local dataset bytes still match the run-creation manifest. Same ID with any normalized registration change, renamed ID with identical bytes, external digest rotation, and deployment rollback to a different fingerprint all typed-block before spawn as `evaluator-registration-mismatch`; model labels or unregistered paths must not alter identity.
- [x] Implementation
- [x] Review
- [x] Accounting

### H-06 — Timeout is not a fixed fair-compute budget

- **Exact claim:** The controller enforces a wall-clock timeout ceiling, not fixed steps, epochs, CPU/GPU time, FLOPs, or an exact Karpathy-style compute budget.
- **Exists:** yes.
- **Disposition:** **no-fix** — intentional evaluator-owned fair-compute contract.
- **Rationale:** The plugin is a bounded experiment controller. Comparable compute methodology belongs in the trusted Host-owned evaluator; the controller watchdog is a safety ceiling, not resource accounting. A sandbox alone would not provide compute fairness.
- **Evidence:** tool/config timeout and candidate-cap paths in `src/types.ts`, `src/config.ts`, and `src/controller.ts`; audit comparison to the evaluator-owned policy; README's bounded metric-driven positioning.
- **Owner chunk:** none for runtime; Chunk 08 must avoid contradicting this boundary while documenting H-02/H-15.
- **Dependencies:** Host ownership activated by Chunk 04 makes evaluator-owned fairness meaningful.
- **Exact verification:** Confirm no second budget mechanism is introduced; public wording must continue to distinguish per-attempt wall-clock watchdog from evaluator-defined comparable compute methodology; baseline/candidates/resume must use the same immutable evaluator registration.
- [ ] Implementation
- [ ] Review
- [ ] Accounting

### H-07 — A quiescent candidate failure terminates the entire run

- **Exact claim:** A candidate evaluator crash, non-zero exit, or timeout is durably recorded but cleanup reconciles the run to `round-failed` instead of restoring the accepted worktree, consuming the candidate slot, and continuing to the next proposal.
- **Exists:** yes.
- **Disposition:** **fix** — runtime continuation for exactly classified, proven-safe candidate failures.
- **Rationale:** Ordinary candidate failures are expected research outcomes. Continuation is safe only after durable evidence and whole-process-tree quiescence; uncertainty, cancellation, provenance/file-policy violations, contradictory state, and exhausted recovery reruns remain terminal or blocked according to the exhaustive matrix below.
- **Evidence:** `src/controller.ts:331-337,353-356`; handoff lines 383-436; existing tracker/Git rejected-head reconciliation paths.
- **Owner chunk:** Chunk 06.
- **Dependencies:** Chunk 05, so the next child receives durable bounded failure context.
- **Exact verification:** Exercise every row of the failure-code continuation matrix on live execution and resume at each cleanup barrier. For continuable rows assert terminal failed experiment plus bounded artifacts/context retained, accepted HEAD restored before child creation, exactly one ordinal consumed, claim/lock retained only for normal run continuation, and no duplicate attempt/candidate. For terminal/blocked rows assert no next child. Baseline failures never use candidate continuation.

| Evaluator/recovery code | Candidate outcome after durable whole-tree quiescence | Ordinal | Accepted HEAD | Artifacts/evidence | Claim/lock and next child |
|---|---|---|---|---|---|
| `exit`, `signal`, `timeout`, `output-limit`, `metric-protocol` | **Continuable** on live and resumed cleanup | Consume exactly one | Restore before transition to `ready` | Retain provider-bounded/redacted artifacts and structured failure facts | Retain the active run claim/lock through continuation; create the next child only if budget remains; release normally at final termination |
| `spawn` | **Continuable only** when spawn failure proves no child process was created and durable failure evidence is complete; otherwise **blocked** as uncertain process state | Consume one only in the proven-no-process case; no synthetic consumption when uncertain | Restore before proven-safe continuation; no accepted-HEAD mutation when uncertain | Retain structured spawn facts; no invented stdout/stderr | Proven-no-process case retains normal run ownership and may create the next child if budget remains; uncertain case retains claim/lock for operator recovery and creates no child |
| `cancelled` | **Terminal cancelled**, never candidate-continuable | Do not synthesize extra consumption beyond durable state | Reconcile through canonical cancellation path | Retain cancellation evidence | After durable terminal result and proven quiescence, release claim/lock; no next child |
| `provenance-mismatch` and evaluator/dataset file-policy or manifest violations | **Blocked** immutable-policy/provenance violation | No continuation consumption beyond a durably existing candidate ordinal | Preserve the last durably validated accepted HEAD; do not present restoration as safe continuation | Retain authoritative mismatch facts | With no live process and after durable block evidence, release claim/lock; no next child or evaluator spawn |
| `recovery-rerun-exhausted` | **Blocked** because canonical measurement cannot be recovered safely | No new ordinal | Preserve the last durably validated accepted state; do not manufacture a rejection | Retain all provider-bounded rerun-attempt artifacts and structured facts | After durable block evidence and proven rerun-process quiescence, release claim/lock; no further rerun and no next child |
| non-quiescent/unknown process survival, Git/tracker contradiction, persistence/controller failure | **Blocked** | No synthetic consumption | No speculative mutation | Retain available authoritative facts | Retain claim/lock for operator recovery because safe release/reconciliation is unproven; no next child |
- [x] Implementation
- [x] Review
- [x] Accounting

### H-08 — Proposal research annotations are discarded

- **Exact claim:** The child report collects hypothesis, intended edits, and implementation summary, but production discards them except for the optional blocker claim; they are absent from durable history and the next-child handoff.
- **Exists:** yes.
- **Disposition:** **fix** — persist bounded untrusted research memory.
- **Rationale:** These fields help avoid repeated failed ideas but must remain explicitly non-authoritative. Host-observed paths, commits, metrics, and decisions remain separate mechanical facts.
- **Evidence:** `src/agent.ts:42-50,78-82,162-178`; discard path at `src/controller.ts:235-245`; TSV history at `src/tracker.ts:299-303`.
- **Owner chunk:** Chunk 05.
- **Dependencies:** Chunk 04 activates the durable evaluator/dataset identity before tracker/history evolution.
- **Exact verification:** In a two-candidate run, persist distinctive hypothesis/intended edits/summary and show them in the second handoff and after close/reopen/resume; false annotations must not change command, metric, Git validation, acceptance, target, or recovery; migrated older rows must render an honest unavailable/absent marker.
- [x] Implementation
- [x] Review
- [x] Accounting

### H-09 — Later children cannot inspect rejected changes or useful diagnostics

- **Exact claim:** Rejected commits and artifact bytes are retained, but proposal children receive only commit/metric/status references, have no Git/Bash access, and cannot dereference artifact contents; run-level failure evidence is often generic rather than a bounded actionable diff/diagnostic summary.
- **Exists:** yes.
- **Disposition:** **fix** — add Host-generated bounded summaries without widening child tools.
- **Rationale:** Preserve the child-tool restriction. Generate structured changed-path/diff statistics from immutable candidate Git evidence and structured diagnostics from an allowlisted vocabulary: failure code, exit/signal/timeout/output-limit/truncation facts, artifact availability, and bounded changed-path statistics. Do not place arbitrary evaluator stdout/stderr tails in child handoff. Existing artifacts remain provider-bounded and redact only configured known secret values; no claim of universal secret-freedom is permitted.
- **Evidence:** restricted inherited tools and history in `src/agent.ts`; artifact references in `src/evaluator-artifacts.ts:53-77` and `src/types.ts:77-84,199-204`; generic evidence at `src/controller.ts:353-356,438-449`; rendering in `src/render.ts:12-24`.
- **Owner chunk:** Chunk 05.
- **Dependencies:** H-08 durable history storage and existing Git/artifact identity checks.
- **Exact verification:** A rejected candidate followed by another proposal must yield bounded Host-observed paths/diff statistics after worktree restoration. Failure handoff uses only the enumerated structured vocabulary plus artifact available/pruned/unavailable markers, never raw log text, a full patch, an arbitrary path reader, or Bash. Persisted stdout/stderr artifacts remain provider-bounded and apply exact configured-value redaction across chunk boundaries, multiline values, and truncation; adversarial encoded/transformed/unknown values demonstrate the documented residual disclosure risk rather than supporting a secret-free claim. Summaries survive recovery and stay within `maxHandoffChars`.
- [x] Implementation
- [x] Review
- [x] Accounting

### H-10 — Cancelled replay fabricates `lastState: initializing`

- **Exact claim:** Live cancellation records the actual durable predecessor state, but terminal replay reconstructs every cancelled result with hard-coded `lastState: 'initializing'`, so fresh and resumed canonical results diverge.
- **Exists:** yes.
- **Disposition:** **fix** — runtime canonical replay.
- **Rationale:** The existing run transition into `cancelled` already contains `from_state`; replay must derive and validate it rather than add a duplicate column or guess.
- **Evidence:** live path `src/controller.ts:381-398`; replay path `src/controller.ts:401-412`; transition persistence `src/tracker.ts:256-273,420-424`; result schema `src/types.ts:237-243,373-376`.
- **Owner chunk:** Chunk 07.
- **Dependencies:** Chunk 06 lands first because both modify controller/recovery terminal handling.
- **Exact verification:** Cancel from every reachable origin (`initializing`, `baseline-running`, `ready`, `candidate-prepared`, `candidate-running`, `deciding`); first and resumed canonical results must be deeply equal and `lastState` must equal the durable transition's `from_state`; missing, duplicate, or malformed cancellation evidence must block as ambiguous; replay must spawn no child/evaluator and mutate no Git/attempt state.
- [ ] Implementation
- [ ] Review
- [ ] Accounting

### H-11 — Automatic stale-controller takeover depends on Linux `/proc`

- **Exact claim:** Dead-owner takeover can be proven only on Linux with a recorded `/proc/<pid>/stat` start token; on non-Linux an abnormal-exit claim cannot be automatically replaced, while README currently presents crash recovery without that qualification.
- **Exists:** yes.
- **Disposition:** **document** — Linux `/proc` limitation; no runtime takeover change.
- **Rationale:** Current behavior is conservative fail-closed, and lease expiry alone is intentionally not proof of death. Normal managed execution may work elsewhere, but automatic crash-left claim takeover is platform-limited.
- **Evidence:** `src/git.ts:109-126,368-385`; claim acquisition at `src/controller.ts:133-160`; retention use at `src/retention.ts:44-69`; unqualified README requirements/recovery wording.
- **Owner chunk:** Chunk 08.
- **Dependencies:** none beyond final documentation review.
- **Exact verification:** README must state that automatic stale-claim takeover after abnormal host death requires Linux `/proc` start-token evidence; non-Linux stale claims remain conservatively blocked and lease expiry alone is insufficient. It must not claim the entire plugin is Linux-only unless code/package policy separately changes.
- [ ] Implementation
- [ ] Review
- [ ] Accounting

### H-12 — README install tarball version is stale

- **Exact claim:** The manifest is version `0.1.4`, while checkout/release-like README commands name `dsh-autoresearch-0.1.0.tgz`, which can be absent or install an obsolete ignored artifact.
- **Exists:** yes.
- **Disposition:** **document** — documentation fix.
- **Rationale:** Runtime and pack logic derive the current version correctly; only the public install example drifted.
- **Evidence:** `package.json:2-3`; `README.md:34-41,52`; manifest-derived filename logic in `scripts/release-smoke.mjs:18-45,113-123`; `.gitignore:4`.
- **Owner chunk:** Chunk 08.
- **Dependencies:** final package version remains the source of truth.
- **Exact verification:** Remove every stale `0.1.0` checkout tarball reference; use the exact current `0.1.4` artifact or version-derived/`pnpm pack` output wording; release documentation assertions must compare against `package.json.version` rather than another duplicated literal.
- [ ] Implementation
- [ ] Review
- [ ] Accounting

### H-13 — README tracker schema version is stale

- **Exact claim:** Runtime tracker schema is v6, but the README project layout says schema v5 while another README diagram already says v6.
- **Exists:** yes.
- **Disposition:** **document** — documentation fix.
- **Rationale:** Runtime migrations and fingerprint checks already use the correct schema; the public text is internally inconsistent. If Chunk 01 or Chunk 05 introduces a later schema, documentation must name that final version once, not temporarily record v6.
- **Evidence:** `src/tracker.ts:8,361-387,428-446`; `README.md:58-68,130-147`; tracker migration tests.
- **Owner chunk:** Chunk 08.
- **Dependencies:** Chunk 05, because its storage design may advance `TRACKER_SCHEMA_VERSION`.
- **Exact verification:** All current README schema claims must match the final `TRACKER_SCHEMA_VERSION`, or be made version-neutral with the source constant identified as authority; packed README must contain no stale v5 statement.
- [ ] Implementation
- [ ] Review
- [ ] Accounting

### H-14 — Simplicity constraints are advisory, not Host-enforced

- **Exact claim:** Constraints are normalized and hash-bound but used only as proposal-child prompt guidance; Host keep/reject uses protected-path validation and one strict scalar metric, not an independent simplicity/complexity criterion.
- **Exists:** yes.
- **Disposition:** **document** — advisory constraints; no runtime simplicity rule.
- **Rationale:** This is an intentional bounded single-metric product contract. Simplicity must be encoded in the trusted evaluator/objective or enforced through the mutable surface; free-form child claims cannot become authority.
- **Evidence:** `src/types.ts:30-68,94-110`; `src/config.ts:148-182`; `src/agent.ts:78-105,162-178`; `src/git.ts:201-217`; decision replay at `src/recovery.ts:203-229`.
- **Owner chunk:** Chunk 08.
- **Dependencies:** Chunk 04's final evaluator/objective wording.
- **Exact verification:** README/tool descriptions must call constraints immutable advisory proposal guidance and state that Host acceptance remains strict comparison of the configured scalar metric; no complexity field, hidden tie-breaker, or authoritative report field may be introduced.
- [ ] Implementation
- [ ] Review
- [ ] Accounting

### H-15 — The product is bounded, not an indefinite autonomous loop

- **Exact claim:** Runs stop at an immutable configured candidate cap rather than looping until a human stops them; the shipped defaults are 20 candidates and a deployment maximum of 100, but 100 is configured rather than a universal code constant.
- **Exists:** yes.
- **Disposition:** **document** — configured candidate bound; no indefinite loop.
- **Rationale:** Bounded execution is an intentional safety/product divergence from literal Karpathy autoresearch. Baseline is separate, target/cancellation/blocking can stop earlier, and operators may explicitly start another run.
- **Evidence:** `cordis.patch.yml:1-23`; `src/config.ts:54-87,113-182`; immutable resume policy at `src/recovery.ts:93-114`; stop logic at `src/controller.ts:197-220`; README budget/config sections.
- **Owner chunk:** Chunk 08.
- **Dependencies:** Chunk 06 must preserve ordinal consumption and bounded termination after continued failures.
- **Exact verification:** README must say default candidate cap 20 and configured deployment maximum (shipped default 100), baseline separate, target/budget termination, and no indefinite mode; no wording may claim a universal hard-coded 100 or automatic run chaining; controller tests must continue to prove failed candidates consume one bounded ordinal.
- [ ] Implementation
- [ ] Review
- [ ] Accounting

## Sequential implementation chunks

### Activation gate for preparatory trust work

Chunks 01-03 and corrective Chunk 03R are deliberately inert preparation. Until Chunk 04 lands, the registered model-facing schema and controller/recovery dispatch remain the legacy route; no code path may create, resume, classify, migrate, or replay a run using the new contract generation, evaluator ID, registration fingerprint, or manifest. Preparatory tests may construct and round-trip primitives only through test-local/helper APIs. Each preparatory chunk must include a negative activation test proving production start/resume dispatch cannot reach those primitives and that no tracker created by production contains the new-contract marker. Chunk 04 may activate only after the Chunk 03R implementation and `docs(plan): record handoff chunk 03R` accounting commit land, all four negative gates pass together at the 03R tip, and its integration tests prove the complete schema, registry, manifest, provenance, rollback, terminal-authority, legacy-block, and recovery contract switches atomically.

### Chunk 00 — Establish and protect this tracker

- **Claims:** H-01 through H-15 accounting only.
- **Primary target paths:** documentation-only exemption — exactly `docs/plan/handoff-2026-0830-checklist.md`.
- **Work:** Preserve `docs/plan/PLAN.md` and `docs/plan/CHECKLIST.md`; initialize every status unchecked; make this tracker the sole live remediation record.
- **Depends on:** none.
- **Exact verification:** The implementation commit changes only this file; every H row contains claim, existence, disposition, rationale, evidence, owner, dependencies, exact verification, and three unchecked statuses.
- **Implementation commit:** `e2d3e1ef8a7fb053afad0f8874621a34aa67d712` (`docs(plan): add handoff remediation checklist`).
- **Focused verification:** Commit inspection confirms the implementation changed only `docs/plan/handoff-2026-0830-checklist.md`; H-01 through H-15 each contain claim, existence, disposition, rationale, evidence, owner, dependencies, exact verification, and three initially unchecked statuses.
- **Focused review:** Clean; independent plan gates found no unresolved tracker-structure, scope, or accounting issue.
- **Required tracker-accounting commit:** `docs(plan): record handoff chunk 00`; this checklist-only accounting change is ready to land before Chunk 01 starts. Its SHA remains external until the commit exists.
- **Rollback:** Revert the tracker-only implementation and accounting commits before dependent work begins; no code, runtime state, or historical plan requires migration.
- [x] Implementation complete
- [x] Focused verification complete
- [x] Focused review complete
- [x] Tracker-accounting commit complete

### Chunk 01 — Prepare inert durable registration and manifest primitives

- **Claims:** H-01, H-03, H-04, H-05 preparation only; no runtime activation.
- **Primary target paths (3):** `src/types.ts`, `src/tracker.ts`, `src/recovery.ts`.
- **Secondary focused tests:** `tests/tracker.spec.ts`, `tests/recovery.spec.ts`, and type-level contract fixtures.
- **Work:** Define the normalized evaluator/dataset registration, contract-generation marker, evaluator ID, algorithm-qualified external digest, path→SHA-256 manifest, registration fingerprint, and typed registration/legacy block evidence. Add append/read transaction primitives that can atomically persist and validate a complete new-contract run identity, but do not call them from production start, resume, terminal replay, migration, or recovery dispatch. Schema recognition must distinguish legacy raw-policy evidence without reinterpreting it. Terminal legacy evidence remains unchanged; no preparatory migration may manufacture new authority.
- **Depends on:** Chunk 00 and its tracker-accounting commit.
- **Exact verification:** Focused tracker/recovery tests prove canonical normalization, length-prefix hashing, complete atomic write/rollback, corruption rejection, and legacy/new schema discrimination through helper APIs. The activation-gate test proves production start/resume cannot write or interpret the new marker, evaluator ID, fingerprint, or manifest and existing legacy behavior remains the only reachable route.
- **Implementation commit:** `174ecb01d2834398c9b0c2496c0f53a679ed5730` (`feat(tracker): prepare evaluator registration identity`).
- **Focused verification:** `pnpm exec vitest run tests/tracker.spec.ts tests/recovery.spec.ts tests/controller.spec.ts` passed 3 files and 121 tests; `pnpm run typecheck` passed. LSP diagnostics were unavailable because no language server was installed.
- **Focused review:** Clean after multiple fix loops; two independent final reviewers found no unresolved issue. Resolved findings included deterministic UTF-16 canonical ordering and length-prefixed fingerprinting, evaluator/local-dataset path-overlap rejection, strict rejection of malformed, extended, duplicate-key, non-canonical, or mismatched durable registration evidence, monotonic registration presence, atomic registered-run rollback, and negative activation gates keeping production start, recovery, and terminal replay on the legacy route.
- **Required tracker-accounting commit:** `docs(plan): record handoff chunk 01`; this checklist-only accounting change is complete and ready to land before Chunk 02 starts. Its SHA remains external until the commit exists.
- **Rollback:** Revert the Chunk 01 implementation and checklist-only accounting commits before Chunk 02 begins. Do not down-migrate a tracker already opened at the advanced schema; roll forward while preserving legacy/new discrimination and durable registration evidence.
- [x] Implementation complete
- [x] Focused verification complete, including negative activation gate
- [x] Focused review complete
- [x] Tracker-accounting commit complete

### Chunk 02 — Prepare inert frozen-file boundary primitives

- **Claims:** H-04 and H-05 preparation only; no runtime activation.
- **Primary target paths (3):** `src/evaluator.ts`, `src/git.ts`, `src/types.ts`.
- **Secondary focused tests:** `tests/evaluator.spec.ts`, `tests/git.spec.ts`.
- **Work:** Add reusable primitives that validate sorted normalized repository-relative regular-file declarations, derive SHA-256 digests only from an isolated worktree checked out at exactly `start_commit`, protect exact evaluator/local-dataset paths regardless of mutable globs, recompute run-creation manifest digests on attempts/resume, and perform attempt-local pre/post-spawn device/inode anti-swap checks. External datasets use only normalized algorithm-qualified immutable identity. These helpers remain uncalled by production controller/recovery routes.
- **Depends on:** Chunk 01 and its tracker-accounting commit.
- **Exact verification:** Focused evaluator/Git tests cover missing, symlinked, renamed, content-replaced, broad-glob, dirty-caller, external-digest, and attempt-local inode/dev swap cases. The activation-gate test proves production runs still cannot derive, persist, enforce, resume, or interpret a new-contract manifest.
- **Implementation commit:** `75949d0fe7aa504537e98b5941e14f7da364279e` (`feat(evaluator): prepare frozen input verification`).
- **Focused verification:** `pnpm exec vitest run tests/evaluator.spec.ts tests/git.spec.ts` passed 2 files and 78 tests; `pnpm run typecheck` passed.
- **Focused review:** Clean after resolving alias handling, immutable-object behavior, and property-descriptor findings; one clean final reviewer found no unresolved issue. The sole contrary finding demanded runtime activation, but two independent reviews refuted it because production activation is explicitly prohibited until Chunk 04.
- **Required tracker-accounting commit:** `docs(plan): record handoff chunk 02`; this checklist-only accounting change is complete and ready to land before Chunk 03 starts. Its SHA remains external until the commit exists.
- **Rollback:** Revert the Chunk 02 implementation and checklist-only accounting commits before Chunk 03 begins; the helpers are inert, so preserve existing evaluator behavior and do not activate or interpret the new frozen-input contract.
- [x] Implementation complete
- [x] Focused verification complete, including negative activation gate
- [x] Focused review complete
- [x] Tracker-accounting commit complete

### Chunk 03 — Prepare inert Host registry and tool-contract machinery

- **Claims:** H-01 and H-03 preparation only; no runtime activation.
- **Primary target paths (4):** `src/config.ts`, `src/types.ts`, `src/index.ts`, `cordis.patch.yml`.
- **Secondary focused tests/fixtures:** `tests/contracts.spec.ts`, `tests/autoresearch.spec.ts`, `tests/composition.integration.spec.ts`, `tests/fixtures/harness-composition.ts`, and installed-package/composition fixtures that exercise configuration parsing.
- **Work:** Add internal parsing and normalization for unique Host-owned evaluator registrations: opaque ID, exact argv/cwd, metric name/direction/parser version, closed environment, evaluator paths, and optional local/external dataset identity. Add an activation-ready discriminated unified model schema: the new-start branch requires `evaluator_id` and forbids `resume_run_id`; the resume branch requires `resume_run_id` and forbids `evaluator_id`; both reject removed raw authority keys. Resume's evaluator identity is therefore derivable only from the durable tracker. Do not register that schema or route it to production start/resume. Duplicate/unknown IDs and hostile overrides are testable through inert registry/schema helpers only; the legacy registered route remains unchanged until Chunk 04.
- **Depends on:** Chunk 02 and its tracker-accounting commit.
- **Exact verification:** Focused config/contract/composition tests prove deterministic normalization, duplicate rejection, removed-key rejection, and branch discrimination in the activation-ready schema: new start rejects omitted evaluator ID and resolves/rejects submitted known/unknown IDs; resume accepts omitted evaluator ID and rejects every submitted evaluator ID identically before lookup, including values that are matching, mismatching, or unknown. Also prove exact registration lookup and fixture migration readiness. The activation-gate test proves the actually registered production tool and controller/recovery route cannot create, resume, or interpret new-contract runs and no production tracker gains a new marker.
- **Implementation commit:** `cf3d0c3` (`feat(config): prepare host evaluator registry`).
- **Focused verification:** `pnpm run build` passed; `pnpm exec vitest run tests/contracts.spec.ts tests/autoresearch.spec.ts tests/composition.integration.spec.ts` passed 3 files and 91 tests; `pnpm run typecheck` passed. Zero-activation evidence confirmed the new Host registry and activation-ready decoder remain unreachable from the registered production tool and controller/recovery routes: the legacy route remains registered, no new-contract run can be created, resumed, or interpreted, and no production tracker gains the new marker.
- **Focused review:** Clean after fixes for schema/config mutable-input parity, the omitted-dataset default, strict malformed-field rejection, full activation-decoder validation and deep freezing, and required Loader fields. Two independent final reviews found no unresolved issue.
- **Required tracker-accounting commit:** `docs(plan): record handoff chunk 03`; this checklist-only accounting change is complete and ready to land before Chunk 04 starts. Its SHA remains external until the commit exists.
- **Rollback:** Revert the Chunk 03 implementation and checklist-only accounting commits before Chunk 04 activation; the registry/schema machinery is inert, so retain the registered legacy route and do not create, resume, or interpret a new-contract run.
- [x] Implementation complete
- [x] Focused verification complete, including negative activation gate
- [x] Focused review complete
- [x] Tracker-accounting commit complete

### Corrective rechunk amendment

This append-only amendment follows the completed and accounted Chunk 03 record without rewriting any historical Chunk 00-03 SHA, evidence, review result, or checked status. It lands as `docs(plan): rechunk activation corrections`, adds Chunk 03R before activation, and is not followed by a recursive amendment-accounting commit.

For H-01, H-03, H-04, and H-05, this amendment adds Chunk 03R as an additional owner alongside Chunk 04. None of those findings may close Implementation, Review, or Accounting until both Chunk 03R and Chunk 04 have completed implementation and review and each chunk's required tracker-accounting commit has landed.

### Chunk 03R — Harden shared activation primitives

- **Claims:** Corrective preparation for H-01, H-03, H-04, and H-05 only; no runtime activation.
- **Primary target paths (5):** `src/tracker.ts`, `src/evaluator.ts`, `src/git.ts`, `src/state-layout.ts`, `src/types.ts`.
- **Secondary focused tests:** `tests/tracker.spec.ts`, `tests/evaluator.spec.ts`, `tests/git.spec.ts`, and `tests/contracts.spec.ts` as a secondary verification path because activation DSL parity belongs to shared types.
- **Work:** Absorb the review-required redesigns before activation: consistent SQLite read-only snapshots that preserve durable evidence rather than promising an overbroad mutation-free process—the source main/WAL bytes and sidecar existence remain unchanged, while transient coordination bytes in an already-existing SHM may change; a contract-generation marker with strict durable registration; rollback and terminal-authority primitives; a semantic provenance builder with manifest reconstruction; empty-manifest and frozen-file fixes; and the shared type, schema, and environment primitives required by those contracts. Keep every primitive unreachable from production start, resume, recovery, migration, classification, and terminal replay.
- **Depends on:** Completed Chunk 03 and its tracker-accounting commit.
- **Exact verification:** `pnpm exec vitest run tests/tracker.spec.ts tests/evaluator.spec.ts tests/git.spec.ts tests/contracts.spec.ts` plus `pnpm run typecheck`. At the Chunk 03R implementation tip, prove zero production activation: the registered tool and controller/recovery routes remain legacy-only, cannot create, resume, classify, migrate, or replay a new-contract run, and cannot durably write or interpret the new contract-generation marker, registration, provenance, or manifest. Snapshot verification requires source main/WAL bytes and sidecar existence to remain unchanged; transient coordination bytes in an already-existing SHM may change.
- **Implementation commit:** `d9c10369cdc83948dd6cd0960fe2d63caf1d2fac` (`fix(core): harden activation primitives`).
- **Review-fix commits:** `da87f21276a83f842cee15f6870818caada71751` and `aca459bb94a895078cda855f64c8fde5e7e356e5`.
- **Focused verification:** At the clean Chunk 03R tip, `pnpm exec vitest run tests/tracker.spec.ts tests/evaluator.spec.ts tests/git.spec.ts tests/contracts.spec.ts` passed 4 files and 177 tests; `pnpm run typecheck` passed. The zero-production-activation gate remained intact.
- **Focused review:** Clean; two final reviewers found no unresolved issue. Resolved findings included durable-evidence-preserving SQLite snapshot semantics, source main/WAL and sidecar-existence preservation with allowance for transient existing-SHM coordination bytes, strict generation/registration durability, rollback and terminal-authority behavior, semantic provenance and manifest reconstruction, empty-manifest/frozen-file handling, and shared activation DSL/type parity.
- **Required tracker-accounting commit:** `docs(plan): record handoff chunk 03R`; this checklist-only accounting change is complete and ready to land before Chunk 04 starts. Its SHA remains external until the commit exists.
- **Rollback:** Before activation, revert review-fix commits `aca459bb94a895078cda855f64c8fde5e7e356e5` and `da87f21276a83f842cee15f6870818caada71751`, then implementation commit `d9c10369cdc83948dd6cd0960fe2d63caf1d2fac`, together with the checklist-only accounting commit. Preserve the completed Chunk 00-03 history and legacy production route; do not activate partially hardened primitives. After activation, roll forward through the hardened shared contract rather than reverting durable evidence semantics.
- [x] Implementation complete
- [x] Focused verification complete, including zero production activation at the 03R tip
- [x] Focused review complete
- [x] Tracker-accounting commit complete

#### Chunk 03R reopened review-fix accounting (append-only)

- **Rationale:** Activation review reopened the already completed and accounted Chunk 03R because activation required a claim-preserving terminal lock recovery primitive; this was a defect in the shared helper contract, not a new activation chunk.
- **Later review-fix commits:** `653add91657902e3e4889796da510dbdb1d191b9` and `9d6b3ca503fa27256095765a1dbdc807188c6689`.
- **Clean-tip verification:** At the resulting clean Chunk 03R tip, `pnpm exec vitest run tests/git.spec.ts tests/tracker.spec.ts tests/evaluator.spec.ts tests/contracts.spec.ts` passed 4 files and 180 tests; `pnpm run typecheck` passed.
- **Reopened review result:** Clean; two final reviewers found no unresolved issue.
- **Accounting effect:** The prior Chunk 03R completion and tracker-accounting record remain valid historical facts. These later commits supersede the helper defect and are the current reviewed Chunk 03R preparation; Chunk 03R remains complete, with no new pending chunk or status introduced.

### Chunk 04 — Activate Host authority and frozen evaluator/data identity

- **Claims:** H-01, H-03, H-04, H-05 activation and legacy v6/raw-policy resume contract.
- **Primary target paths (5):** `src/index.ts`, `src/controller.ts`, `src/recovery.ts`, `src/config.ts`, `src/retention.ts`.
- **Secondary migrated tests/fixtures:** all remaining migrated tests and fixtures, including focused contract, controller, recovery, restart, retention, composition, and installed-package coverage plus every fixture/caller that constructs tool input or Host config. Chunk 04 consumes the reviewed Chunk 03R primitives but does not redesign their shared contracts; a defect requiring redesign reopens Chunk 03R instead of enlarging activation.
- **Work:** Switch the registered discriminated unified tool contract and production start/resume dispatch atomically to the already-reviewed primitives. A new start requires `evaluator_id`, resolves it before repository discovery or mutation, allocates the isolated `start_commit` worktree, derives manifest bytes there, atomically persists run, manifest, generation, ID, fingerprint, and provenance, and only then permits spawn. Roll back failed checkout/hashing/persistence without a resumable partial run. A resume requires `resume_run_id` and forbids `evaluator_id`; reject any submitted evaluator ID at schema discrimination before repository/tracker lookup regardless of whether it is matching, mismatching, or unknown. With the field omitted, perform only read-only repository/run lookup, derive evaluator ID exclusively from durable tracker identity, and use that durable ID—never caller input—to resolve and compare the current registration before ownership/takeover, retention/allocation, mutation, or spawn. A missing/renamed durable ID or changed registration typed-blocks at that barrier; an exact match may then reconcile to latest durable accepted HEAD and independently recheck the run-creation manifest. Spawn spec and attempt provenance come only from the matched Host registration.

  Every pre-cutover raw-policy tracker lacking the new marker plus evaluator ID/fingerprint is non-resumable. Detect it after read-only lookup/schema recognition and before policy comparison, ownership/takeover, allocation, spawn, or mutation. Terminal legacy runs replay only existing terminal evidence. Nonterminal legacy runs preserve tracker state, active durable lock, audit refs, artifacts, and isolated worktree indefinitely and typed-block as `legacy-evaluator-policy-unsupported`; do not terminalize, release ownership, auto-migrate, hash current config into new authority, or let retention delete them.
- **Depends on:** Chunk 03R and its `docs(plan): record handoff chunk 03R` accounting commit; all four preparatory negative activation gates must pass together at the 03R tip immediately before activation.
- **Exact verification:** Run focused contract/evaluator/Git/controller/recovery/restart/composition/installed-package tests plus typecheck. Prove the pre-activation gate, then the sole activation switch. New-start acceptance cases: omitted `evaluator_id` is rejected, unknown ID is rejected before discovery/mutation, and a known ID alone selects the Host registration. Resume acceptance cases, all before ownership/takeover, retention/allocation, mutation, or spawn: omitted `evaluator_id` derives identity exclusively from the durable tracker and proceeds only on an exact current registration match; submitted matching, mismatching, and unknown IDs are each rejected by schema before lookup and never influence registration lookup; a missing/renamed durable ID or registration drift/digest rotation/rollback typed-blocks after read-only durable lookup. Legacy-terminal cases: omitted `evaluator_id` replays durable terminal evidence without current registration lookup or any ownership/allocation/mutation/spawn, while any submitted evaluator ID is rejected at schema discrimination; nonterminal legacy cases retain the documented fail-closed behavior. Also prove complete manifest/fingerprint creation is atomic; exact Host spawn/provenance is used; broad-glob/tamper/symlink/rename/content/inode cases block; accepted-HEAD resume and independent manifest checks both run; removed raw keys have no alias; and no mixed-generation route exists.
- **Implementation commit:** `4b9e93efcb343b9a9cf017ba47605dc44e867e6a` (`fix(security): activate host evaluator authority`).
- **Focused verification:** `pnpm run build` passed; the focused suite passed 10 files with 327 tests passed and 6 skipped; `pnpm run typecheck` passed. Acceptance coverage confirmed Host `evaluator_id` authority with raw model inputs removed, byte-consistent dataset provenance, evaluator/local-dataset manifest and file freezing, clean legacy/current cutover, read-only preclaim classification, required migrations, terminal claim and retention behavior, and rollback safety.
- **Focused review:** Clean after review-fix loops; three independent final reviewers found no unresolved issue across authority, provenance, frozen identity, cutover, recovery, migration, terminal claims/retention, or rollback.
- **H-02 boundary:** Unchanged by decision: DSH sandbox confinement remains document-only work owned by Chunk 08; Chunk 04 adds no sandbox runtime or hostile-code isolation claim.
- **Required tracker-accounting commit:** `docs(plan): record handoff chunk 04`; this checklist-only accounting change is complete and ready to land before Chunk 05 starts. Its SHA remains external until the commit exists.
- **Rollback:** Before any new-contract run exists, revert the Chunk 04 implementation and checklist-only accounting commits only with legacy/new guards intact. After a new-contract run exists, roll forward while preserving durable manifests, fingerprints, provenance, migrations, terminal evidence, claims/locks, retained legacy state, and rollback evidence; never reinterpret either current or legacy policy.
- [x] Implementation complete
- [x] Focused verification complete, including tested atomic activation gate
- [x] Focused review complete
- [x] Tracker-accounting commit complete

### Chunk 05 — Persist bounded untrusted research memory

- **Claims:** H-08, H-09.
- **Primary target paths (5):** `src/tracker.ts`, `src/agent.ts`, `src/controller.ts`, `src/git.ts`, `src/evaluator-artifacts.ts`.
- **Secondary migrated tests/call sites:** focused tracker/agent/Git/evaluator/controller/recovery tests; `src/types.ts`, `src/render.ts`, or `src/evaluator.ts` only when required by an existing seam.
- **Work:** Persist validated hypothesis/intended edits/implementation summary as explicitly untrusted annotation in the same transaction that creates its experiment after the trusted Git snapshot. Append Host-observed commit, changed paths, deterministic diff statistics, and allowlisted structured failure facts idempotently. Define recovery at report→snapshot→experiment→commit→evaluation→publication barriers with no orphan, duplicate, cross-candidate, or premature entry. Retain provider-bounded/redacted artifacts, expose no raw log/full patch/arbitrary reader/Bash, and render deterministic newest-first bounded handoff with honest unavailable/pruned markers. A schema migration does not make Chunk 04 legacy policies resumable.
- **Depends on:** Chunk 04 and its tracker-accounting commit.
- **Exact verification:** Focused tests and typecheck cover every named crash barrier, atomic annotation ownership, migration/reopen idempotence, structured vocabulary, redaction/truncation residual-risk cases, size caps, deterministic history/TSV, pruning, and non-authoritative false annotations.
- **Implementation commit:** `acf5875ebe6851c8de0501393cff3dfd3c141f04` (`feat(research): persist bounded experiment context`).
- **Focused verification:** The focused suite passed 6 files with 256 tests passed; `pnpm run typecheck` passed. Coverage confirmed bounded explicitly untrusted hypothesis/intended-edits/implementation-summary annotations; Host-observed commit facts, changed paths, deterministic diff statistics, and allowlisted failure vocabulary; exact configured-secret redaction across chunk boundaries, multiline values, and truncation with the residual risk from encoded, transformed, or unknown secret values recorded rather than a universal secret-free claim; crash barriers and idempotence across report, snapshot, experiment, commit, evaluation, and publication; deterministic newest-first budgeted/truncated handoff; migrated, pruned, and unavailable TSV/history rendering; and continued exclusion of raw logs, full patches, Bash, and arbitrary readers.
- **Focused review:** Clean after review-fix loops; three independent final reviewers found no unresolved issue across annotation bounds and non-authority, Host facts, changed-path/diff/failure summaries, redaction and residual disclosure risk, crash recovery/idempotence, handoff budgets/truncation, history migration/pruning, or child-tool restrictions.
- **Authority boundary:** Research annotations remain explicitly untrusted and cannot affect evaluator command, metric, Git validation, acceptance, target, or recovery. Host-observed facts remain mechanically separate and authoritative only within their defined provenance; no secret-free, sandbox, or broader authority claim is added.
- **Required tracker-accounting commit:** `docs(plan): record handoff chunk 05`; this checklist-only accounting change is complete and ready to land before Chunk 06 starts. Its SHA remains external until the commit exists.
- **Rollback:** Before any Chunk 05-schema run exists, revert the implementation and checklist-only accounting commits together while retaining the Chunk 04 legacy/current guards. After any Chunk 05-schema run exists, roll forward while preserving migrated TSV/history, untrusted annotations, Host facts, bounded failure evidence, artifact availability/pruning state, exact-secret redaction semantics and documented residual risk, crash-barrier ownership, and idempotent recovery; never reinterpret annotations as authority or expose raw artifacts to proposal children.
- [x] Implementation complete
- [x] Focused verification complete
- [x] Focused review complete
- [x] Tracker-accounting commit complete

### Chunk 06 — Continue after quiescent candidate failures

- **Claims:** H-07.
- **Primary target paths (3):** `src/controller.ts`, `src/recovery.ts`, `src/tracker.ts`.
- **Secondary migrated production/tests:** `src/types.ts` only if the exhaustive matrix requires a public result-union change; focused controller/recovery/tracker/restart/composition tests and installed-package continuation scenario.
- **Work:** Implement exactly the H-07 matrix for live and resumed paths. Only the enumerated proven-quiescent failures, plus proven-no-process spawn failure, consume one ordinal, retain evidence, restore accepted HEAD, transition to `ready`, and continue when budget remains. Preserve all terminal/blocked ownership, artifact, claim/lock, and next-child rules; add no retry loop or state.
- **Depends on:** Chunk 05 and its tracker-accounting commit.
- **Exact verification:** Focused tests and typecheck cover every matrix row, proven/uncertain spawn, rerun exhaustion, last budget, next-child ordering/context, crash barriers, accepted-HEAD restoration, evidence and lock disposition, idempotent resume, and exact counts.
- **Implementation commit:** `cdb2e0218d19d4fcf8831c4487e6944297be46e7` (`fix(controller): continue after quiescent candidate failures`).
- **Focused verification:** The focused suite passed 6 files with exactly 201 tests passed and 7 skipped; `pnpm run typecheck` passed. Coverage exercised the exhaustive H-07 matrix on both live execution and resume: continuable `exit`, `signal`, `timeout`, `output-limit`, and `metric-protocol`; proven-no-process versus uncertain `spawn`; terminal `cancelled`; blocked provenance mismatch plus evaluator/dataset file-policy and manifest violations; `recovery-rerun-exhausted`; and non-quiescent/unknown process survival, Git/tracker contradictions, and persistence/controller failures. It proved durable discard and bounded artifacts/evidence, provenance/manifest enforcement, no candidate continuation for baseline failures, accepted-HEAD restoration before `ready` and before any next child, exactly one ordinal consumed only for continuable candidates, no synthetic consumption for blocked/uncertain cases, final-budget termination versus budget-remaining next-child creation, next-child bounded failure context, all named cleanup/crash barriers, idempotent resume without duplicate attempt/candidate/evaluator, and the exact claim/lock disposition for continuation, terminal release, policy block release, and operator-recovery retention.
- **Focused review:** Clean after review-fix loops; three independent final reviewers found no unresolved issue across the exhaustive live/resume matrix, proven and uncertain spawn handling, durable discard, cancellation, provenance/manifest blocks, rerun exhaustion, Git/persistence contradictions, baseline exclusion, accepted-HEAD restoration, budget and next-child behavior, crash barriers, exact ordinal/attempt/candidate/evaluator counts, or claim/lock ownership.
- **Required tracker-accounting commit:** `docs(plan): record handoff chunk 06`; this checklist-only accounting change is complete and ready to land before Chunk 07 starts. Its SHA remains external until the commit exists.
- **Rollback:** Before any later behavior or documentation depends on candidate-continuation semantics, revert the implementation and checklist-only accounting commits together. After dependency exists, roll forward while preserving the exhaustive live/resume classification, durable failure evidence and discard, accepted-HEAD restoration, exact ordinal accounting, baseline exclusion, provenance/manifest and contradiction blocks, rerun-exhaustion terminality, crash-barrier idempotence, budget/next-child ordering, and claim/lock ownership; never reinterpret uncertain process state as proven quiescence.
- [x] Implementation complete
- [x] Focused verification complete
- [x] Focused review complete
- [x] Tracker-accounting commit complete

### Chunk 07 — Replay cancelled origin state exactly

- **Claims:** H-10.
- **Primary target paths (3):** `src/tracker.ts`, `src/recovery.ts`, `src/controller.ts`.
- **Secondary migrated tests:** focused tracker/recovery/controller/restart tests and cancellation replay release coverage.
- **Work:** Derive `lastState` from exactly one validated durable transition into `cancelled`; route live and resumed results through one canonical constructor; block missing/ambiguous evidence without a schema column or fallback literal.
- **Depends on:** Chunk 06 and its tracker-accounting commit.
- **Exact verification:** Focused tests and typecheck compare first/resumed deep equality for every reachable cancellation origin, reject corrupt evidence, and prove replay performs no evaluator, proposal, attempt, candidate, or Git mutation.
- **Implementation commit:** `fix(recovery): preserve cancelled origin state`
- **Required tracker-accounting commit:** `docs(plan): record handoff chunk 07`; changes only this checklist and must land before Chunk 08 starts.
- [ ] Implementation complete
- [ ] Focused verification complete
- [ ] Focused review complete
- [ ] Tracker-accounting commit complete

### Chunk 08 — Align public documentation and drift guards

- **Claims:** H-02, H-11, H-12, H-13, H-14, H-15; preserve H-06 as no-fix and describe completed runtime contracts truthfully.
- **Primary target paths (3):** `README.md`, `tests/release.spec.ts`, `docs/plan/handoff-2026-0830-checklist.md`.
- **Secondary migrated tests/fixtures:** installed-package assertions and fixture profiles only where required by the final Host registration; never edit historical plan files or the source audit.
- **Work:** Record the explicit trusted Host/managed-subprocess and no-hostile-code-sandbox boundary; evaluator-owned fair compute and watchdog timeout; Linux `/proc` stale-claim limitation; version-derived tarball instructions; final tracker schema authority; advisory constraints; configured bounded runs/no indefinite mode; legacy operator path; final evaluator/dataset contract, bounded research memory, safe failure continuation, and exact cancellation replay. Add narrow drift assertions without duplicated constants.
- **Depends on:** Chunk 07 and its tracker-accounting commit.
- **Exact verification:** Run focused release/documentation assertions and typecheck; inspect source and packed README against manifest version, final schema, tool schema, patch config, and runtime behavior. Truthfulness review must reject claims of hostile-code isolation, controller compute fairness, Host simplicity enforcement, cross-platform stale takeover, hard-coded universal 100, indefinite autonomy, legacy auto-migration, full logs/patches, or universal secret-freedom.
- **Implementation commit:** `docs(readme): align autoresearch trust and bounds`
- **Terminating tracker-accounting commit:** Chunk 09 lands as `docs(plan): record handoff chunk 08`; it records only Chunk 08's implementation evidence plus final aggregate verification/classification and must not record its own SHA.
- [ ] Implementation complete
- [ ] Focused verification complete
- [ ] Focused review complete
- [ ] Tracker-accounting commit complete via Chunk 09

### Chunk 09 — Record Chunk 08 and terminate the tracker

- **Claims:** H-01 through H-15 final aggregate verification/classification; accounting ownership is limited to the immediately preceding Chunk 08.
- **Primary target paths:** tracker-accounting exemption — exactly `docs/plan/handoff-2026-0830-checklist.md`; product, test, and README changes are prohibited.
- **Work:** Record Chunk 08's exact implementation SHA, focused evidence, review result, and rollback note. Also record final repository-wide/packed-release verification, commit-range and staged-diff review, residual risks, and final classification for every finding/status. Prior tracker-accounting commits already and exclusively account for Chunks 00-07; do not rewrite their historical evidence except to classify a discovered defect by reopening its owner chunk. This commit cannot record its own SHA and no recursive follow-up is required or permitted.
- **Depends on:** reviewed Chunk 08 implementation commit; Chunks 00-07 and their accounting commits complete.
- **Exact verification:** Before commit, run final repository-wide and packed-release gates; review implementation/accounting pairs in dependency order, clean cutover, the inert-preparation/sole-activation gate, no unrelated changes, no scope creep, and unchanged historical plans. Review the staged Chunk 09 diff. After commit, Git history is external evidence of the terminating SHA.
- **Conventional commit:** `docs(plan): record handoff chunk 08`
- [ ] Chunk 08 accounting evidence recorded
- [ ] Final aggregate verification/classification recorded
- [ ] Staged terminating diff reviewed
- **Self-SHA/accounting:** exempt; no checkbox and no `_unchecked_` cell.

## Commit and evidence accounting

Fill each implementation row only after the fact exists. Rows 00-07 and 03R require the separately named tracker-accounting commit before the next implementation chunk. The planning amendment `docs(plan): rechunk activation corrections` has no recursive accounting row or commit. Row 08 is filled by terminating Chunk 09, whose SHA remains external in Git history.

| Chunk | Implementation commit | Focused verification evidence | Review result | Tracker-accounting commit | Rollback note |
|---|---|---|---|---|---|
| 00 | `e2d3e1ef8a7fb053afad0f8874621a34aa67d712` | Commit changed only this checklist; H-01..H-15 rows contain every required field and three initially unchecked statuses. | Clean; independent plan gates found no unresolved issue. | `docs(plan): record handoff chunk 00` — complete and ready to land; SHA external until committed. | Revert the tracker-only implementation and accounting commits before dependent work; no code, runtime state, or historical plan migration. |
| 01 | `174ecb01d2834398c9b0c2496c0f53a679ed5730` | `pnpm exec vitest run tests/tracker.spec.ts tests/recovery.spec.ts tests/controller.spec.ts`: 3 files/121 tests passed; `pnpm run typecheck`: passed; LSP unavailable because no language server was installed. | Clean after multiple fix loops; two independent final reviewers found no unresolved issue. Key fixes covered canonical fingerprinting/order, path-overlap and corrupt/non-canonical evidence rejection, monotonic/atomic persistence, and inert production activation gates. | `docs(plan): record handoff chunk 01` — complete and ready to land; SHA external until committed. | Revert implementation and accounting before Chunk 02; never down-migrate a tracker opened at the advanced schema—roll forward preserving legacy/new discrimination and durable evidence. |
| 02 | `75949d0fe7aa504537e98b5941e14f7da364279e` | `pnpm exec vitest run tests/evaluator.spec.ts tests/git.spec.ts`: 2 files/78 tests passed; `pnpm run typecheck`: passed. | Clean after resolving alias, immutable-object, and descriptor findings; one clean final reviewer found no unresolved issue. The sole contrary finding demanded runtime activation and was independently refuted twice because activation is explicitly prohibited until Chunk 04. | `docs(plan): record handoff chunk 02` — complete and ready to land; SHA external until committed. | Revert implementation and accounting before Chunk 03; helpers are inert, preserve existing evaluator behavior, and do not activate or interpret the new frozen-input contract. |
| 03 | `cf3d0c3` | `pnpm run build`: passed; `pnpm exec vitest run tests/contracts.spec.ts tests/autoresearch.spec.ts tests/composition.integration.spec.ts`: 3 files/91 tests passed; `pnpm run typecheck`: passed. Negative activation evidence confirmed the registered production tool and controller/recovery routes remain legacy-only, cannot create/resume/interpret new-contract runs, and write no new marker. | Clean after fixes for schema/config mutable-input parity, omitted-dataset defaulting, strict malformed fields, full activation-decoder validation/deep freeze, and required Loader fields; two independent final reviews found no unresolved issue. | `docs(plan): record handoff chunk 03` — complete and ready to land; SHA external until committed. | Revert implementation and accounting before Chunk 04; machinery is inert, retain the registered legacy route, and do not create, resume, or interpret the new contract. |
| 03R | `d9c10369cdc83948dd6cd0960fe2d63caf1d2fac` (`fix(core): harden activation primitives`); review fixes `da87f21276a83f842cee15f6870818caada71751`, `aca459bb94a895078cda855f64c8fde5e7e356e5` | At the clean 03R tip, `pnpm exec vitest run tests/tracker.spec.ts tests/evaluator.spec.ts tests/git.spec.ts tests/contracts.spec.ts`: 4 files/177 tests passed; `pnpm run typecheck`: passed. `tests/contracts.spec.ts` is included because activation DSL parity belongs to shared types. Snapshot evidence preserved source main/WAL bytes and sidecar existence; transient coordination bytes in an already-existing SHM may change. Zero production activation remained proven. | Clean; two final reviewers found no unresolved issue. Resolved findings covered durable-evidence-preserving SQLite snapshot semantics, strict generation/registration durability, rollback and terminal authority, semantic provenance/manifest reconstruction, empty-manifest and frozen-file handling, and shared activation DSL/type parity. | `docs(plan): record handoff chunk 03R` — complete and ready to land; SHA external until committed. | Before activation, revert `aca459bb94a895078cda855f64c8fde5e7e356e5`, `da87f21276a83f842cee15f6870818caada71751`, and `d9c10369cdc83948dd6cd0960fe2d63caf1d2fac` in reverse order with the accounting commit, preserving completed Chunk 00-03 history and the legacy route; after activation, roll forward through the hardened shared contract. |
| 04 | `4b9e93efcb343b9a9cf017ba47605dc44e867e6a` (`fix(security): activate host evaluator authority`) | `pnpm run build`: passed; focused suite: 10 files, 327 passed/6 skipped; `pnpm run typecheck`: passed. Acceptance covered Host `evaluator_id` authority, removed raw inputs, dataset provenance consistency, manifest/file freezing, legacy/current cutover, read-only preclaim behavior, migrations, terminal claims/retention, and rollback. | Clean after review-fix loops; three independent final reviewers found no unresolved issue. H-02 sandbox confinement remains document-only by explicit decision. | `docs(plan): record handoff chunk 04` — complete and ready to land; SHA external until committed. | Before any new-contract run exists, revert implementation and accounting only with legacy/new guards intact. After one exists, roll forward preserving manifests, fingerprints, provenance, migrations, terminal evidence, claims/locks, retained legacy state, and rollback evidence; never reinterpret current or legacy policy. |
| 05 | _unchecked_ | _unchecked_ | _unchecked_ | `docs(plan): record handoff chunk 05` — _unchecked_ | If schema advances, roll forward after migration; never down-migrate an opened tracker. |
| 06 | `cdb2e0218d19d4fcf8831c4487e6944297be46e7` (`fix(controller): continue after quiescent candidate failures`) | Focused suite: 6 files, exactly 201 passed/7 skipped; `pnpm run typecheck`: passed. Exhaustive live/resume coverage proved all continuable, terminal, and blocked matrix rows; proven/uncertain spawn; durable discard and bounded evidence; cancellation; provenance/file-policy/manifest blocks; rerun exhaustion; Git/tracker and persistence/controller contradictions; baseline exclusion; accepted-HEAD restoration; exact consumption and no-duplication counts; budget/next-child ordering and context; cleanup crash barriers; and exact claim/lock disposition. | Clean after review-fix loops; three independent final reviewers found no unresolved issue. | `docs(plan): record handoff chunk 06` — complete and ready to land; SHA external until committed. | Before dependent behavior/docs, revert implementation and accounting together. After dependency, roll forward preserving continuation classification, durable evidence, accepted HEAD, exact accounting, blocks, crash idempotence, budget/child ordering, and claim/lock ownership. |
| 07 | _unchecked_ | _unchecked_ | _unchecked_ | `docs(plan): record handoff chunk 07` — _unchecked_ | Schema-neutral reverse-order revert; cancellation replay may regress and must not be misreported. |
| 08 | _unchecked_ | _unchecked_ | _unchecked_ | Chunk 09: `docs(plan): record handoff chunk 08` — _unchecked before terminating commit_ | Reverting knowingly restores false public claims and prevents closure. |
| 09 | _terminating accounting/closure; SHA external in Git history_ | _final aggregate recorded before commit_ | _staged-diff review recorded before commit_ | _self-accounting exempt_ | Product findings reopen their owner chunk; never add a recursive SHA-only commit. |

## Final unchecked-item classification rules

At final closure, every unchecked box or `_unchecked_` cell must be classified explicitly. No item may disappear, be silently deferred, or be checked based on intent.

1. **Actionable defect:** Reopen the owning chunk; closure is prohibited.
2. **Verification failure:** Record exact failure evidence and reopen the owner; do not relabel it.
3. **Review finding:** Reopen the owning authority, durability, recovery, privacy, compatibility, or truthfulness chunk.
4. **Blocked prerequisite:** Record the missing external prerequisite, attempts, affected claims, and owner; closure requires explicit user approval.
5. **Superseded by approved contract change:** Requires an explicit user-approved replacement contract and verification.
6. **No-fix by disposition:** Only H-06; still review and account for absence of contradictory behavior or promises.
7. **Document-only complete:** H-02, H-11, H-12, H-13, H-14, and H-15 require Chunk 08 implementation/review and Chunk 09 accounting.
8. **Not applicable due to absent claim:** Invalid for current H-01..H-15 without new evidence and explicit review approval.
9. **Residual risk:** Record only after acceptance criteria pass, with impact, boundary, detection/mitigation, and owner.
10. **Complete:** Check only observed evidence. A finding closes when its disposition, three finding statuses, all owner-chunk statuses, and accounting fields are complete. Preparatory Chunks 01-03 and corrective Chunk 03R additionally require their negative activation gates, with zero production activation proven at the 03R tip. Chunk 09's non-self-referential exemption and the self-contained `docs(plan): rechunk activation corrections` amendment's no-recursive-accounting rule are the sole accounting exceptions.

## Closure checklist

- [ ] Every H-01..H-15 row has one satisfied disposition and exact evidence.
- [ ] Implementation Chunks 00-08 and corrective Chunk 03R, with their required tracker-accounting commits, landed in dependency order with the exact subjects above; the planning amendment landed as `docs(plan): rechunk activation corrections` without recursive accounting, and Chunk 09 is the terminating `docs(plan): record handoff chunk 08` commit.
- [ ] Each implementation chunk owns 3-5 primary paths, except the explicit documentation-only exemptions; each tracker-accounting commit changes only this checklist.
- [ ] Preparatory Chunks 01-03 and corrective Chunk 03R remained inert in production, all four negative activation gates passed together at the 03R tip, and Chunk 04 was the sole atomic activation route.
- [ ] Every migrated caller, test, fixture, generated artifact, and public document required by the final contract was updated or explicitly reviewed unchanged.
- [ ] No legacy model-owned evaluator route, alias, exceptional allowlist, automatic raw-policy migration, or second manifest convention remains after activation.
- [ ] No sandbox runtime, hostile-code isolation claim, controller-owned compute-fairness rule, Host complexity score, or indefinite loop was added.
- [ ] Historical `docs/plan/PLAN.md` and `docs/plan/CHECKLIST.md` remain unchanged.
- [ ] All unchecked findings and Chunks 00-08 plus Chunk 03R are resolved or classified; the planning amendment requires no recursive accounting, and Chunk 09 uses only its explicit terminating exemption.
- [ ] Final repository-wide, packed-release, commit-range, staged-closure review, and externally observable Chunk 09 Git-history evidence are recorded without fabrication.
