# W12 — independent transport PLAN-REVIEW

## Verdict

**Fix, localized: W11-T1 is not approved as written. The supported two-block mechanism is viable; remove its prepended ordering before implementation. No transport redesign or third PR is needed.**

The one blocking finding is **W12-T1: the adapter runs after an existing Host spill policy has evaluated a different content shape**. Preserving explicit replacement decisions is necessary but insufficient: an accepting policy can enforce a budget without returning a replacement. The proposed split adds structural tokens after that acceptance.

The corrected implementation recipe below is firm for the installed stock pipeline and normally composed Host wrappers. Keep the coordinator's AC clarification: complete successful JSON through producer/Jobs transport under compatible accepting Host policies, not an exemption from independent spill/redaction. Retain actual stock `job_output.content` proof.

Reviewed [D5](issues-21-22-ledger.md#decision-log), [prior review T1](issues-21-22-plan-review.md#t1--medium-22-only-specify-how-the-transport-allowance-reaches-real-job_output), W11-T1, producer/presentation code, existing test seams, and installed **DSH 0.2.2-rc.1 / scoped Cordis 4.1.0**. Dependency references below are package-relative paths under the installed pnpm tree. No tests, builds, runtime probes, browser/heavy commands, implementation/ledger edits, commits, GitHub operations, or subdelegation. This file is the sole written artifact. This is a source-based plan verdict, not implementation verification or a claim about later DSH releases.

## W12-T1 — Medium: prepending bypasses the spill policy's final-shape accounting

Evidence:

1. W11 §3 registers `parent.ctx.on('tools/post-execute', listener, { prepend: true })` immediately before starting each job. It awaits `next()` and then changes one text block into two.
2. Cordis `src/events.ts:236–269` composes listeners outermost-first; `prepend` inserts at the front. Therefore this newly registered listener wraps the already-mounted stock spill listener.
3. `dsh-spill-policy/lib/index.js:237–255` also uses a prepended wrapper. After its own `next()`, it prices `decision.content ?? result.content`; when that content fits, it returns the unchanged decision. In W11's order, it sees the **single** stock text block, not the later split.
4. `dsh-token-meter/lib/types/estimate.js:9–11,34–41` prices every text block as `ceil(text.length / 4) + 4`. W11's status suffix has 36 characters. Thus, for selected JSON length L:

   ```text
   one block:  ceil((L + 36) / 4) + 4 = ceil(L / 4) + 13
   two blocks: ceil(L / 4) + 4 + 9 + 4 = ceil(L / 4) + 17
   ```

   Splitting adds **exactly four estimated tokens** under the actual stock policy, despite preserving the concatenated text.
5. Base `cordis.patch.yml:414–417` sets `maxInlineTokens: 12500`. The Jobs finalizer then preserves the two-block result (`dsh-tool-jobs/lib/index.js:278–292`); it does not re-run spill policy.

**[INFERENCE, source-derived counterexample; not executed]** A selected ASCII full JSON string of length 49,948 with `C = 49,948` fits the serializer's full-result threshold. Its framed length is 49,984, so W11 splits. The inner spill policy accepts the single block at exactly 12,500 tokens; the resulting two blocks cost 12,504. The same boundary exists for smaller custom spill limits and compact summaries. This is not an arbitrary-policy hypothetical: the installed stock estimator and wrapper order establish the gap.

The user's mandatory-summary floor authorizes exceeding the producer's tiny Jobs cap, including the necessary framing/encoding allowance. It does **not** authorize adding content-shape cost after an independent Host budget has accepted another shape. W11 §4's UTF-8 payload bound remains correct, but it cannot establish that separate token policy's authority.

### Minimal supported correction

**Register the owner-lived adapter without `prepend`**, still immediately before `jobs.start()`:

```ts
parent.ctx.on('tools/post-execute', listener)
```

Keep the exact-owner/job gates, `await next()` exactly once, and preservation of block/own-value/own-content decisions. Existing Host policy wrappers now enclose the newly appended adapter:

```text
stock rendering
  → Host wrappers enter
    → exact-job adapter awaits its continuation and proposes two blocks
  → Host wrappers inspect/replace the proposed content on unwind
  → original-caller cancellation normalization
  → Jobs finalizer
  → frozen result / native session content
```

The stock spill wrapper reads `decision.content`, so it now prices the actual two-block presentation. If it spills, let its replacement win even if the Jobs finalizer subsequently caps that replacement. Do not restore JSON over that result, reserve four guessed tokens by reading another plugin's config, exempt `job_output`, re-run policies, or install ordering watchers.

For custom Hosts, a composing retention/redaction wrapper must evaluate `decision.content ?? result.content` and preserve/replace the returned decision. Explicit replacement, block, throw, or a policy that discards the continuation's decision remains authoritative. A later non-prepended custom policy can be inside this adapter; this hook is not a universal last-policy guarantee. Do not claim lossless JSON under arbitrary policy ordering or policy-authored projections. The corrected order covers the stock prepended spill policy, including its reload, without requiring a new Host API.

## Other reviewed contracts: pass

### Supported content seam and exact shape

- `dsh-tools/lib/types/contracts.d.ts:337–355` expressly permits an accepting `content` replacement. `events.d.ts:29–48` separates that policy hook from frozen `tools/result` observation.
- `pipeline.js:277–336,421–457` applies projection, post-execute policy, original-caller cancellation, then the snapshotted definition-owned finalizer. Block/error and cancellation remain authoritative. A thrown policy is normalized as an error, not replaced with successful JSON.
- `dsh-tool-jobs/README.md:89–91` explicitly preserves structured multi-block policy results. Its `rawSingleText()` and finalizer (`lib/index.js:209–221,278–292`) implement that contract. Complete JSON plus the real status suffix are two substantive blocks, not an empty sentinel. This is a supported producer-specific presentation policy, not a private-registry trick.
- Stock output is `{ text, job }`, rendered as text plus status (`lib/index.js:244–250,392–412`). Require exact selected text, exact owner and job ID, kind `autoresearch`, completed status, matching success detail, and the unchanged one-block rendering before proposing the split. Never parse/reconstruct a policy replacement or replay a stored result over empty text.
- Native execution uses the shared pipeline (`dsh-tool-executor-native/lib/index.js:8–16`); the durable native message uses `result.content` (`dsh-tools/lib/types/batch.js:214–230`, `dsh-llm/lib/types/message.js:92–99`). Testing only `value.text` is insufficient.

### Registration, cancellation, and retained-job lifetime

- `JobSpec.outputLimitBytes` is captured at start; neither outcome nor handle supplies a setter (`dsh-jobs/lib/types/types.d.ts:62–77,128–200`; `dsh-jobs-local/lib/index.js:412–449,769–775`). Keep `outputLimitBytes: C`. No admission, cap updater, mutable registry projection, or prepare-before-start path.
- Keep the current sequence in `src/index.ts:149–239`: jobs-injected non-consuming settlement observer, presentation registration, synchronous job start/ID assignment, controller prepare, gate release. Fill the success cell before returning the ordinary completed outcome. Existing producer `finally` still drains controller disposal before settlement. If disposal instead rejects, the job becomes failed; the adapter's completed-result guards refuse it.
- `Agent.ctx` owns agent-local contributions and unwinds them on disposal (`dsh-agent/lib/types/runtime-types.d.ts:175–176`). Cordis `ctx.on()` owns its effect on that fiber (`src/events.ts:263–306`). `dsh-scope/lib/index.js:315–335` permits ancestor listeners to receive descendant calls, so exact Agent identity remains required.
- An owner-lived presentation listener is correct; a producer-owned or settlement-observer-owned listener is not. The latter observer is disposed immediately after registry settlement (`src/index.ts:225`), before later collection. Producer disable/HMR must leave the retained completed job presentable.
- Jobs explicitly retains handed-out terminal records until owner/service disposal (`dsh-jobs/lib/types/index.d.ts:27–42,129–137`). `readJob()` marks delivery without clearing `job.result`; owner cleanup drains and drops records (`dsh-jobs-local/lib/index.js:631–641,802–839`). One small listener/cell per handed-out job therefore follows the existing retention model; it is not a fixed job-count memory bound. An exceptional explicit removal can leave an inert cell until owner disposal, without enabling another successful stock read. No new removal subscription or cache service is required for this scope.
- Dispose the presentation registration if no job registered. Once registered, do not attach its release to `activeJobs` or producer HMR. Put closure creation in a small helper so it captures only owner, job/presentation state and C—not controller, full result, producer config, or startup machinery. Use Cordis's actual disposer type, not the illustrative boolean-return annotation.
- Completion notices can hold an already consumed registry result (`dsh-tool-jobs/lib/index.js:322–344,445–452`). Guard the actual tool value, not a second registry read. Committed inline notices and subsequent empty reads retain existing single-consumer semantics; the cell must never become a replay cache. Jobs-plugin reload losing held reads is unchanged.

### Serializer and bound

Approve W11 §2 unchanged: exact full JSON when its UTF-16 length fits C; otherwise exact status/runId/tracker/best/counts/applicable target plus `detailsOmitted: true`. No abbreviation, slicing, truthiness checks, canonical decoder changes, or mandatory-summary admission. Keep all failed/killed/startup and foreground/durable mappings.

For mandatory compact length S, selected text T and suffix F, `T.length <= max(C,S)` and `utf8(T) + utf8(F) <= 3*max(C,S) + 36`. Use actual byte lengths to decide whether to split; the subtraction comparison avoids unsafe arithmetic near `MAX_SAFE_INTEGER`. This bounds the selected presentation payload, not independent Host policy output or provider wire/token cost. Preserve the original single block whenever it fits the Jobs cap.

## Necessary focused acceptance proof

These are implementation obligations, not tests run by this reviewer. Keep real production proof separate from small policy/serializer fixtures; do not execute 100 rounds to manufacture size.

| Boundary | Required observable proof |
| --- | --- |
| Serializer | C=1, compact-length neighbors, exact full-length threshold, and ample C; required fields exact, details omitted only when needed, input/canonical result unchanged. Reuse the large artifact fixture in `tests/contracts.spec.ts:101–119`. Cover metric/target zero, all counts, negative/exponent metrics, escaped/BMP/astral identities, a long accepted identity, and safe arithmetic near `MAX_SAFE_INTEGER`. |
| Actual stock success | Real accepted candidate with C=1, subscribed non-consuming settlement, then owner's real `job_output`. Assert the entire `content` array: complete parseable JSON first block, exact completed/budget-limited suffix second, no truncation marker, exact durable best/counts/identity. Keep stock spill and default notice behavior enabled. Also cover baseline target-reached with metric/target zero and counts `0/0/1`. |
| Byte/framing boundary | A full result fitting C characters but not C framed UTF-8 bytes takes the two-block path without losing full fields. Assert concatenation equals the exact stock rendering and actual total payload bytes. An ample-cap result retains the original single block. |
| **W12-T1 regression** | Through the supported pipeline with the real spill policy/backend, choose its token limit so the one-block rendering fits but the two-block rendering exceeds it. Require spilling of the proposed two-block content, stored complete text, and no summary restoration over the policy result. This must catch W11's prepended order. A small deterministic Jobs/presentation fixture is sufficient; it does not replace production success coverage. |
| Mixed Host policies | Accepted pass-through/context enrichment preserves the adapter and contexts. Block, own content/redaction, own value (even equal-looking), throw, and cancellation while `next()` is pending never receive an unauthorized summary. Cover an enclosing policy seeing the proposed content and an inner explicit replacement surviving the adapter. Use actual pipeline final output, not just callback returns. |
| Lifetime and isolation | Settle success, await producer disable/HMR, then collect through the surviving owner. Two retained jobs keep their own selected text/config cap across reload. Another producer, foreign owner/descendant, and repeat empty read receive no stored summary. No-job startup failure releases the registration; owner teardown owns the remaining effects and does not add an async disposal barrier. |
| Existing unaffected paths | Retain failed/killed/startup mappings and original single-text caps, and #21 cancellation/HMR regressions. Foreground terminal resume returns the complete canonical result with identical best/counts, no omission flag or extra attempt, and released locks. |

Reuse `composeHarness`, `executeTool`, and `observeJobSettlement` (`tests/fixtures/harness-composition.ts:40–60,113–223`) and the existing accepted-candidate scenario (`tests/release-scenarios.integration.spec.ts:219–245,306–343`). Coordinate rebuilding `lib/` with the #21 worker before real Loader tests; do not overlap builds/pack or modify its active evaluator/tests for this review.

## Coordinator disposition

Replace W11's prepend requirement and policy-order proof with the correction above, and carry the explicit Host-policy boundary into AC2. Then the serializer plus small owner-lived adapter is an implementable #22 slice. **No remaining need for strict admission, fixed oversized allowance, registry mutation, dependency upgrade, upstream API work, or additional PR.** Exactly two stacked PRs and the existing #21 ownership remain unchanged. Keep W12-T1 open until the plan adopts the correction; close it on the focused spill-order and stock-content evidence during implementation review.
