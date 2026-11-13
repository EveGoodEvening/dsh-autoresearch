# Issue #21 — independent implementation review, round 2

## Verdict

**Accept the Issue #21 implementation and R1 correction. Zero open Fix/Replan findings; zero production correctness/security findings identified. R1 is resolved, not discarded. No previously discarded finding was reopened.**

Reviewed the entire Issue #21 owned diff against `6f83c19`: `src/evaluator.ts`, both changed test files, the two new evaluator fixtures, the Unreleased changelog entry and project lesson. Re-read [round 1](issues-21-review-round1.md), [ledger AC1/AC3](issues-21-22-ledger.md) and [approved design §3](issues-21-22-design.md#3-pr-21--evaluator-lifetime-authority). The concurrent #22 planning artifacts are not an implementation change or a W4 design-review target.

This review inspected source, installed provider contracts/implementation, recorded proof files and hashes. It ran no tests, typechecks, builds, browser, heavy workload, commits, PR operations or delegation. This report is its only repository write. Recorded worker/coordinator execution is distinguished below from this reviewer's static observations.

## Production and acceptance review

| Boundary | Evidence inspected | Assessment |
| --- | --- | --- |
| Original deadline and caller cancellation through direct completion and tree exit | `src/evaluator.ts:308–380`; `tests/evaluator.spec.ts:488–531` | One existing watchdog; no restart, early-return race or aborted signal passed to tree waiting. The outer `finally` retains both abort paths through `done`, error draining and `waitForExit()`, then removes them. Independent gates check the original 100 ms deadline after direct exit at 40 ms, timeout→cancel, cancel→timeout, repeated abort and natural exit. No result/outcome is credited while the tree gate is closed. |
| Truthful outcome and error precedence | `src/evaluator.ts:368–413`; evaluator tests `:801–837,924–985` | Direct `0/null` facts remain exact. First cause is retained; frozen-boundary and provider failures keep their prior precedence. No PID is fabricated. Existing artifact/persistence failure handling still records only proven quiescence. Reworked tests retain the prior boundary/provider checks while adding late cancellation. |
| Uncertain/error paths and lock safety | evaluator tests `:534–570`; `src/recovery.ts:165–168,242–256`; `src/controller.ts:602–620,1074–1079` | False/rejected waits and termination errors do not invent quiescence; subsequent abort/deadline cannot re-signal the settled evaluator. Unchanged recovery requires durable whole-tree proof, and unchanged terminal release requires both terminal and process quiescence. No controller/recovery policy change. |
| Real fallback timeout | `tests/composition.integration.spec.ts:529–579`; `tests/fixtures/loader/evaluator-exited-parent.mjs:7–17`; corrected helper `:90–115` | Real provider operations and forwarding handles; child readiness precedes atomic PID publication, direct `0/null`, evaluator wait-entry and live-child assertions. Only the disclosed containment selector is forced. Timeout result/persistence assertions occur before failure cleanup. R1 no longer permits a cleared watchdog to generate the abort. |
| Normal-selection candidate cancellation and awaited HMR | composition tests `:581–668`; observation fixture `:39–79`; harness `:183–205` | Both rows preserve normal selection and record the selected mode. They act after a real candidate commit/direct exit/live descendant, assert non-running child before the real tracker write, await settlement/old-fiber disposal, consume canonical cancellation through `job_output`, and check accepted HEAD/ref restoration, local/shared locks and claims, child/job quiescence, unique registrations, unchanged caller and identical terminal resume with no new attempt. |
| Failure cleanup | observation fixture `:70–79`; composition `:573–577,669–684`; negative proof | Captured original handles are terminated/drained before owner/Host disposal, independently of the broken caller-cancellation path. The recorded pre-fix failure also demonstrates cleanup rather than relying solely on successful runs. |

The real fallback row is deliberately a direct evaluator/persistence-callback proof, not a SQLite/controller timeout run. Candidate `job_kill`/HMR rows provide the durable/lock/recovery evidence. No new Host-shutdown, Windows or rc.3 coverage is inferred. The existing real-clock pre-readiness timeout remains present at `tests/evaluator.spec.ts:698–727`.

The production diff remains a localized lifetime restructuring, with no new process manager, schema, dependency, version, public API or evaluator authority. Documentation matches the intended boundary. No additional correctness, security, maintainability or consumer-test-validity defect was identified.

## R1 closure and recorded proof

`controlWatchdog()` now retains the exact native `NodeJS.Timeout` returned for the distinct evaluator deadline. Its `clearTimeout` observer marks cancellation only for that object and forwards every clear to the real function. `fire()` checks cancellation **before** clearing/invoking the callback; a repeated arm still fails. All other scheduled callbacks, provider grace clocks and I/O remain real. The consumer's 30-second operation deadline is below the selected 137,123 ms watchdog, so this scenario does not depend on naturally firing and then manually replaying that timer.

This closes the concrete round-one hole: the installed fallback provider retains its own `spec.signal` listener through range exit (`runner-launch-B2zsQ1Dz.js:918–955,1020–1050`), but the test can no longer resurrect an evaluator-cancelled callback to activate it.

Proof directory: `/root/dsh-r1-proof-3CgaV9`.

| Recorded evidence | Result and limit |
| --- | --- |
| `positive.log`, `results.json` | Fixed real fallback row plus three independent-gate first-cause/natural rows: **4 passed, 94 filtered/skipped, 2.94 s**. Fallback row: 1,700 ms. This is a focused post-correction run, not full coverage. |
| `negative.log`, `negative-proof.json` | Unchanged real fallback consumer against isolated `75ecd4bfdb0fef51993f475de55b16da0d9b1c21` evaluator: **1 expected failure, 21 filtered/skipped, 2.38 s**, exit 1. Exact failure: `evaluator watchdog was cleared before tree quiescence`, at helper line 107 / consumer line 567. |
| `negative-proof.json` cleanup | Parent and child were non-running; marker and Host roots were removed; `externalCleanupBeforeProof` was false. The failed assertion was not converted into a pass by driver cleanup. |
| Reviewer hash comparison | Current helper SHA-256 matches the recorded helper: `d0404a165d1fd12d4c3e34d67e53fc8e1473f99ad9bbbb93eee6d0ba1057b5fc`. The evaluator read from the recorded old Git commit matches recorded source SHA-256: `48fb096514ba8f23338df3606771eb335d354980f3246f1dce7289f28fb6cb19`. |

The isolated compiled-module identity and process observations are worker-recorded evidence, not a new execution or loaded-module trace by this reviewer. The source/helper hash comparisons above were independently performed during this review. The evidence supports closing R1/F6; no test assertion, deadline or acceptance criterion was weakened to obtain the positive result.

## Typecheck scope

The worker records a passing project typecheck and a passing strict isolated check of the actual changed `controlWatchdog` AST. `fixture-typecheck.log` separately records TS2683 at fixture lines 48, 54 and 57 (`this` in existing forwarding spies).

Those lines predate the **R1 correction**, not the entire Issue #21 diff: the fixture is new to this change. They are outside the actual declared project typecheck/build scope: `tsconfig.json:12–18` includes only `src/**/*.ts` and excludes `tests`; `package.json:44–51` uses that configuration; `vitest.config.ts` does not enable a separate test typecheck. The supplemental whole-fixture strict diagnostic therefore is not a failed configured gate or a defect introduced by the helper correction. This review does **not** claim the whole fixture is strict-typecheck clean. Real forwarding behavior is exercised by the supplied integration results.

## Accounting and remaining coordinator gates

- **AC1 / W4:** implementation and regression review converged; R1 is closed. The coordinator can record this verdict against W4/W13/F6 without another implementation replan.
- **AC3 evidence:** coordinator reports peers, project typecheck, build and serialized full coverage green before the helper-only correction: **684 passed, 10 skipped, 1,131.18 s**. Production did not change afterward according to the supplied execution record. Post-correction worker proof is the focused run and typechecks above; do not relabel the earlier full suite as a post-correction full run.
- Packed installed smoke remains the coordinator's sequential verification step. This report does not certify that unrun step, waive the ledger's final-tree/full-gate requirement, or mark the whole stacked task complete. Final union/rebase gates remain as planned.
- AC2/AC4/AC5, #22 transport implementation/design, publication and merge accounting are outside this review. No source, test, ledger or project-lesson edit is requested by this verdict.
