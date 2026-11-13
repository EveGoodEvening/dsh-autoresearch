# Issue #22 — W6 independent whole-change review, round 1

## Verdict

**Accept the reviewed implementation union. Zero open Fix/Replan findings; no new production correctness, security, lifecycle or consumer-test-validity defect identified.**

The W12 ordering correction is implemented: the owner-lived adapter is appended, so the installed stock spill policy evaluates the proposed two-block shape. The new regression tests that exact boundary through the real policy/backend, with an unadapted one-block control. Issue #21 R1 remains closed, not discarded; its corrected watchdog helper is unchanged from the converged review.

This is implementation-review convergence, **not** a declaration that AC3's final-tree gates or AC4–5's publication/merge work are complete.

## Scope and method

- Reviewed branch `fix/22-background-summary`, observed HEAD `5965ff2`, against `origin/master` at `75ecd4bfdb0fef51993f475de55b16da0d9b1c21`; concentrated on the #22 working changes after `9485a36150c3f9ae1922a0d9b70aad843824584d`.
- Included the untracked `tests/background-output.integration.spec.ts`, not merely the tracked Git diff. Reviewed `src/render.ts`, `src/index.ts`, the Config description, contract/startup tests, both READMEs, Unreleased changelog and project-lesson changes.
- Re-read [ledger AC1–5/D5/D8](issues-21-22-ledger.md), [converged #21 round 2](issues-21-review-round2.md) and [reviewed transport design/correction](issues-21-22-transport-review.md). Revisited the entire #21 evaluator lifetime change, independent-gate tests, real-provider cancellation/HMR assertions and both new evaluator fixtures for interaction regressions.
- Independently inspected installed DSH `0.2.2-rc.1` / scoped Cordis `4.1.0` policy, Jobs, event-ordering and materialization contracts. No language server was configured; source navigation was textual.
- Ran **no tests, typechecks, builds, browser, runtime probes, heavy commands, GitHub operations, commits or delegation**. Parent-owned gates were not disturbed. This report is the sole repository write; source and ledger were not edited.

## AC2: presentation, authority and consumer evidence

The test references below identify assertions inspected, not executions performed by this reviewer.

| Boundary | Source and regression evidence | Assessment |
| --- | --- | --- |
| D5 mandatory envelope, no admission change | `src/render.ts:15–28`; `src/index.ts:64–68`; `tests/contracts.spec.ts:101–127,387–424` | Exact full JSON is selected when its UTF-16 length fits the detail budget. Otherwise the serializer retains status, run/tracker identity, full best tuple, all counts, applicable target and `detailsOmitted: true`. It does not slice, abbreviate or mutate canonical input. Cap one, compact/full neighboring thresholds, zero target/metric, negative/exponent metrics, escaped/BMP/astral identities, a long decoder-accepted identity and safe-integer counts are covered. No admission, identity, decoder, schema or migration change. |
| Actual Jobs byte/framing boundary | `src/render.ts:46–55`; integration `:249–265` | Both blocks are substantive: exact selected JSON and real completed-status suffix. The unchanged stock one-block rendering is required before adaptation. Actual UTF-8 lengths determine overflow; subtraction avoids unsafe cap addition near `MAX_SAFE_INTEGER`. Byte-fitting output remains one block. Assertions cover full JSON fitting characters but not framed bytes, exact byte threshold and safe-integer cap. |
| Exact owner/job/success, no replay | `src/render.ts:34–49`; integration `:387–435` | Requires the exact calling Agent, requested and returned job ID, `autoresearch` kind, completed status, matching success detail, exact known selected text and exact stock content. No registry reread or reconstruction of empty text. A different job with identical text remains capped; repeated consuming reads receive no replay. Running, foreign/descendant, failed, killed and denied calls stay outside the floor. Foreign/descendant runtime assertions occur while the fixture job is running; the exact-owner source guard also applies after completion. |
| Host replacement/block/error/cancellation authority | `src/render.ts:38–57`; integration `:300–384` | Calls `next()` once. Rejects adaptation for non-acceptance, own `value` or `content` properties, errors and an aborted execution. Equal-looking value replacement remains authoritative. Additional contexts are retained; no catch converts a thrown policy into success. Inner pass/context/block/content/value/equal-value/throw decisions, enclosing redaction and cancellation during a pending continuation are asserted through actual finalization. |
| D8 final-shape spill accounting | `src/render.ts:33–34`; integration `:268–297` | No `prepend`. Real stock spill is reconfigured to the one-block-fit/two-block-over threshold. The unadapted control is Jobs-truncated without a spill; the adapted call must spill, save the complete concatenated text and return the policy's capped replacement, not restored JSON. This test would reject the earlier prepended recipe. |
| Real accepted candidate and durable identity | integration `:154–220`; real harness `tests/fixtures/harness-composition.ts:100–121,133–157` | Loads the production bundle/generated `lib/` through the native Loader. Runs baseline plus an accepted candidate at cap one with stock spill/default notices enabled; compares parsed JSON and the entire `content` array with SQLite best commit/experiment, counts and identity. Checks attempt quiescence, local lock release, unchanged durable rows/TSV across resume, and unchanged caller HEAD/status/file. The cap-one notice assertion observes actual delivery, not transient inbox occupancy. |
| Real zero baseline target | integration `:222–245` | Runs the registered evaluator and verifies target/metric zero, zero candidate counts, one attempt, baseline commit/experiment identity, exact two-block content, complete foreground resume, unchanged tracker rows and released local lock. |
| Retained presentation across producer HMR/disable/config change | `src/index.ts:149–175,190–205,226–251,269–279`; integration `:182–219` | Registers on `parent.ctx` before synchronous job start; records its ID before releasing execution. Success state is filled before producer completion, but completed-job guards prevent a later disposal failure from receiving the floor. HMR and cap change are awaited; a second background terminal-resume job retains its new ample cap while the first retains cap one. Both are collected after producer disable. Foreground canonical resume remains complete and adds no attempt. |
| Existing limits and startup failures | `src/index.ts:64–67,174,191,197–205,247–262`; `tests/autoresearch.spec.ts:390–428`; integration `:179–180,416–435` | Producer `outputLimitBytes` is unchanged. Failure/cancellation serialization and startup mappings remain separate. Tests retain cap checks for failed/killed output, `job_kill`, denial and a delivered tiny-cap notice. No-job and partial-start failures check that owner effects return to their pre-call state. |

For selected text T, cap C and compact-envelope length S, the source preserves `T.length <= max(C, S)`. Both ASCII status suffixes fit 36 bytes, so the selected text plus suffix has the documented payload bound `utf8(T) + utf8(suffix) <= 3 * max(C, S) + 36`. This is **not** a Host token-budget bound or an exemption from independent policy. Extremely long mandatory identities can still exceed the configured detail budget, as D5 explicitly permits.

### Installed-contract cross-check

- `dsh-tools/lib/types/contracts.d.ts:337–355` supports accepting content projection. Its pipeline (`lib/types/pipeline.js:277–336,421–457`) applies post-execute policy, original-caller cancellation and then definition-owned finalization; replacement values and blocks keep their authority. Native batch logging uses the final `result.content` (`lib/types/batch.js:214–230`). The integration helper deliberately calls the actual pipeline without a logged model turn, so these tests inspect the model-facing content array, not a new end-to-end LLM-provider transmission.
- `dsh-tool-jobs/lib/index.js:209–221,278–292` preserves substantive multi-block policy content and caps stock/single-text output. This is also its documented public policy contract (`README.md:89–97`), not a private registry mutation. Completion notices can hold consumed results; the adapter checks the actual returned tool value and never manufactures a second read.
- Cordis `src/events.ts:236–269,283–306` composes listeners outermost-first and owns them on the registering fiber. `dsh-spill-policy/lib/index.js:237–255` is prepended and prices `decision.content ?? result.content`. `dsh-token-meter/lib/types/estimate.js:9–11,34–41` charges each text block `ceil(length / 4) + 4`: the budget-limited fixture's split adds exactly four estimated tokens. The new test exercises that cost, not the earlier one-block cost.
- A custom Host must still compose/evaluate policy decisions correctly. No claim is made that this listener guarantees complete JSON under arbitrary policy ordering, deliberate decision replacement or independent spill failure behavior.

## Memory, lifecycle and #21 interaction

`retainSuccessfulJobOutput()` creates its listener in a separate helper scope. The retained callback references only the owner, mutable job/success cell and numeric cap—not the controller, canonical result object, resolved producer configuration, readiness promises or settlement observer. The cell retains one selected string/status per registered job. This follows the Jobs retention model, **not** a fixed bound on the number of jobs.

The owner owns removal; the presentation disposer is called explicitly only when registration failed before a job ID was returned. It is not attached to producer `activeJobs`, the registry-settlement observer, HMR or plugin disable, and adds no awaited teardown barrier. Jobs explicitly retains handed-out terminal records until owner/service disposal (`dsh-jobs/lib/types/index.d.ts:27–42`); installed `dsh-jobs-local` keeps the result after a consuming read and drops owned records on disposal (`lib/index.js:631–641,802–839`). Exceptional explicit job removal can leave an inert presentation cell until owner disposal; no successful stock read can then reach it. No controller-retention path was added by this listener.

The #21 production diff still keeps the original watchdog/caller abort authority around both direct completion and whole-tree waiting (`src/evaluator.ts:308–380`). First-cause facts, provider/frozen-boundary precedence and truthful quiescence persistence are unchanged. Independent direct/tree gates and the real fallback timeout plus normal-provider candidate `job_kill`/HMR assertions remain present. The new success-only transport cannot intercept those killed/cancelled results, and it does not alter controller recovery, accepted-HEAD restoration, lock/claim release or the owner-injected non-consuming settlement barrier.

The corrected exact-watchdog helper still hashes to `d0404a165d1fd12d4c3e34d67e53fc8e1473f99ad9bbbb93eee6d0ba1057b5fc`, matching #21 round 2. Its earlier positive/old-source-negative proof was not rerun or relabeled as new evidence. No prior discarded concern was reopened.

## Public API and documentation

- New helpers/types are internal module exports; `package.json` still exposes only the package root and manifest. No new root export, package subpath, dependency, version, peer range or engine change.
- `maxResultChars` validation/default are unchanged; only its user-facing description changes. Foreground/canonical decoding, durable results and TSV remain outside this presentation floor.
- README/Chinese README, changelog and project lesson consistently explain D5's tiny-cap exception and independent Host-policy precedence. The #21 deadline/quiescence changelog remains accurate. Historical diagnostic npm/rc.3 lesson entries are not used as compatibility proof for this change.

## AC accounting and verification limits

| AC | Review disposition | Remaining coordinator work / evidence limit |
| --- | --- | --- |
| AC1 | Converged #21 implementation and R1 closure preserved; no interaction regression identified. | Prior round-2 execution evidence remains attributed to its workers/coordinator. This review adds no new runtime execution. |
| AC2 | Implementation and inspected regression assertions satisfy D5/D8 and the reviewed transport boundary. | Worker reports are: source typecheck/build passed; initial focused run had 111 passes and one fixture assertion failure; corrected integration passed in 42.36 s. All 112 focused cases passed **across runs**, not in one fresh complete run. These are supplied reports, not independently executed results. |
| AC3 | Documentation/scope and independent whole-union review accepted. | Parent owns final-tree full gates. Their completion/results were not inspected or certified here. Project typecheck covers `src`, not tests; no claim of strict test-file typecheck cleanliness. |
| AC4 | Dedicated branch state inspected; ledger records first PR #23 and planned stack. | No GitHub query performed. Second PR creation/remote target/identity remain coordinator accounting, not inferred from local branch names. |
| AC5 | No code-review objection to the recorded squash/replay strategy. | Merge #21, replay only #22 from the explicit old-parent boundary, retarget, final gates/review as required, merge #22 and issue closure remain pending coordinator obligations. |

No Windows, rc.3 migration, benchmark, arbitrary Host-policy, heap/GC or new packed-installed #22 runtime proof is inferred. The real #22 scenarios are source-inspected tests over a linked built bundle/native Host; they are not a newly reviewed independent tarball installation. The #21 packed-smoke success remains prior coordinator evidence. This acceptance does not waive final-tree or post-replay verification.

### Reviewed snapshot identifiers

| File | SHA-256 |
| --- | --- |
| `src/render.ts` | `cce6764d3bbcf399575c80c6b2b83227540f5823577fcf15b2a5ff8995bbd875` |
| `src/index.ts` | `911942073d72b7cf20c7cfcafd40be2b0db83cda156d43efab0da545f12ee1c4` |
| `src/config.ts` | `2c3c49c0ac8826c14100ee8926827a23cfe25130b99add500c7967f8d33f9b75` |
| `src/evaluator.ts` | `f95ebe0177de85e8509a2ffb1f046c7846a24a491573d88810af6671d7e9a6fe` |
| `tests/background-output.integration.spec.ts` | `66f6bbf19026d8df594ff34bb0423da8d9d69be2454b838572cc4a54c048b662` |
| `tests/contracts.spec.ts` | `1d29d298ccdc83bd5a4c728cc57e2f0a04307389e5e6fa29bdaa365fec9cf5be` |
| `tests/autoresearch.spec.ts` | `bb53ee141a96fd84b7d59f37417f75ea19ad55eeba2b02c9fa4c714255c8709e` |
