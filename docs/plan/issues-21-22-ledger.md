# Issues 21–22 stacked fixes ledger

## Control summary
- Adaptive loop: assess evidence and repository state, choose the next bounded move, delegate, evaluate, update this ledger.
- Coordinator owns light inspection, this ledger, project gates and commits; workers own exploration, implementation and independent review.
- Scope is the AC below; no silent drops, scope shrink or unverified completion. Ask only for material decisions tools cannot resolve.
- Implementation and review use different workers. Commit only owned green checkpoints; preserve pre-existing changes.
- Mode: ask-when-material. User authorizes dedicated stacked branches, PR publication and sequential merges using EveGoodEvening.
- Final gate: every AC has verified evidence or a valid external blocker/deferral; no open decision or Fix/Replan/Ask finding; no unblocked unknown-until plan; converged final whole-change independent review; full build/typecheck/tests/lint-as-applicable gates pass on the final tree after the last change; final ledger committed.

## Acceptance criteria
1. Issue #21: watchdog and caller cancellation remain authoritative through whole-process-tree quiescence, including direct-process exit with a surviving descendant. Preserve truthful timeout/cancel outcomes, awaited teardown, durable evidence and lock safety. Add deterministic consumer-visible regressions, including real DSH provider coverage.
2. Issue #22: oversize successful background job output remains bounded valid JSON and retains terminal identity, best metric/commit/experiment where present, counts and optional target, with explicit omitted-detail indication and durable tracker access. Preserve complete small outputs and canonical durable results; verify real model-facing job_output including UTF-8/framing. Per user-approved D5, maxResultChars limits details but the mandatory summary is a minimum retained envelope and may exceed extremely small configured caps; no new run-admission rejection.
3. Both fixes are documented without unrelated changes, dependency upgrades, version bumps or publishing; independently reviewed and tested, with full project gates green.
4. Dedicated branches and two stacked PRs exist: #21 PR targets master; #22 PR initially targets #21 branch. Use verified EveGoodEvening GH identity for all gh operations.
5. Merge #21 first, replay only #22 changes onto updated master after squash, retarget #22 to master, rerun relevant/full final gates and independent review as needed, then merge #22. Both issues close with accurate evidence and final master contains both fixes.

## Plan
### Branch and integration strategy — firm; unreviewed
Use `fix/21-evaluator-quiescence` then `fix/22-background-summary`. Repository permits squash merge only. After first merge, rebase second with explicit old-parent boundary to avoid replaying squashed #21 commits. No direct push to master; gh merge is explicitly requested. Historical implementation PLAN/CHECKLIST cover a closed older goal, not these issues; no competing active goal ledger found.
### Fix designs and verification — firm; unreviewed
Adopt [design sections 3 and 4](issues-21-22-design.md) with D5 superseding strict background admission in section 4.2: #21 extends existing lifetime finally through tree quiescence without changing error precedence; independent direct/tree gates plus real-provider timeout, job_kill and HMR regressions. #22 selects exact full small result or mandatory compact status/runId/tracker/best/counts/target/detailsOmitted envelope, with explicit minimum-envelope floor and bounded UTF-8/status framing. No new schema/migration/admission subsystem. Verify true job_output content and durable/full foreground resume. Independent PLAN-REVIEW precedes implementation; run code slices serially to avoid generated-lib races.
### Final integration — firm; unreviewed
Independent review each slice and whole union; coordinator runs project gates. Publish stack before first merge. After squash/rebase, verify final branch and merge second PR, fast-forward local master and complete accounting.

## Work items
| Item | Kind | AC | Status | Evidence |
| --- | --- | --- | --- | --- |
| W1 resolve design and test plan | design | 1–3 | done | [Planning output](issues-21-22-design.md); concrete tests, provider seam and pnpm wrapper proof; user resolved budget tradeoff in D5 |
| W2 independent plan review | review | 1–5 | active | [Independent plan reviewer](t3-thread://v2/97c551f1-aa14-49f0-a159-f347ef586a04/thread:delegated-task:command%3Amcp%3A42d2581d-e742-4045-a977-ea5a59aa49df%3Adelegate-task%3Acac2163a-57ec-46ea-8fa8-31c63051192f); output issues-21-22-plan-review.md |
| W3 implement and verify #21 | impl | 1,3 | todo | |
| W4 independently review #21 | review | 1,3 | todo | |
| W5 implement and verify #22 | impl | 2,3 | todo | |
| W6 independent whole-stack review | review | 1–3 | todo | |
| W7 create dedicated stacked PRs | impl | 4 | todo | |
| W8 merge #21, replay/retarget #22 | impl | 5 | todo | |
| W9 final gates/review and merge #22 | review | 3,5 | todo | |
| W10 explain baseline gate failure and establish valid full-gate invocation | research | 3 | active | [Baseline report](issues-21-22-baseline.md): nested worker contention plausible, unproven. Serialized full release wrapper verification running; no deadlines/assertions changed |

## Decision log
- D1: New ledger selected because existing docs/plan/PLAN.md and CHECKLIST.md explicitly cover closed historical implementation; diagnostic issue bodies #21/#22 are references, not live checklists. Keep historical artifacts unchanged.
- D2: Choose #21 then #22, squash/rebase integration, because both changes share lifecycle/integration fixture/generated artifacts; parallel implementation risks shared build state. No direct master push. Repo supports squash only.
- D3: Three existing AGENTS.md additions belong to preceding diagnosis in this conversation (npm statistics, evaluator defect, installed rc1/rc3 proof); preserve and include as diagnostic provenance in initial planning commit. No source changes exist.
- D4: Adopt inherited `VITEST_MAX_WORKERS=1` plus `--maxWorkers=1 --no-file-parallelism` for constrained local gates; unlike outer CLI flags alone the environment also reaches nested Vitest. Preserve all tests/coverage/deadlines. [Evidence and limits](issues-21-22-baseline.md). Reserve two heavy-gate slots for the finite verification rather than terminating unrelated processes.
- D5 (user-approved replan): Asked via form how cap 1 should coexist with required summary fields. Options: mandatory-envelope floor vs strict pre-run background admission. User explicitly selected `mandatory_summary_floor`. Supersedes the exact-config-cap assumption in AC2 and design §4.2 recommendation; keep bounded complete required summary even if tiny cap is exceeded, no new rejection/identity-preflight changes. Preserve full small results and derive finite transport allowance for actual output plus UTF-8/framing. W5/W6/W9 cover revised AC2; no existing code to remove/rewrite. Plan diff: adopt compact serializer, remove proposed admission subsystem, keep all canonical/foreground guarantees. Revised sections unreviewed until W2.

## Findings and open questions
- F1: Resolved: `COREPACK_DEFAULT_TO_LATEST=0 corepack pnpm` selects 11.7.0 without global changes. Coordinator baseline typecheck passed (7.03 s) and build passed. Status: closed.
- F2: #6 previously fixed canonical size rejection; #22 must not reinstate it. Status: acceptance constraint, closed.
- F3: Windows and rc3 migration are out of scope; do not conflate them with these fixes. Status: scope boundary, closed.
- F4: Baseline coverage failed before functional edits: 674 passed, 10 skipped, one release.spec.ts nested lifecycle case timed out at 45 s; full suite 496.66 s. [Read-only investigation](issues-21-22-baseline.md) narrows this to possible parallel contention or late teardown, not a proven prepare hang; no package contamination found. Triage Fix (verification prerequisite); verify inherited `VITEST_MAX_WORKERS=1` with full unchanged release wrapper, then full gates at implementation checkpoint. Do not suppress tests or increase deadlines.

## Iteration log
- I1: Assessed clean source at 75ecd4b, owned prior AGENTS notes, historical plans, one unrelated open PR #16; verified EveGoodEvening and squash-only repo. Choose durable ledger and delegated design before implementation; reject parallel code workers due shared runtime artifacts. Plan changes if design review reveals missing contract or impossible bound.
- I2: Delegated W1 to an independent planning thread with maximum reasoning; clarified that shared delegation is a separate thread, not a Git worktree. Continue independent gate-tooling prerequisite while planner works; no source edits or PRs yet.
- I3: Coordinator resolved package-manager access and passed baseline typecheck using Corepack's pinned pnpm 11.7.0; started gated baseline build/coverage while W1 performs read-only design. Reject duplicating worker exploration; await gate output before allowing source/test mutation.
- I4: Baseline source gate failure is observed, not attributed to future fixes. Delegate independent read-only diagnosis of nested release timeout; planner receives exact output. Continue design/review while avoiding duplicate suites, timeout inflation and unrelated code changes. Source remains unchanged.
- I5: Baseline worker completed bounded source/environment investigation; accept its contention hypothesis only as inference. Start one serialized whole release-wrapper check as the new verification boundary (not a repeated unchanged full baseline), retain exact assertions and deadlines. Await W1 and gate evidence.
- I6: Start independent PLAN-REVIEW of AC, squash/rebase boundaries, concrete lifecycle/summary feasibility and current design artifact if available. Research/review outputs are disjoint; no implementation authorizes yet. Running gate owns source/build state until completion.
- I7: W1 completed and exposed mathematical cap/required-fields conflict. Obtain explicit user choice instead of silently weakening AC2; adopt mandatory-summary floor (D5), reject admission complexity, send changed contract and complete design to independent reviewer. No implementation yet.
