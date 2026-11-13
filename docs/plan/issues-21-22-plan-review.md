# Issues #21–#22: independent PLAN-REVIEW

## Current verdict

**#21 firm design approved; implementation can start. #22 mandatory-summary-floor policy approved by the user; strict admission is rejected. #22 still needs a concrete transport integration, not another policy/admission decision.** Branch/integration and baseline verification strategies pass planning review.

Reviewed the [ledger](issues-21-22-ledger.md), completed [design](issues-21-22-design.md), [baseline report](issues-21-22-baseline.md), and relevant source/tests/installed DSH contracts. Source inspection only: no tests/builds, source or ledger edits, commits, GH/PR operations, or delegation. This report is the sole written artifact.

The coordinator supplied the explicit user decision `summary_budget=mandatory_summary_floor`: `maxResultChars` limits detailed output; the exact mandatory compact summary may exceed a tiny configured cap. Preserve identity, best, counts, applicable target and `detailsOmitted`. **No new background admission/rejection.** This supersedes design §4.2 and retires this review's earlier cap/admission blockers.

## Acceptance and section status

| Item | Verdict | Remaining boundary |
| --- | --- | --- |
| AC1; design §3 | **Reviewed firm; approved** | Implement and prove direct exit with live descendant, truthful classification, awaited teardown and lock safety |
| AC2; design §4.1 summary | **Reviewed firm with user-approved floor** | Replace strict-cap/admission wording with the algorithm below |
| AC2; design §4.2 admission | **Superseded; do not implement** | No minimum increase, request rejection, initialization split or admission reads |
| AC2; design §4.3 transport | **Encoding rule passes; integration still unfirm** | Resolve T1: the installed Jobs cap is captured at registration, before actual summary size exists |
| AC3; scope/docs and baseline/gates | **Plan passes; gate evidence pending** | Preserve all tests/deadlines/coverage; no dependency upgrades, version bump or publishing |
| AC4; branch strategy | **Reviewed firm; passes** | Exactly two PRs: #21 → master, #22 initially → #21; publish both before first merge |
| AC5; final integration | **Reviewed firm; passes** | Squash #21, replay only #22 from explicit old-parent OID, retarget, gate/review rebased union, squash #22 |

These are planning verdicts, not claims that implementation, gates, PRs or merges have completed.

## #21: approved minimal design

`src/evaluator.ts:365–369` currently removes watchdog/caller/termination listeners before `waitForExit()` at `:377`. DSH distinguishes direct-command completion from managed-range quiescence (`dsh-subprocess/README.md:41,68–70,109`). The proposed outer `try/finally` covering both direct completion and whole-tree waiting fixes the reported authority gap without replacing the provider or changing controller recovery policy.

Required invariants:

- Keep the original deadline through tree exit; no new post-`done` deadline, production `Promise.race` escape, or aborted signal passed to the quiescence wait.
- Keep first cause and evaluator-owned termination idempotence. Preserve boundary/provider error precedence over cancellation/timeout and timeout/cancel precedence over measurement (`src/evaluator.ts:393–405`).
- Cleanup must run on true, false and thrown wait/termination paths. False/rejected waits never prove quiescence.
- Preserve direct `exitCode: 0, signal: null` when the surviving descendant later times out/cancels. Record the actual cause separately; no invented provider PID or signal.
- No successful outcome before whole-tree exit. Preserve best-effort durable proven quiescence when subsequent artifact/outcome persistence fails (`src/evaluator.ts:379–410`).

### Decisive boundary tests

| Boundary | Required result |
| --- | --- |
| Direct `done = 0/null`; tree held; watchdog fires | Termination starts; no completed evaluator/outcome until tree exits; persisted timeout, never measured |
| Same window; repeated caller abort | One evaluator-owned explicit termination request; cancellation only after quiescence |
| Timeout→cancel and cancel→timeout while held | First cause remains authoritative |
| Natural tree exit after direct exit | No premature outcome; measured afterward; later abort/deadline does not signal a settled handle |
| Rejected `done` or frozen-boundary failure, then late abort during drain | Original error precedence survives extended authority; proven quiescence remains durable |
| Wait false/rejects | No invented exit proof or lock-release evidence; listeners/timer removed despite failure |
| Real fallback timeout; normally selected Host candidate `job_kill` and HMR | Direct exit/live child precede action; child non-running before outcome persistence; prior best/accepted HEAD restored; locks/claims safely released; job settles; caller unchanged |

The existing `LocalHandle.waitForExit()` merely awaits `done` (`tests/evaluator.spec.ts:88–123`), and its descendant fixture keeps the parent alive (`:534–544`). Separate direct/tree gates and the new parent-exits fixture are necessary. Extend existing failure tests (`:808–855`) for late cancellation during drain rather than duplicating their setup.

Accept the disclosed test-only forced-fallback selector, retaining real provider operations and normal-selection Host rows. The provider itself waits after `done` (`dsh-subprocess-local/lib/index.js:1571–1574`); observe the evaluator's forwarding facade, not that internal release wait. Keep provider escalation/I/O clocks real. Atomic readiness must race outcome. Failed tests must directly terminate/drain their captured owned handle before restoring spies/clocks; external cleanup must not count as the tested cancellation succeeding.

Use existing awaited HMR replacement (`tests/fixtures/harness-composition.ts:183–205`), non-consuming Jobs settlement, real `job_output`, and identical terminal resume without another evaluator attempt. Candidate timeout can consume an ordinal and continue; it is not a new top-level run status (`src/controller.ts:675–688`). No distinct Host-shutdown variant is required without evidence of another ownership gap.

## #22: firm user-approved presentation contract

Use the existing presentation layer, not canonical schemas/storage:

1. Serialize the complete successful result. If its length is `<= C = maxResultChars`, return that exact string, unchanged.
2. Otherwise serialize the mandatory compact object: exact `status`, `runId`, `tracker`, `best`, all three `counts`, applicable `target`, and `detailsOmitted: true`. Return it whole even if its length `S` exceeds `C`.
3. Bound this successful JSON by `max(C, S)`. The floor buys only required summary fields, never additional artifact/detail output. Preserve zero metrics/counts, full commit/experiment identity, escaping and numeric values.
4. Keep canonical decoding, SQLite, history, TSV, terminal resume and failed/killed status mappings unchanged. Do not raise Config's minimum or introduce request rejection.

Evidence: `src/config.ts:115,131,190` accepts cap 1; `src/types.ts:393–409,615–626` supplies the mandatory fields; `src/index.ts:63–68` is the current lossy success fallback. The existing cap-1 canonical test (`tests/controller.spec.ts:1401–1408`) and oversized canonical test (`tests/contracts.spec.ts:101–119`) remain valid unchanged.

### T1 — Medium, #22 only: specify how the transport allowance reaches real `job_output`

**Classification: remaining integration-design unknown, not an implementation defect or a reason to restore admission.**

The proposed finite allowance based on `M = max(C, S)` plus UTF-8/status framing is sound. At most three UTF-8 bytes per UTF-16 unit, with the current successful framing reserve, permits a safe-integer-saturating `3*M + 64`. Use saturating arithmetic rather than an unsafe intermediate. This bounds the whole successful model message separately from the detailed-result cap.

But a dynamic completion-time cap cannot simply be assigned to the current Jobs API:

- `src/index.ts:168–174` registers `outputLimitBytes: resolved.maxResultChars` before controller preparation; actual successful result arrives at `:188–190`.
- `dsh-jobs/lib/types/types.d.ts:62–77,128–144,166–200`: the limit is on `JobSpec`; neither `JobOutcome` nor `JobHandle` exposes a limit update. `JobRegistry` has no such setter (`lib/types/index.d.ts:59–146`).
- Installed `dsh-jobs-local@0.2.2-rc.1/lib/index.js:417,439–449` validates and copies the numeric spec limit at registration. Settlement copies only result/detail/status (`:769–775`). Mutating the original spec or a fresh `get()` projection later is not an update.
- `dsh-tool-jobs/lib/index.js:278–292,407–412` independently tail-truncates model-facing UTF-8 content while leaving structured `value.text` intact. A correct compact result with the old cap can still be unreadable to the model.

**Minimal plan adjustment:** name the concrete supported presentation path that preserves the mandatory floor through DSH's finalizer. If using an upfront finite reservation, prove it covers reachable summary identities without rejecting requests; if using a producer/tool-presentation path instead, specify its ordering/ownership and preserve failed/killed bounds. Do not assume an absent dynamic setter, mutate private registry records, upgrade dependencies, or call `prepare()` before job registration. Do not merely remove the transport cap without accounting for the other result paths.

This mechanism needs focused review before #22 implementation. It does not block #21 and does not reopen the user's budget choice.

### #22 boundary proof

- Real accepted-candidate background success whose complete artifact-bearing result exceeds the cap; exact compact fields and omission flag through owner `job_output`.
- **Cap 1 must still execute successfully** and return the whole mandatory summary. Also test just below/equal/above summary length, exact complete-result threshold, and ample-cap unchanged full JSON.
- Both success variants: budget-limited candidate acceptance and baseline target-reached with zero metric/counts `0/0/1`, retaining target.
- Long, escaped and non-ASCII identities; safe-integer counts; negative/exponent metrics; safe arithmetic near the accepted numeric limit. Use an in-memory large-artifact fixture, not 100 real rounds.
- Assert actual `content` is complete JSON body plus expected DSH status suffix with no truncation marker, not merely `JSON.parse(value.text)`. The entire framed message is intentionally not bare JSON.
- Foreground terminal resume returns the complete canonical result with identical best/counts and no extra attempt or omission marker. Keep canonical cap-1 behavior and failed/killed regressions.

Subscribe before starting and await non-consuming settlement. A bounded `job_output(wait: true)` returning running/empty is not completion. Existing real-tool coverage checks a failed `round-failed` result (`tests/composition.integration.spec.ts:333–368`), not this oversized successful path.

## Baseline verification: approved, not yet green evidence

Accept the supplied green typecheck/build and one existing default-parallel nested lifecycle 45-second timeout; do not rerun to confirm it. The case includes cleanup after evidence assignment (`tests/release-scenarios.integration.spec.ts:205–217`), so contention/late teardown remain hypotheses, not proof of a prepare hang or a #21 regression.

The coordinator's running unchanged full release wrapper, with inherited `VITEST_MAX_WORKERS=1`, outer `--maxWorkers=1 --no-file-parallelism`, unchanged assertions/deadlines and heavy-gate isolation, is an appropriate next boundary. No concurrent heavy check or polling is requested here. The nested runner inherits environment but not outer CLI flags (`scripts/release-scenarios.mjs:15–18,60–65`); installed Vitest honors the worker environment.

Consolidate design §5 with that serialized environment. Final gates remain peers check → typecheck → build → one full coverage invocation with worker limits, retaining all coverage thresholds. Rebuild before Loader composition. No declared lint script exists (`package.json:44–52`). A wrapper pass is not full coverage or causation proof. W10 stays open until actual output is assessed.

Keep capacity checks and the controlled gate reservation; finite gated calls use `async:true, timeout:0`. No timeout/assertion inflation or repeated-until-green runs. Required packed installed smoke is sequential: `prepack` rebuilds shared `lib/`, so never overlap it with tests/build. No publish or publish dry-run.

## Branch/integration: reviewed firm

Exactly two PRs, stacked #21 then #22, squash only. Independent review each slice and the union; publish both before the first merge. No third planning/cleanup PR, dependency upgrade or version bump.

Record the **final reviewed #21 head OID** independently of its branch name; refresh the stack/boundary if #21 changes. After its squash, fetch master and replay only #22 with `git rebase --onto origin/master <old-21-tip> fix/22-background-summary`; update with lease protection, retarget to master, gate/review the rebased union, then squash #22. Verify issue closures and final accounting; do not replay already-squashed #21 commits.

All GH calls retain `env -u GH_TOKEN -u GITHUB_TOKEN GH_CONFIG_DIR="$HOME/.config/gh-EveGoodEvening" gh`. Identity and squash-only settings are supplied coordinator evidence, not new checks by this reviewer.

**Next:** #21 may start now. Coordinator should replace obsolete admission/minimum language with the approved floor, firm up T1's actual transport mechanism, and retain the pending full-gate requirements.
