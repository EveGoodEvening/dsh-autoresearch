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
2. Issue #22: oversize successful background job output stays bounded valid JSON and retains terminal identity, best metric/commit/experiment where present, and counts, with explicit omitted-detail indication and durable tracker access. Preserve complete small outputs and canonical durable results. Verify through real model-facing job_output.
3. Both fixes are documented without unrelated changes, dependency upgrades, version bumps or publishing; independently reviewed and tested, with full project gates green.
4. Dedicated branches and two stacked PRs exist: #21 PR targets master; #22 PR initially targets #21 branch. Use verified EveGoodEvening GH identity for all gh operations.
5. Merge #21 first, replay only #22 changes onto updated master after squash, retarget #22 to master, rerun relevant/full final gates and independent review as needed, then merge #22. Both issues close with accurate evidence and final master contains both fixes.

## Plan
### Branch and integration strategy — firm; unreviewed
Use `fix/21-evaluator-quiescence` then `fix/22-background-summary`. Repository permits squash merge only. After first merge, rebase second with explicit old-parent boundary to avoid replaying squashed #21 commits. No direct push to master; gh merge is explicitly requested. Historical implementation PLAN/CHECKLIST cover a closed older goal, not these issues; no competing active goal ledger found.
### Fix designs and verification — tentative; unreviewed
Planning worker resolves minimal designs, boundary tests, fixture/runtime constraints and project gates. Independent PLAN-REVIEW precedes implementation. Implement #21, then #22 in the same checkout on its stacked branch to avoid shared generated-lib races.
### Final integration — firm; unreviewed
Independent review each slice and whole union; coordinator runs project gates. Publish stack before first merge. After squash/rebase, verify final branch and merge second PR, fast-forward local master and complete accounting.

## Work items
| Item | Kind | AC | Status | Evidence |
| --- | --- | --- | --- | --- |
| W1 resolve design and test plan | design | 1–3 | todo | |
| W2 independent plan review | review | 1–5 | todo | |
| W3 implement and verify #21 | impl | 1,3 | todo | |
| W4 independently review #21 | review | 1,3 | todo | |
| W5 implement and verify #22 | impl | 2,3 | todo | |
| W6 independent whole-stack review | review | 1–3 | todo | |
| W7 create dedicated stacked PRs | impl | 4 | todo | |
| W8 merge #21, replay/retarget #22 | impl | 5 | todo | |
| W9 final gates/review and merge #22 | review | 3,5 | todo | |

## Decision log
- D1: New ledger selected because existing docs/plan/PLAN.md and CHECKLIST.md explicitly cover closed historical implementation; diagnostic issue bodies #21/#22 are references, not live checklists. Keep historical artifacts unchanged.
- D2: Choose #21 then #22, squash/rebase integration, because both changes share lifecycle/integration fixture/generated artifacts; parallel implementation risks shared build state. No direct master push. Repo supports squash only.
- D3: Three existing AGENTS.md additions belong to preceding diagnosis in this conversation (npm statistics, evaluator defect, installed rc1/rc3 proof); preserve and include as diagnostic provenance in initial planning commit. No source changes exist.

## Findings and open questions
- F1: Native pnpm absent from PATH in earlier diagnosis; coordinator/worker must find or provision isolated pnpm 11.7.0, not change global selection. Status: investigate in W1; triage Fix (tooling prerequisite).
- F2: #6 previously fixed canonical size rejection; #22 must not reinstate it. Status: acceptance constraint, closed.
- F3: Windows and rc3 migration are out of scope; do not conflate them with these fixes. Status: scope boundary, closed.

## Iteration log
- I1: Assessed clean source at 75ecd4b, owned prior AGENTS notes, historical plans, one unrelated open PR #16; verified EveGoodEvening and squash-only repo. Choose durable ledger and delegated design before implementation; reject parallel code workers due shared runtime artifacts. Plan changes if design review reveals missing contract or impossible bound.
