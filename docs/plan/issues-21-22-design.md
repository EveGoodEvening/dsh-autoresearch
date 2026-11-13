# Issues #21 and #22: proposed design for PLAN-REVIEW

Research baseline: coordinator-supplied `fix/21-evaluator-quiescence` at `83787a9`, 2026-11-13. Planning only; no implementation, dependency changes, build, tests, commits, pushes, or PR operations performed by this worker. The coordinator owns the [ledger](issues-21-22-ledger.md).

## 1. Recommendation and decision boundary

- **Firm proposal, #21:** extend the existing evaluator lifetime `try/finally` through the provider's whole-tree `waitForExit()`. Preserve the existing first-cause classification, error precedence, durable writes, and controller recovery/lock rules. No replacement process manager or `Promise.race` escape in production.
- **Firm proposal, #22:** retain complete small successful results; otherwise serialize a presentation-only object containing exact `status`, `runId`, `tracker`, `best`, `counts`, optional `target`, and `detailsOmitted: true`. Never slice JSON, truncate identities, or feed the summary back into canonical decoding/storage.
- **Material decision before #22 implementation:** the existing configuration accepts `maxResultChars: 1`. No JSON object containing the required fields can fit one character. Moreover, canonical tracker/experiment strings have no general maximum length. A renderer alone cannot satisfy both an exact configured cap and lossless required fields for every currently accepted input. Section 4 gives the concrete recommendation and rejected alternatives; PLAN-REVIEW must not silently waive this conflict.
- **Transport decision:** `job_output.value.text` and the actual model-facing `content` are different surfaces. Preserve the character cap on the JSON and explicitly budget UTF-8 encoding plus DSH's status suffix for the transport. Otherwise a correct adapter can still be truncated downstream.
- Exactly two PRs: #21 first, then #22 stacked on it. No rc.3 migration, Windows expansion, package/version bump, npm publication, canonical schema change, SQLite migration, or dependency upgrade.

## 2. Evidence inspected

### Repository and issue evidence

| Ref | Observed evidence | Consequence |
| --- | --- | --- |
| E1 | [Issue #21](https://github.com/EveGoodEvening/dsh-autoresearch/issues/21), including its recorded real Linux DSH fallback-provider output | The reported repro is authority; this worker did not rerun it. It records direct exit `0/null`, a live descendant, ineffective watchdog/cancellation, then `measured` after external cleanup. |
| E2 | [Evaluator lifecycle](https://github.com/EveGoodEvening/dsh-autoresearch/blob/75ecd4bfdb0fef51993f475de55b16da0d9b1c21/src/evaluator.ts#L308-L410), also inspected locally at those lines | Cleanup currently runs at 365–369, before `waitForExit()` at 377. Classification at 393–405 already gives cancel/timeout precedence over an otherwise successful metric. |
| E3 | [Existing descendant tests](https://github.com/EveGoodEvening/dsh-autoresearch/blob/75ecd4bfdb0fef51993f475de55b16da0d9b1c21/tests/evaluator.spec.ts#L534-L621); local `tests/evaluator.spec.ts:88–136,808–854` | The descendant fixture keeps the parent alive. Its test-only `LocalHandle.waitForExit()` simply awaits `done`, so it cannot establish the reported direct-exit/whole-tree distinction. Existing tests already cover pre-abort, first-stage cancellation, startup timeout, and several persistence/provider failures. |
| E4 | [Issue #22](https://github.com/EveGoodEvening/dsh-autoresearch/issues/22); [adapter](https://github.com/EveGoodEvening/dsh-autoresearch/blob/75ecd4bfdb0fef51993f475de55b16da0d9b1c21/src/index.ts#L63-L69) | The successful fallback retains only `status/runId/tracker`. Issue evidence is a function probe, not a 100-round Host run. Failed/cancelled branches currently follow different presentation paths. |
| E5 | `src/config.ts:86–115,130–131,189–190`; `src/types.ts:375–441,539–570,615–628` | Default cap is 16,384; minimum is 1. Successful canonical variants both require `best`. All three counts are required safe integers; tracker and experiment identity use normalized-text validation without a length cap. |
| E6 | `tests/controller.spec.ts:1401–1408`; `tests/contracts.spec.ts:101–119` | Existing regressions deliberately permit a complete canonical terminal result at cap 1 and a result with 202 artifact references above the default cap. Preserve them; do not raise the global Config minimum or restore canonical size rejection. |
| E7 | `src/controller.ts:584–633,675–688,1060–1089,1153–1161`; `src/index.ts:149–163,188–198,259–269` | Evaluator facts feed atomic attempt evidence and ordinary recovery. Terminal lock release precedes presentation. Background settlement/disposal already has an owner-relative non-consuming Jobs barrier. Leave these authorities intact. |
| E8 | `tests/fixtures/harness-composition.ts:40–59,100–157,183–220`; `tests/composition.integration.spec.ts:333–381,442–504` | Real Loader composition imports the package's generated `lib/`. Settlement must be observed before collecting `job_output`; HMR must await the old fiber. Existing HMR tests cover live parents/children, not the reported orphan window. |
| E9 | `tests/fixtures/loader/model-provider.ts:82–109`; `tests/release-scenarios.integration.spec.ts:310–410` | Existing deterministic proposal provider has an accepted-candidate path selected by objective `release accepted candidate`, with real read → write → report. Existing installed scenarios demonstrate how to inspect SQLite, accepted HEAD, locks, and terminal resume. |

The published source links above come from the issue's immutable release baseline; local line references are the inspected planning checkout. Full Host `job_kill`/HMR behavior in the precise #21 window remains **unverified**, not an additional demonstrated bug.

### Installed DSH evidence, exact version `0.2.2-rc.1`

These are installed-file inspections, not a fresh package-integrity verification:

- `node_modules/@deepseek-ai/dsh-subprocess/README.md:39–70,98–113`: `done` reports direct-command outcome; `waitForExit()` proves managed-range emptiness and can reject when ownership cannot prove it. `terminate()` is provider-owned and idempotent.
- `node_modules/@deepseek-ai/dsh-subprocess-local/lib/runner-launch-B2zsQ1Dz.js:797–843,918–995`: fallback ownership observes the process group after direct exit; Linux filters zombie-only groups. Termination escalates TERM → KILL; the provider keeps its abort listener until range exit. Passing an already-aborted signal into `waitForExit(signal)` can return `false` instead of waiting.
- `node_modules/@deepseek-ai/dsh-subprocess-local/lib/index.js:1450–1575` and `lib/types/index.d.ts:22–57`: `LocalSubprocessRuntime` is the real provider; `internals` is a test seam, but containment selection is private. The service itself also calls `waitForExit()` after `done` to release live handles.
- `node_modules/@deepseek-ai/dsh-tool-jobs/lib/index.js:150–156,244–250,278–292,407–452`: `job_output` renders the JSON body plus `\n[status: …]`; its finalizer tail-truncates **UTF-8 bytes** to the producer's `outputLimitBytes`. The structured `value.text` is not changed by that finalizer.
- The same file, lines 318–370 and 445–452: completion notices can consume the registry result, retain it, and give it back through `job_output`. A second raw `jobs.read()` is not a substitute.
- Installed `@deepseek-ai/dsh-jobs-local/lib/index.js:416–417,631–642,769–795`: `outputLimitBytes` must be a positive safe integer; the registry stores `outcome.result` unchanged and delivers it once, then emits settlement. It does not enforce the presentation cap on that stored string.

[INFERENCE] Checking only `JSON.parse(output.value.text)` can therefore miss a truncated model-visible body at a byte/status-suffix boundary. The new regression must exercise `content` too; no such runtime probe was performed during this research.

## 3. PR #21 — evaluator lifetime authority

### 3.1 Minimal implementation

Keep all current preflight, already-aborted no-spawn handling, immutable-boundary validation, output collection, artifact writes, and typed outcome precedence.

Restructure only the live-handle lifetime:

1. Install watchdog/caller-abort handling as today. Keep `cause` first-wins (`undefined → timeout` or `undefined → cancelled`).
2. Put the existing spawn/`done` error-capture block **inside** an outer `try/finally` that also includes termination-on-error and `await handle.waitForExit()`.
3. After direct `done`, do not remove any authority. A later watchdog/caller abort must still abort the provider signal and request termination once while whole-tree waiting is pending.
4. Preserve the explicit terminate-and-drain path for spawn-observation persistence failure, post-spawn frozen-boundary failure, and rejected `done`. Do not turn provider/boundary errors into successful timeout/cancel results merely because an abort also occurred.
5. In the outer `finally`, clear the watchdog and remove caller/provider-facing listeners. It must run for normal quiescence, `false`, and thrown termination/wait errors. Declare the quiescence state outside that block for the existing outcome/persistence code.
6. Only after that boundary collect/finalize artifacts and persist the classified outcome. If direct exit was `0/null` but the remaining tree timed out, preserve direct `exitCode: 0, signal: null` **and** `timedOut: true`, failure `timeout`. Do not invent a signal, PID, exit, or earlier quiescence.

Illustrative control flow, not a patch:

```text
arm deadline and caller cancellation
try:
    try: spawn; persist observed spawn; validate boundary; await direct done
    catch: retain existing execution/boundary error
    if handle exists:
        terminate when cause/error requires it
        drain direct done on the existing error paths
        quiescent = await handle.waitForExit()  // no aborted signal
finally:
    remove deadline and abort listeners
collect artifacts; classify with existing precedence; atomically persist
```

No new timeout starts after `done`: that would extend the evaluator's original deadline. No `Promise.race` returning while a managed tree is alive. No `waitForExit(controller.signal)` shortcut. An unproven/failed wait stays uncertain; this change must not release its lock or call `persistAttemptQuiescent(true)` without proof.

Expected production diff: `src/evaluator.ts`, not controller/recovery policy. Documentation: one concise Unreleased changelog entry. Coordinator can replace the old AGENTS diagnostic with a verified lesson after the regression passes.

### 3.2 Deterministic unit regressions

Extend the evaluator fake with **independent** direct-outcome and tree-exit gates; do not reuse the fake's current immediate `waitForExit` behavior for this case.

| Case | Controlled sequence | Consumer-visible assertion |
| --- | --- | --- |
| Timeout after successful direct exit | Resolve `done` as `0/null`; await evaluator entry to the tree wait; advance only the watchdog; keep tree gate closed | Termination requested; no artifact outcome/final result until tree gate opens; then persisted/returned `timeout`, not `measured`, correct flags and quiescence. |
| Cancellation after successful direct exit | Same window; abort caller twice; release tree gate only after observing termination | Exactly one evaluator-owned explicit termination request, `cancelled`, no success/early persistence. Provider's own idempotent abort handling need not have an exact invocation count. |
| First cause wins | Timeout then cancel while held; reverse the order in a second row | Flags and code preserve the first cause even though direct exit was successful. |
| Natural descendant exit | Resolve direct exit first; release tree gate without abort/deadline | Successful metric is not persisted before tree exit; remains measured afterward. |
| Unproven/rejected wait | Wait returns false or rejects after direct exit | No fabricated quiescence. Existing uncertain/failure behavior remains; later cancellation/deadline must not signal a settled handle after cleanup. |

Reuse, rather than duplicate, existing pre-abort, real-clock unready timeout, frozen-boundary, rejected-`done`, artifact-write and persistence-failure tests. Add a missing assertion only where the new outer-finally boundary changes coverage. Do not weaken existing redaction/provenance assertions.

### 3.3 Real provider and full Host regression

Add a small fixture for **parent exits, child stays alive**; do not silently change the meaning of the existing hold-parent fixture.

Fixture protocol:

- Spawn a child in the inherited managed process group, with ignored stdin/stdout/stderr and an IPC channel solely for readiness. Do not use detached/setsid for the descendant: escaped descendants are a different provider guarantee.
- Child installs its hold behavior (and, for escalation coverage, ignores SIGTERM), then sends `ready`.
- Parent atomically publishes a JSON marker containing parent/child PIDs (temporary sibling + rename), disconnects IPC, unrefs the child, writes exactly one valid metric, and exits normally. PID observations belong to test evidence, not the production provider-PID field.
- For full candidate coverage, baseline score `1` completes normally; candidate score `0` takes this holding-descendant path. Reuse the accepted-candidate model objective and minimize direction.

**Required real rows:** timeout, model-facing `job_kill`, and awaited plugin HMR/unload, all triggered only after direct outcome `0/null` and a still-live child are observed. The timeout may use a small baseline-only direct-evaluator case; the kill/HMR cases should use a candidate so accepted-HEAD restoration and prior best preservation are exercised.

Use `composeHarness` and its real DSH subprocess service. Observation wrappers must forward the real spawn, handle, `done`, termination and wait; never supply synthetic exit/quiescence. Return a forwarding facade to the evaluator if necessary: spying on the provider-owned handle's first `waitForExit()` would confuse the service's own release wait with the evaluator's wait.

For a deterministic reproduction of the reported fallback path, a **test-only containment-selector override to `fallback` on the real provider instance** is acceptable; disclose it and restore it after owned work drains. Do not replace process operations/handles, import a hashed private bundle export as the test API, or pretend Linux is Darwin (that disables Linux zombie filtering). At least the Host lifecycle rows must also use normal provider selection, recording which provider path actually ran. This separates a forced real-fallback regression from platform-selected composition proof.

Timing and assertions:

1. Subscribe to non-consuming Jobs settlement and install the marker watcher before starting work. Race readiness against the evaluator/job outcome; never wait for a marker that cannot arrive after early failure.
2. Capture only the exact evaluator fixture invocation, not Git subprocesses. Observe direct `done`, evaluator tree-wait entry, and live child state before triggering the test action.
3. For deterministic timeout placement, intercept/advance **only the evaluator watchdog**, using a distinct deadline value/callback while provider grace timers and I/O remain real. Do not fake all Host timers or reset production time at readiness. Retain the separate real-clock pre-readiness timeout test.
4. Before the real `persistAttemptOutcome` delegates its write, assert that the child has no live state; after settlement verify `process_tree_quiescent = 1`, the typed timeout/cancel outcome, and direct exit facts. A zombie is non-running on Linux, not evidence of live evaluator execution.
5. Timeout is a failed attempt; a baseline timeout is `baseline-blocked`, while a candidate timeout can consume its ordinal and continue. Do not demand a top-level `timeout` status that the run union does not have.
6. Kill/HMR must settle the registered job, return canonical cancellation through real `job_output`, preserve prior best, restore accepted worktree/refs, release local and repository locks and controller claims, remove proposal children, and leave the caller tree unchanged. HMR must restore exactly one tool/prompt registration.
7. Terminal foreground resume must return the same canonical result with no extra evaluator attempt. Keep the stable activation fields and replace only start selectors with `resume_run_id`.

**Failure cleanup is part of the test design:** bound the scenario with a real test-owned deadline, then in `finally` directly call the captured provider handle's `terminate()` and await its real wait and evaluator/job promises before disposing owner/Host or deleting files. Merely aborting the caller reproduces the old bug and can hang cleanup. Never credit external cleanup as the action that made the tested assertion pass. Keep teardown errors visible; do not restore spies or fake clocks while owned work is still live.

The existing fixture/Host shutdown tests remain the general teardown coverage. Add a separate Host-shutdown variant only if the lifecycle change exposes a distinct ownership gap; do not claim that variant passed from a `job_kill` result.

## 4. PR #22 — bounded successful job summary

### 4.1 Presentation contract

For `budget-limited` and `target-reached` only:

```json
{
  "status": "budget-limited",
  "runId": "exact durable run id",
  "tracker": "exact durable tracker path",
  "best": { "metric": 0, "commit": "full SHA", "experimentId": "exact experiment id" },
  "counts": { "experimentsStarted": 1, "experimentsCompleted": 1, "attempts": 2 },
  "detailsOmitted": true
}
```

`target-reached` also retains its numeric `target`. The example's explanatory strings are not proposed runtime values.

- Serialize the complete result once. If it fits the agreed JSON budget, return that exact string, including all artifacts and no omission flag.
- Otherwise construct the above object from authoritative result fields and serialize it. `detailsOmitted` describes omitted artifact/detail listings, not a failure. Tracker plus run ID remain the durable retrieval entry; do not invent an `artifact://` API or claim a new summary-fetch tool exists.
- Success stays `JobOutcome.status = completed`, `detail = result.status`. Leave failed/killed/cancellation/startup mappings and `src/index.ts:189`'s settled cancellation result intact.
- No summary in `AutoresearchRunResult`, its schema/decoder, SQLite, history, TSV or terminal resume. A small helper in the existing presentation layer is preferable to exporting the private `jobOutcome` through the package root or adding a new subsystem.
- Preserve exact zero/negative/exponent metrics, full commit/experiment identity and all three counts. Never use truthiness to decide whether a best metric exists. In the current success union `best` is mandatory; do not synthesize an empty best for other variants.

### 4.2 Minimum-limit conflict: recommendation for coordinator decision

There is no compliant fallback for cap 1: `{}` itself needs two characters and has none of the required fields. A fixed floor such as 512/1024 is also not a proof for an arbitrary valid tracker path or historical experiment identity. Current canonical validators intentionally do not impose those length bounds.

**Recommended decision candidate: strict background-output admission, not canonical validation.** Preserve `maxResultChars` as an exact JSON-character ceiling and keep Config/foreground/controller canonical behavior at 1. A background submission or background resume whose required summary envelope cannot fit must be rejected **before it becomes an executing research job**, with an actionable required-budget error. Never discover the insufficiency in `jobOutcome` after successful research, convert a completed result to failed, or strand a prepared run's locks.

Implementation obligations if this candidate is approved:

- Base admission on serialized required metadata, not a magic minimum. For new runs, reserve the exact canonical tracker location, UUID width, full SHA, longest generated baseline/candidate experiment identity, safe-integer counts, finite-number representation and optional target. Conservative numeric/ordinal width reservations are acceptable; identity truncation is not.
- For resume, include actual existing durable identities; do not infer that every legacy experiment ID has today's generated length. Inspection must be read-only, use existing containment/identity authority, and admit future generated candidate identity width for a nonterminal run.
- Resolve canonical path identity rather than estimating from an uncanonicalized lexical path. Sharing an existing read-only identity step is preferable to duplicating controller initialization or introducing a second tracker/path convention. If this requires a larger initialization split, return that concrete scope cost to PLAN-REVIEW before implementation.
- The invariant after admission is that every reachable successful core fits. The renderer is not permitted to drop required fields if the invariant fails. Boundary tests must establish that invariant, not just assert that a chosen short fixture fits.
- A too-small background **resume** must leave the existing durable run untouched and still retrievable through supported foreground resume/tracker access. This is a presentation-channel admission error, not invalid canonical evidence.
- Document this new background-only rejection explicitly. It is a compatibility tradeoff and needs coordinator acceptance; this planning worker has not obtained that acceptance.

Rejected alternatives under the present AC:

| Candidate | Why it is not an approved shortcut |
| --- | --- |
| `max(configuredCap, core.length)` or a hidden fixed floor | Preserves fields but exceeds the configured cap; needs an explicit AC/config-contract change. |
| Drop/truncate tracker, best, counts, or experiment identity until it fits | Violates the required summary/identity contract and can destroy durable access. |
| Return `{}`, `null`, a scalar, a token, or only an error | Loses required information or changes successful completion into failure. |
| Raise the global Config minimum or reject in `decodeRunResult` | Breaks the existing cap-1 canonical regression and revives the #6 failure mode. |
| Assume a short OS path, compress/rename keys, or change canonical IDs/storage | No proof for every accepted value; extra protocol/storage changes outside scope. |

If the coordinator requires **all currently valid cap-1 background executions to continue succeeding**, strict admission is not available. Then one of the mutually incompatible cap/field requirements needs explicit user resolution. Do not mark #22 implementable/AC-complete with a renderer-only plan. This is a mathematical contract conflict, not a speculative runtime bug.

### 4.3 Character budget versus DSH byte budget

Recommended companion decision: keep JSON at `C = maxResultChars` UTF-16 code units, and register a separate finite transport allowance sufficient for UTF-8 and the successful status suffix:

```text
JSON:       serialized.length <= C
transport:  outputLimitBytes = min(Number.MAX_SAFE_INTEGER, 3 * C + 64)
```

Three bytes per UTF-16 unit bound valid UTF-8 encoding (astral pairs need four bytes for two units). The 64-byte reserve covers the currently inspected successful DSH status line; the real-surface regression must fail if upstream framing stops fitting. This is an explicit encoding/framing allowance, not permission for larger JSON/history. Clamp arithmetic to a valid safe integer. No dependency patch or override of generic `job_output` is needed.

This changes the current numeric `outputLimitBytes = C` mapping and therefore requires explicit PLAN-REVIEW acceptance. If the intended contract instead requires the **entire model-facing message to remain within C bytes**, subtract the actual status-suffix byte cost before serialization and define “small” by the complete UTF-8-framed size. That alternative is stricter than today's character test and changes exact-boundary behavior; do not mix the two definitions silently.

Either choice must prove that model-visible content equals the whole JSON plus the expected DSH status line, with no `[output truncated]` or `[result truncated]`. Parsing the entire content as JSON is wrong because DSH intentionally appends that line; parse the JSON body and assert the framing separately.

### 4.4 Deterministic regressions

1. **Real successful oversized job:** use `composeHarness`, the existing accepted-candidate objective, minimize direction and one real candidate. Choose an admitted small cap so the real canonical result's artifact references exceed it; assert that fact from the completed canonical result, rather than assuming fixture size. No 100-round expensive run, fake controller result, source extraction, or manufactured tracker rows.
2. Subscribe before start; await the exact settled job; call real `executeTool(..., 'job_output', ...)` as its owner. Assert completed status, parseable JSON, exact best metric/full commit/experiment, all three counts, exact run/tracker identity, omission flag, and the chosen character/byte bounds.
3. Assert model-facing text content is exactly that JSON plus DSH's status suffix. Include a repository/state path with non-ASCII and JSON-escaped characters to exercise byte/escaping costs, without corrupting canonical identity.
4. Inspect SQLite best/attempts/artifacts/terminal locks. Foreground terminal resume returns the complete canonical result with artifacts, identical required fields and no presentation marker; repeated terminal replay has no new attempt. Compare durable rows before/after job-output collection; do not demand byte-identical SQLite files across a resume that legitimately updates a controller claim/retention bookkeeping.
5. Cover both successful variants: candidate-accepted `budget-limited` and `target-reached` with exact target. A baseline-target case also proves counts `0/0/1` and a zero metric survives.
6. **Small result:** with ample cap, real job output equals the canonical JSON/result, including artifact references, and has no omission marker. Exercise the exact accepted boundary in the presentation helper; one unit less switches to the complete compact object when that object fits.
7. **Large in-memory edge:** reuse the scale of the existing 202-artifact contract fixture to exercise summary selection, but through the new presentation helper, not a source-text extraction. Confirm input remains unchanged and canonical decoding still accepts it.
8. **Minimum/identity edges, conditional on the admitted policy:** cap 1, below the mandatory envelope, exactly the envelope, one above, long escaped tracker, non-ASCII paths, safe-integer maximum widths, negative/zero/exponent metric, optional target, existing longer resume identity. Too-small background admission must have no evaluator spawn/new executing job/lock or durable-row mutation; foreground/canonical cap-1 behavior remains unchanged. Do not replace these with only default-limit tests.
9. Keep the existing killed/failed composition tests green; do not broaden this fix into a redesigned failure-summary schema.

The real `job_output` result may have been consumed by a completion notice; let the tool recover its held result. Do not call `jobs.wait()` internally or read the registry first. A bounded `job_output(wait: true)` returning `running`/empty text is not a completed result.

Expected renderer-only diff: `src/index.ts`, existing presentation helper location, focused tests and changelog. Strict admission, if selected, adds a separately reviewed read-only budget/identity preflight and concise user-facing documentation in both READMEs; do not hide that scope inside a serializer change.

## 5. Runtime and verification gates

### Runtime findings — executed during research

- `node --version` → `v24.22.3`; `corepack --version` → `0.36.0`.
- `command -v pnpm` found no executable. `COREPACK_ENABLE_AUTO_PIN=0 COREPACK_DEFAULT_TO_LATEST=0 corepack pnpm --version` in this checkout → `11.7.0`.
- Cached entry exists at `/root/.cache/node/corepack/v1/pnpm/11.7.0/bin/pnpm.cjs`. It is a mode-0644 CJS shim importing `./pnpm.mjs`; a direct executable symlink failed with `Permission denied`. Do not “fix” global file permissions.
- A temporary executable `pnpm` wrapper invoking that entry with the absolute Node path worked, including a nested `spawnSync('pnpm', ['--version'])` with cwd `/tmp`: `{"nestedPnpmStatus":0,"nestedPnpmVersion":"11.7.0"}`. The temporary wrapper/directory were removed after proof.

Recreate the same isolated wrapper in a fresh temporary bin directory when running nested package scripts or installed-profile smoke:

```sh
#!/bin/sh
exec /root/.nvm/versions/node/v24.22.3/bin/node /root/.cache/node/corepack/v1/pnpm/11.7.0/bin/pnpm.cjs "$@"
```

Prepend only that directory to the command's PATH. This pins nested `pnpm` outside the checkout without changing global/Corepack selection. A bare `corepack pnpm` in a new profile does not inherit this repository's `packageManager` guarantee. Clean the wrapper after all children finish.

### Coordinator baseline — reported during planning

The coordinator reports a working `COREPACK_DEFAULT_TO_LATEST=0 corepack pnpm` at 11.7.0, passing typecheck and build, and a coverage run that failed after 496 seconds: **674 passed, 10 skipped, one failure**. The failure is `tests/release.spec.ts` launching the nested release scenarios: the first prepare-barrier case exceeded its existing **45-second** deadline; the other nine nested scenarios passed. No source implementation had changed. Accept this as baseline evidence; do not rerun it merely to confirm, attribute it to either proposed fix, or describe the baseline as green.

Source inspection bounds the hypothesis:

- `tests/release.spec.ts:32–53` launches `scripts/release-scenarios.mjs` from an outer Vitest case with a 500-second deadline.
- `scripts/release-scenarios.mjs:15–18,60–75` launches a second Vitest process for the integration file, inherits the environment, and reports nonzero exit with captured output. It does not pack or rebuild `lib/`.
- `tests/release-scenarios.integration.spec.ts:138–217` gives its first case 45 seconds for Host composition, repository setup, `controller.prepare()`, a complete accepted research run, assertions and teardown. The case name does not identify which of those phases exceeded the deadline.
- [INFERENCE] Cold Loader/provider startup and Git/process work competing with outer-suite workers or another machine-wide heavy job are plausible latency contributors. No phase timing or resource trace in the supplied result distinguishes contention from a genuine pending lifecycle operation. Nine subsequent passes do not establish that the first failure was harmless.

Verification strategy, without weakening the gate:

1. Preserve the existing 45-second inner and 500-second outer deadlines, all coverage thresholds and all cases. No retries-until-green, skips, weakened assertions, test filtering in the final suite, or timeout increases.
2. Keep the original failing log as pre-change provenance. At the implementation's next meaningful check, record gate holders/load, Node/pnpm identity, build identity and complete failure output. Run only one owned integration stage; no concurrent pack, rebuild or second verification worker.
3. For the final full suite, use controlled outer concurrency under the heavy gate: `pnpm run typecheck` → `pnpm run build` → `pnpm exec vitest run --coverage --maxWorkers=1`. This is the same full coverage gate with serialized workers, not an additional full run after `pnpm run check`. Record the execution policy rather than silently changing project coverage configuration.
4. If the first case still fails during that changed-tree verification, make the next investigation discriminating: temporary phase timing around composition, prepare, run and disposal, plus owned subprocess/Jobs state, under the same deadlines. A focused run with that added observability may localize the failure; a focused pass alone cannot replace the full coverage gate. Drain owned work before restoring instrumentation/removing roots.
5. A measured scheduling/setup problem calls for bounded execution/concurrency correction; a pending evaluator/teardown path calls for a causal fix and its regression. Do not label either without evidence or broaden these PRs into a general audit. Escalate a genuinely separate required fix to the coordinator before changing scope.
6. The rebased final tree still requires a green complete coverage run and the coordinator's remaining gates. The known baseline failure is not a merge waiver. Record any remaining failure accurately rather than predicting a successful rerun.

### Gates owned by implementation/coordinator

No gates below were run by this research worker.

- Build before every composition check of changed source: `pnpm run typecheck` → `pnpm run build` → focused Vitest cases. Generated `lib/` exists now but is not evidence for a later edit.
- PR #21 focused checks: evaluator tests and the new real provider/job-kill/HMR cases in composition. PR #22 focused checks: presentation boundaries, real successful job-output cases, and the existing cap-1 canonical/oversized-contract regressions.
- Final project check per review-ready branch: `pnpm peers check`, then the serialized equivalent of `pnpm run check` specified above (typecheck → build → full coverage with `--maxWorkers=1`). Run one full coverage suite, not `check` followed by another full suite or a duplicate `pnpm test`. No lint script is declared in `package.json`; do not invent a lint gate.
- Run existing sequential `pnpm run release:smoke` where required by the coordinator's full project/release-artifact gate. It must not overlap Vitest or another pack/build: `prepack` deletes/rebuilds shared `lib/`. A packed installed pass is separate evidence, never inferred from linked composition. No `npm publish` or publish dry-run.
- No latest/next repinning, lock refresh, compatibility migration or broad security-remediation work belongs to these two fixes.

Resource rules apply to all future checks: `free -m` and `~/.omp/bin/heavy-gate --status` before fan-out. Research observed about 8.4 GiB available with one gate slot occupied by another session; capacity must be rechecked, not reserved from that old observation. Run commands expected above 2 GiB through `~/.omp/bin/heavy-gate -n 1 -m 6G -- <command>`, finite bash calls with `async:true, timeout:0`, no outer `timeout`. Prefer `--maxWorkers=1` for focused integration runs. Stop if isolation is unavailable. No browser is needed. Never kill another session's holder.

## 6. Exactly two stacked PRs and merge gates

Coordinator operations only:

1. PLAN-REVIEW reviews this proposal independently, including both #22 budget decisions. Resolve Fix/Replan/Ask findings before implementing that slice; #21 is not blocked on choosing a #22 presentation policy.
2. Implement/review/gate #21 on `fix/21-evaluator-quiescence`; its PR targets `master` and closes #21. Record the reviewed parent tip for the stack.
3. Branch `fix/22-background-summary` from that #21 tip. Implement/review #22 plus the union; its PR initially targets `fix/21-evaluator-quiescence`. No third implementation PR or unrelated existing PR is used.
4. Publish both PRs before merging #21. Squash-merge #21 first. Preserve the old #21 tip as the explicit replay boundary; do not rely on a deleted branch name.
5. Fetch updated master; replay **only #22 commits** with `git rebase --onto origin/master <recorded-old-21-tip> fix/22-background-summary`. Resolve conflicts without reintroducing the squashed #21 series. Update the branch with lease protection and retarget PR #22 to `master`.
6. Rebuild and run the relevant/full final gates on the rebased tree; obtain independent whole-change/rebase review as necessary. Squash-merge #22 only after no open findings and complete AC evidence. Fast-forward local master, verify both issue closures and final accounting through the coordinator's ledger.
7. Keep both fixes in Unreleased documentation; do not bump the package or create a release tag.

GH identity was checked with the mandated command and returned `EveGoodEvening`:

```sh
env -u GH_TOKEN -u GITHUB_TOKEN GH_CONFIG_DIR="$HOME/.config/gh-EveGoodEvening" gh api user --jq .login
```

Every future `gh` call must keep that prefix; no auth switch and no token output. This worker issued only read-only issue/user queries.

## 7. Explicit PLAN-REVIEW checklist

- Does the #21 outer-finally cover every await after direct completion, including error-path draining, without changing failure precedence or inventing quiescence?
- Do tests prove direct exit **before** the action, actual surviving descendant **before** the action, and absence **before** durable outcome persistence? Can a regression fail and still clean up using the owned provider rather than the broken cancellation path?
- Is forced real-fallback selection disclosed separately from normal Host provider selection? Are provider operations real in both?
- Do kill/HMR exercise candidate restoration, canonical cancellation output, awaited settlement and released authority—not just a terminated PID?
- **Decision M:** approve background-only insufficient-budget admission, or obtain an explicit cap/field tradeoff. A global minimum increase, hidden floor or post-success error is not an acceptable implicit resolution.
- **Decision T:** approve a bounded character-to-byte transport allowance, or explicitly choose a total-byte/framing budget and its boundary semantics. Test actual tool `content`, not just `value`.
- Does admission account for canonical paths and resumed identities without new mutable initialization, storage rules, or weakening recovery? If its required scope exceeds a minimal #22 fix, replan before code.
- Do small outputs, both success variants, zero metric/counts, Unicode/escaped paths, configured minimum and canonical cap-1 regressions all have explicit coverage?
- Are durable results/schemas/identities unchanged and no dependency/version/migration work included?
- Are the two PR bases, old-parent squash replay boundary, final full gates and independent review ownership explicit?

Research is complete. No behavioral fix is claimed. The #22 presentation-contract choice requires coordinator resolution, and the reported baseline timeout must be distinguished and cleared by the final-gate strategy above. Neither the minimum-cap conflict nor the baseline failure can be waived by a passing default-limit/focused test.
