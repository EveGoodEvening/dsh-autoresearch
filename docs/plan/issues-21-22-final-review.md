# Issues #21–#22 — final independent whole-change/replay review

## Verdict

**Accept the implementation union and the replay. Zero open Fix/Replan findings.** No production correctness, security, lifecycle or consumer-test-validity regression identified. Issue #21 R1 remains resolved, not discarded; no previously discarded concern is reopened.

This is whole-scope **review convergence**, not completion of W9/Finalgate or authorization to skip the outstanding gates. The coordinator reports the final rebased peers/typecheck/build/full-coverage run and subsequent packed-consumer/Web smoke in progress/planned sequence. Their final results were not inspected here. PR #24's merge and Issue #22's closure remain pending.

## Scope and method

- Reviewed `fix/22-background-summary` at `0563893620f14946bb84a179c958779f333a78fc`, whole union against `75ecd4bfdb0fef51993f475de55b16da0d9b1c21`.
- Read ledger AC1–5, D5/D8 and Finalgate; both original Issues; the converged [#21 round 2](issues-21-review-round2.md), its R1 predecessor and proof files; [#22 union round 1](issues-22-review-round1.md); planning/transport review dispositions and baseline-verification limits.
- Inspected all four changed production files, all five changed/new test files, both new evaluator fixtures, public README/Chinese README/changelog changes, and the planning/review/lesson accounting. Historical admission and prepended-adapter proposals remain superseded by ledger D5/D8 and W12, not implementation obligations.
- Cross-checked installed DSH Jobs finalization, post-execute/cancellation handling and stock spill ordering. No language server is configured. Review used source, recorded evidence, hashes, lightweight Git inspection and read-only GitHub calls with the required EveGoodEvening environment; authenticated login was `EveGoodEvening`.
- Ran **no tests, typechecks, builds, runtime probes, browser, heavy commands, commits, pushes, merges or delegation**. This report is the only repository write; source and ledger are untouched.

## Replay and two-PR accounting

| Check | Independently observed evidence | Disposition |
| --- | --- | --- |
| First squash preserves the reviewed #21 tree | Old tip `9485a36150c3f9ae1922a0d9b70aad843824584d` and squash `4e9bfaf53e6587d589028b958fe252a4dac6ba60` both have tree `b48f37af8eee3105bfc5aea3dabbe651edcf8655`. | No first-squash file loss. |
| Only #22 commits replayed | `git range-diff 9485a36..147f646 4e9bfaf..edf01d3` reports three exact `=` pairs: `5965ff2 → 5ae812b`, `ec3d452 → a188e03`, `147f646 → edf01d3`. The replay starts directly on the first squash. | No already-squashed #21 commit was replayed; no patch change. |
| Full replay equality | Pre-replay `147f646a07ec2786c5b618d42bd1db726ebff126` and post-replay `edf01d3975befc32548b3dcdd323f5e8a6f81694` both have tree `3052d657fe196085c3268be5b44597faf8f7ac45`. | Equality covers tests/docs as well as production, not just patch similarity. |
| Current-head distinction | `0563893` changes only `docs/plan/issues-21-22-ledger.md` after that replay. Its tree is `3e37028f8da1464dc7e508633ef0f3d21ec98966`. | Do not mislabel the current full tree as `3052d657…`; source/test identity is preserved. |
| Prior reviewed snapshot | All seven source/test SHA-256 entries in #22 round 1 match current files. `src/evaluator.ts`, both #21 test files and both #21 fixtures have no diff from `9485a36`. | Prior source/test review and R1 closure still attach to this source tree. |
| PR #23 | [PR #23](https://github.com/EveGoodEvening/dsh-autoresearch/pull/23), author EveGoodEvening, base `master`, reviewed head `9485a36`, merged `2026-11-13T13:57:40Z` as `4e9bfaf…`. Issue #21 closed as completed at `13:57:41Z`. | First merge/closure verified. |
| PR #24 | [PR #24](https://github.com/EveGoodEvening/dsh-autoresearch/pull/24), author EveGoodEvening, current base `master`, head `0563893`, **OPEN**, no merge commit. Issue #22 remains open. Its initial stacked target is recorded in the ledger/PR body; local reflog also records creation at the old #21 tip. | Retargeted second PR exists; second merge/closure must not be marked done. |

The successful protected push and conflict-free rebase are coordinator-recorded operations; this review independently confirms their resulting remote head and exact replay/file identity, not a new transport-level lease trace.

## Whole-change correctness and acceptance

### AC1 — evaluator authority through whole-tree exit

`src/evaluator.ts:308–413` retains the original watchdog and caller-abort chain through direct completion, failure draining and `waitForExit()`, under one outer `finally`. There is no restarted deadline, production early-return race or aborted signal supplied to the quiescence wait. First timeout/cancellation cause, direct `0/null` facts and frozen-boundary/provider-error precedence survive. False/rejected waits and termination failures do not create proof of quiescence. Outcome/artifact persistence and unchanged controller/recovery lock authority remain downstream of that proof.

The independent direct/tree gates in `tests/evaluator.spec.ts` exercise the original deadline, both first-cause orders, repeated cancellation, natural exit, uncertain/error waits and late cancellation during boundary/provider failures. The real composition rows separately cover forced-fallback timeout and normally selected candidate `job_kill`/awaited HMR after direct exit with a live descendant. They assert non-running descendants before durable writes, accepted HEAD/ref restoration, local/shared lock and claim release, canonical cancellation/resume equality, no extra attempt and unchanged caller state. Their failure cleanup directly drains captured original handles before owner disposal.

**R1 negative proof is preserved.** `controlWatchdog()` observes cancellation of its exact native timer and refuses manual delivery after it was cleared. Current helper SHA-256 is `d0404a165d1fd12d4c3e34d67e53fc8e1473f99ad9bbbb93eee6d0ba1057b5fc`; original `75ecd4b` evaluator SHA-256 is `48fb096514ba8f23338df3606771eb335d354980f3246f1dce7289f28fb6cb19`, matching `/root/dsh-r1-proof-3CgaV9/negative-proof.json`. Recorded unchanged-consumer negative execution failed with `evaluator watchdog was cleared before tree quiescence`; its proof records both processes non-running and roots removed before driver cleanup. The recorded positive run was four tests. Neither execution was rerun or relabeled as fresh evidence here.

The fallback timeout row is an evaluator/persistence-callback proof; candidate kill/HMR supply controller/SQLite/lock coverage. No additional Windows, rc.3 or distinct whole-Host-shutdown proof is inferred.

### AC2 — user-approved summary floor and Host-policy authority

| Boundary | Source/test assessment |
| --- | --- |
| Complete small JSON; mandatory large-result envelope | `src/render.ts:15–28` returns the exact full serialization when it fits; otherwise exact status, run/tracker identity, best tuple, all counts, applicable target and `detailsOmitted: true`. No JSON slicing, identity shortening, canonical validation change or admission rejection. Contract cases cover cap one, full/compact neighboring thresholds, zero/negative/exponent metrics, target zero, escaped/BMP/astral and long accepted identities, and safe-integer limits. |
| Actual UTF-8 and status framing | `src/render.ts:46–55` splits only the unchanged stock rendering and only when actual text-plus-suffix bytes exceed the unchanged Jobs cap. Both blocks are substantive. Subtraction avoids unsafe cap addition. Byte-fitting content remains a single block. The bound is `selected.length <= max(C, S)` and text payload plus suffix `<= 3 * max(C, S) + 36` bytes, where S is the exact required envelope length—not a universal identity-independent or token-budget ceiling. |
| Exact job/owner and no replay | `src/render.ts:34–49` gates the requested/returned job ID, exact Agent, autoresearch kind, completed status/detail, selected text and stock content. Empty consuming reads are never reconstructed; foreign/descendant calls, unrelated jobs, running/failed/killed/error results do not acquire the floor. |
| Independent Host decisions | The adapter calls `next()` once and preserves block, own value/content replacement (including equal-looking values), error, pending-continuation cancellation and contexts. It is **appended**, not prepended. Installed spill policy is prepended and prices `decision.content ?? result.content`; installed tool finalization applies caller cancellation and then the Jobs finalizer. The supported multi-block contract preserves this proposal, not an unauthorized rewrite of a Host decision. |
| Decisive spill regression | `tests/background-output.integration.spec.ts:268–297` uses the real backend at the one-block-fit/two-block-over threshold. The unadapted control does not spill; the adapted two-block shape costs four more estimated tokens, must spill complete concatenated text and must retain the policy replacement rather than restoring JSON. |
| Retention/startup/teardown | `src/index.ts:149–262` registers on the owner before synchronous job start, records the ID before releasing execution, and stores only selected success text/status. The helper closure does not retain controller/canonical result/startup machinery. No-job failure disposes the listener. Registered output survives producer reload/disable with its original cap; owner disposal removes it. The existing non-consuming settlement barrier and failure/cancellation/notice caps remain intact. |
| Production consumer and durable evidence | The native-Loader integration checks real cap-one accepted-candidate and zero-target baseline success through the complete `job_output.content` array, HMR/disable and per-job config retention, ample full JSON, repeated empty reads, Host policy precedence and unchanged canonical foreground resume/SQLite/TSV/caller state. These are actual tool-pipeline assertions, not only serializer or `value.text` checks. |

No mismatch was found between the user's D5 floor and implementation. The floor is not permission to bypass spill, redaction, blocking, value replacement or caller cancellation. No arbitrary-Host-policy guarantee, fixed job-count memory bound or new provider-wire transmission proof is claimed.

### AC3 — scope, documentation and verification truthfulness

The whole diff changes only the four production files above, their regressions/fixtures and related documentation/accounting. Public documentation consistently explains the tiny-cap exception and Host-policy precedence; the evaluator changelog describes whole-tree authority. No dependency, package version, public root/subpath export, durable schema, controller/recovery policy or release/publish change is present. The original Issues' requested behaviors are covered; no additional feasible implementation requirement was silently dropped.

The ledger and PR body report the initial union gate: peers/typecheck/build and **703 passed, 10 skipped**, coverage thresholds green, **1148.47 s**. PR #23 separately records the earlier packed smoke **`ok: true`, 351.00 s**. These are inspected coordinator records, not reviewer executions and not substitutes for the ongoing final rebased gates. The configured typecheck covers source; no separate strict test-file cleanliness claim is made. `package.json` has no lint script.

### AC4–5 / Finalgate — remaining obligations

AC4's two-PR stack and AC5's first squash/replay/retarget are accounted for above. W9 must remain active until the coordinator:

1. Records actual completion/results of the final rebased peers → typecheck → build → full coverage gate, then the **sequential** packed-consumer/installed-profile/authenticated-Web smoke. Preserve worker limits, assertions, deadlines and coverage thresholds; do not overlap `prepack` with tests/build. This review neither reruns nor waives these steps.
2. Incorporates this review and the announced metadata correction, records the final reviewed head, and squash-merges PR #24 only after gates pass. Any later production/test change requires affected verification/review; source/tree equality alone is not the requested gate.
3. Verifies the actual second merge commit, Issue #22 closure and both fixes on remote `master`, then fast-forwards local `master` and records final accounting without inventing a pre-merge completion.

## Post-merge accounting decision

**Choose the simpler append-only option:** retain the existing `fix/22-background-summary` history and, only after PR #24 actually merges and closure/master evidence exists, append a **ledger-only** final-outcome commit there. Push only that retained dedicated branch, guarded by its exact expected remote OID. Do not delete that branch during merge. No third PR, direct master push or post-merge source replay is needed.

This avoids an unnecessary rebase/force rewrite after squash. The dedicated branch then contains historical commits already represented by the squash, but none are replayed onto master or proposed for another merge. Record the actual squash OID, gate evidence, issue closure and this deliberate accounting location. Remote `master` legitimately contains the pre-merge ledger snapshot and both fixes; the retained branch contains authoritative final accounting. Fast-forward local `master` to the verified remote merge, then leave the checkout on the retained branch if desired. **Do not claim the final accounting commit is on master.**

If the expected remote branch OID changed, stop and inspect rather than overwrite it. This recommendation does not waive any code gate, change review, merge precondition or actual issue-closure proof. It resolves only the impossibility of truthfully recording a future merge as already complete inside that same PR while respecting exactly two PRs/no direct master push.

The announced W12 label correction is appropriate: `9485a36150c3f9ae1922a0d9b70aad843824584d` is the inspected commit containing the reviewed transport design/review. Replace ambiguous `@W12 report` attribution with that concrete snapshot while retaining D8's non-prepend correction. This is a coordinator-owned metadata update, not an outstanding implementation Fix/Replan finding.
