# W11 — successful background-result transport

## Revision and recommendation

Design revision **W11-T1**, for independent W12 review. This report changes no approval or implementation status. The coordinator owns the ledger and plan.

**Revision pointer:** [ledger D5](issues-21-22-ledger.md#decision-log) records the user's `mandatory_summary_floor` choice. It supersedes the strict background admission recommendation in [original design §4.2](issues-21-22-design.md#42-minimum-limit-conflict-recommendation-for-coordinator-decision), its conditional admission tests, and §4.3's assumption that the configured character cap always contains the summary. Do not implement admission, a higher Config minimum, identity preflight, initialization splitting, or canonical-result size rejection. The [review's presentation contract and T1](issues-21-22-plan-review.md#22-firm-user-approved-presentation-contract) are the inputs here.

**Recommendation:** keep `JobSpec.outputLimitBytes = maxResultChars` unchanged. Serialize successful results using D5. For the exact owning job's successful `job_output`, use the public `tools/post-execute` content-replacement hook to present the complete JSON and status suffix as **two substantive text blocks**, only when their combined UTF-8 length exceeds the existing Jobs cap. DSH explicitly preserves multi-block policy content through its Jobs finalizer. All other paths continue through that finalizer unchanged.

This is a producer-specific presentation adapter, not a replacement `job_output`, a registry mutation, an output-limit setter, or a new workflow. No dependency change is needed. There is no speculative reservation for future paths or legacy identities: the adapter uses the actual serialized successful result after it exists.

**Policy boundary:** this guarantees lossless passage through the producer adapter and the installed Jobs byte finalizer when Host policies accept the ordinary successful projection unchanged. It must not override a Host denial, value replacement, content redaction, or independently configured spill decision. The installed base's spill policy is a concrete additional limit, discussed below; an unconditional guarantee against that separate limit would be a different contract, not something this mechanism secretly supplies.

## 1. Inspected supported surfaces

Static inspection of the installed DSH **0.2.2-rc.1**, scoped Cordis **4.1.0**, and repository source. References below are package-relative installed paths; `dsh-jobs-local`, `dsh-scope`, and `dsh-spill-policy` resolve under `node_modules/.pnpm/`, not necessarily the top-level `node_modules/@deepseek-ai` directory.

| Surface | Exact contract/evidence | Design consequence |
| --- | --- | --- |
| `@deepseek-ai/dsh-jobs/lib/types/types.d.ts:62–77,128–144,166–200` | `JobOutcome` supplies status/detail/result; `JobHandle` has append/progress; `JobSpec` alone has optional numeric `outputLimitBytes` | No producer-side completion-time limit setter exists. Pull sources/appends do not carry a distinct result-presentation budget. |
| `@deepseek-ai/dsh-jobs-local/lib/index.js:412–449,769–775` | Start validates a positive safe integer and copies the cap; settlement copies outcome fields, not a cap | Changing the input spec later or changing a `get()` projection is ineffective/unsupported. |
| `@deepseek-ai/dsh-tools/lib/types/events.d.ts:29–48`; `contracts.d.ts:337–355` | `tools/post-execute(exec, result, next)` may return `{ kind: 'accept', content: ContentBlock[] }`; it may alternatively replace value or block. `tools/result` is a frozen observer | Replace content only. Do not reconstruct canonical values or mutate final observations. |
| `@deepseek-ai/dsh-tools/lib/types/pipeline.js:277–336,421–457` | Project → post-execute decisions → caller-cancellation normalization → definition-owned finalizer → frozen result | A single-text replacement alone still encounters the Jobs cap. Later cancellation/error normalization remains authoritative. |
| `@deepseek-ai/dsh-tool-jobs/README.md`, “Output capping” | Explicitly: “structured multi-block policy results keep their shape” | Two real semantic blocks are a documented supported path, not a dummy-block or undocumented-field workaround. |
| `@deepseek-ai/dsh-tool-jobs/lib/index.js:209–221,278–292` | `rawSingleText()` requires exactly one text block. The finalizer preserves other shapes | The JSON block and separate real status block survive intact. Single-text errors and ordinary failed/killed reads retain existing capping. |
| Same package, `lib/index.js:244–250,407–412,445–452` | Canonical tool value is `{ text, job }`; rendering appends status; a pending completion notice may supply the held result | Guard the actual tool result, not a second consuming registry read. Preserve `value.text`. |
| `@deepseek-ai/dsh-tools/lib/types/batch.js:214–230`; native executor `lib/index.js:8–16` | Native execution uses the shared pipeline; durable tool-result messages take `result.content` | The two blocks are actual model/session content, not merely a UI presenter or intact programmatic value. |
| `@deepseek-ai/cordis/src/events.ts:263–268,294–306` | `ctx.on()` registers an effect on the calling context's fiber | Register on the calling Agent's `parent.ctx`, not the autoresearch plugin's short-lived Host fiber. |
| `@deepseek-ai/dsh-scope/lib/index.js:315–335` | Scoped listeners can also receive descendant calls | Explicit exact-Agent and exact-job checks are still required. |

`presentCall`/`presentResult` are Host/UI descriptors, not this model-content seam. `projectContent` and `finalizeContent` belong to the registered tool definition; this plugin does not own the generic `job_output` definition. Do not mutate it or add a shadow registration. No Host-level `ctx.tools.get('job_output')` is required; the real tool can remain in the Agent preset plane.

## 2. Success serialization

Put the pure successful-result serializer in the existing presentation layer; no package-root export or new canonical result type is needed.

For `budget-limited` and `target-reached`, with `C = resolved.maxResultChars`:

1. `full = JSON.stringify(result)`.
2. If `full.length <= C`, select that exact string, including artifacts, without an omission flag.
3. Otherwise select `JSON.stringify({ status, runId, tracker, best, counts, ...(status === 'target-reached' ? { target } : {}), detailsOmitted: true })`, taking every value directly from the authoritative result.
4. Return the selected string as the existing completed `JobOutcome.result`, with `detail = result.status`.

No identity abbreviation, JSON slicing, new numeric conversion, truthiness test for zero, or canonical decoding of the compact object. The compact object's `best` includes the full metric/commit/experiment identity; `counts` includes all three counts. Actual legacy identities are carried verbatim. The compact object can be larger than a tiny cap; that is the approved floor, not failure.

Leave these existing `src/index.ts` branches intact:

- `cancelled` → `killed`, canonical serialized result;
- `baseline-blocked` / `blocked` / `round-failed` → `failed`, canonical serialized result;
- owner/job cancellation after the controller returns → existing killed result and cancellation detail;
- startup/producer exceptions → existing failed/killed startup-failure result;
- foreground/controller/storage/history/TSV/terminal-resume contracts.

## 3. Exact integration, order, and ownership

### Per-background-invocation state

Keep only a small producer-private presentation cell, alongside the existing `jobId`:

```ts
// Illustrative private state, not a durable schema.
let successfulPresentation:
  | { text: string; status: 'budget-limited' | 'target-reached' }
  | undefined
let releasePresentation: (() => boolean) | undefined
```

The text is the same string assigned to `JobOutcome.result`; do not retain the full canonical result or controller in the presentation helper. Bind only the exact owner Agent, job identity accessor/cell, C, and this selected text/status. No global map, polling, `jobs.wait()`, `jobs.read()`, or tracker read is necessary.

### Registration and settlement sequence

Keep current preflight, the non-consuming settlement observer, and the controller gate/prepare sequence:

1. Existing repository preflight and owner Jobs observer activate as today.
2. Immediately before `ctx.jobs.start()`, install `parent.ctx.on('tools/post-execute', listener, { prepend: true })`. This is synchronous and does not look up or require a Host tool definition. Keep its returned disposer for the no-registration error path.
3. Call `ctx.jobs.start()` with the **unchanged** `outputLimitBytes: C` and existing synchronous producer hooks. Store the returned ID before releasing the producer gate, as today.
4. Call `controller.prepare(jobId)` only after registration; keep readiness/startup handling unchanged.
5. After `controller.run()` succeeds, and only in the ordinary completed outcome branch, assign `successfulPresentation` from the selected `JobOutcome.result` and successful run status before returning that outcome. Do not set it in failed/killed/startup paths. The producer's existing `finally` still awaits controller disposal before `done` fulfills.
6. Registry settlement and `job_output` consumption continue through DSH. The presentation cell already exists when any settled result becomes readable, including a waiting `job_output` and a completion-notice-held read.
7. If no job registered, call `releasePresentation?.()` from the existing startup failure cleanup. Once registered, the listener is **owner-lifetime**, not producer-lifetime: do not release it when the settlement-observer fiber is disposed, when `activeJobs` settles, or during producer HMR. The owner context disposes it automatically.

This intentionally retains one small listener/cell per handed-out job until the owner ends. Jobs retains those records for the same lifetime; its `readJob()` marks `resultDelivered` rather than clearing `job.result` (`dsh-jobs-local/lib/index.js:631–641`). The adapter therefore does not add an accumulating history copy or a result replay service. A manually removed record cannot yield a matching successful read, and its inert listener ends with the owner. No separate removal subscription is needed for this bounded design.

The current jobs-injected settlement observer and reverse-order teardown barrier remain unchanged. Presentation has no async teardown work and confers no authority to cancel, settle, restore Git, or release locks. A completed result stays presentable after autoresearch is disabled/reloaded while its owner and Jobs tools remain alive. Owner/Host shutdown continues to use the existing lifecycle machinery.

### Listener algorithm

Use the public `PostToolDecision` contract, not a replacement `ToolExecutionResult`:

1. For a call other than `job_output`, the wrong exact `exec.agent`, or a different `exec.arguments.job_id`, return `next()` unchanged.
2. Await `next()` **exactly once**. Preserve a thrown policy error, a block, or any decision with an own `value` or `content` property. Preserve its additional contexts. Do not overwrite policy content, even if it resembles a spill notice or the original JSON.
3. Require all of:
   - `result.isError === false`, caller not aborted, and a recorded successful presentation;
   - a well-shaped `{ text, job }` tool value;
   - `job.id` equals this invocation's registered ID, `job.kind === 'autoresearch'`, `job.status === 'completed'`, and `job.detail` equals the recorded successful run status;
   - `value.text === successfulPresentation.text`;
   - the incoming `result.content` is exactly the stock single text block `T + F`, where `T` is the selected JSON and `F = '\n[status: completed, ' + status + ']'`.
4. If the actual UTF-8 text plus suffix fits C, return the unchanged decision; the original single-block finalizer is already lossless.
5. Otherwise return the accepted decision with exactly:

```ts
return {
  ...decision, // accept with neither value nor content; keeps additionalContexts
  content: [
    { type: 'text', text: T },
    { type: 'text', text: F },
  ],
}
```

The first block is independently parseable complete JSON; the second is the real, unchanged DSH status suffix. Concatenating their text equals the stock complete rendering. Do not use an empty sentinel, an image, fabricated metadata, or a non-text block to evade capping.

No JSON parsing/re-serialization is needed in this listener: equality to the producer-selected string is both the provenance check and the bound check. Small shape checks return the unchanged decision on mismatch, rather than introducing a new read failure. An empty second read must not resurrect the stored successful text. A foreign-owner denial, a different job, or a policy-authored fake value must not get a summary from the closure.

## 4. Bound and UTF-8 proof

Let:

- `C` be the accepted positive-safe-integer `maxResultChars`;
- `S` be the UTF-16 length of the actual mandatory compact JSON for this result;
- `T` be the selected full-or-compact JSON;
- `F` be the successful status suffix above;
- `utf8(x) = Buffer.byteLength(x, 'utf8')`.

The algorithm establishes:

```text
T.length <= M = max(C, S)
F.length = utf8(F) = 36              // both successful status names have length 14
body + status bytes = utf8(T) + 36 <= 3 * M + 36
```

The last inequality is mathematical: UTF-8 uses at most three bytes per UTF-16 code unit; astral pairs use four for two units. JSON escaping is already included in `T.length` and `S`. No separately estimated path/identifier/number width enters the proof. A legacy identity of any currently accepted finite length simply contributes its actual escaped length to S.

**Do not calculate `3*C + 36` as a JavaScript registration value.** No such value is registered. Test whether splitting is required using actual byte lengths, e.g. `utf8(T) > C - utf8(F)`, so even `C = Number.MAX_SAFE_INTEGER` has no unsafe multiply/add intermediate. Tests can express the conservative mathematical inequality with `BigInt` if needed; no enormous allocation is necessary.

This is a finite, data-derived presentation floor, not a fixed universal ceiling independent of required identities. That distinction is inherent in D5. It also avoids a fake large constant masquerading as a bound. The measured surface is the sum of the text-block UTF-8 payloads, the same surface the Jobs finalizer measures, including the status suffix; provider wire JSON envelopes/token accounting are not the Jobs byte budget.

All nonselected surfaces retain the original C-byte Jobs behavior: failed/killed reads, running/empty reads, `job_kill`, known-job single-text tool errors, and completion notices. The proposal does not make failure output valid JSON or change its truncation markers. Full canonical failure strings remain in `value.text` just as before.

Completion notices remain generic and C-bounded. A tiny cap can therefore still abbreviate a notice. The complete successful result is retrieved by the existing `job_output(job_id)` route; the adapter neither expands notices nor consumes their held results early. If an inline notice was already committed to the model, a later empty `job_output` remains empty as DSH specifies.

## 5. Focused implementation proof required

No test/build/runtime probe was run for W11. These are implementation/W12 obligations, not green evidence. Rebuild generated `lib/` before real Loader composition, coordinated with the #21 worker; do not run overlapping builds or pack operations.

| Test boundary | Observable assertion |
| --- | --- |
| Pure serializer: C=1; just below/equal/above compact length; exact full-result threshold | Complete required JSON at every cap; exact full JSON when it fits; otherwise only mandatory summary plus `detailsOmitted: true`. No new admission or canonical decoder rejection. |
| Existing large in-memory artifact fixture | Full result exceeds C; compact fields equal the authoritative original; artifacts omitted only from presentation; input unchanged. No 100-round execution. |
| Numeric/identity edges | Metric zero, negative/exponent numbers, target zero, counts `0/0/1`, safe-integer-width counts; quotes/backslashes/BMP/astral text; a legacy-style experiment identity longer than generated IDs. Exact values survive without a fixed-size assumption. C near MAX_SAFE_INTEGER exercises arithmetic without allocating that many bytes. |
| Real accepted candidate, C=1, actual DSH `job_output` | Subscribe to settlement before start. Run production autoresearch, await the non-consuming terminal event, collect through the real owner tool. JSON body retains exact runId/tracker/best/counts, completed/budget-limited status and omission flag; no output/result-truncated marker. Assert actual `content`, not merely `value.text`. |
| Real baseline target success | Retains `target` and best metric zero with counts `0/0/1`; suffix is completed/target-reached; no candidate needed. |
| Real ample-cap successful output | `value.text` equals full canonical JSON including artifacts. If its framed UTF-8 fits C, original single text block stays unchanged. |
| Framing/encoding boundary | Full JSON can fit C UTF-16 units while UTF-8 plus suffix does not. Two text blocks preserve the entire body. Sum actual bytes, assert `utf8(T)+36`, and concatenate to the exact ordinary rendered text. Include non-ASCII/escaped paths. |
| Pending notice has consumed the registry result | Real `job_output` obtains the held text and passes the same bound/identity/content checks. Do not read Jobs directly first. Retain default delivery behavior; no artificial result-cache replacement. |
| Successful settlement then producer disable/HMR before collection | Owner still collects the full compact body. The existing settlement observer can already be disposed; the presentation listener must not depend on it or the reloaded config. |
| Two jobs / owner isolation / repeat read | Each job uses its own text and cap; foreign read remains denied; another producer is unchanged; second empty read does not replay the summary. |
| Existing failed/killed/startup/teardown cases | Same mappings and canonical values; same original single-text capped rendering, including at tiny caps. Retain #21 cancellation/HMR evidence; do not redesign failure summaries. |
| Policy and cancellation precedence | Block, own content replacement, own value replacement, throwing policy, and caller abort are not replaced with successful JSON. Existing finalizer/cancellation behavior wins. |
| Foreground terminal resume | Complete canonical result, identical best/counts, no omission marker, no new evaluator attempt; terminal locks remain released. No tracker migration or manufactured rows. |

Use the existing `composeHarness`, `executeTool`, and `observeJobSettlement` fixtures. The actual native `content` assertion should cover the whole array and concatenate text only for the exact JSON-plus-status equality. Do not incorrectly parse the entire framed message as JSON. The first block alone is valid JSON on the protected path. With a single block, strip/assert the exact suffix separately.

## 6. Risks and review boundary

1. **Documented multi-block contract dependency.** Installed DSH preserves multi-block policy content; a future finalizer that flattens/caps it would break the floor. The real-tool content regression must detect that. Do not treat a passing serializer or intact `value.text` as transport proof.
2. **Independent Host policies remain authoritative.** Base `cordis.patch.yml:414–417` mounts `dsh-spill-policy` with `maxInlineTokens: 12500`. That policy prepends a `tools/post-execute` wrapper and may replace even valid text with a head/tail preview (`dsh-spill-policy/lib/index.js:237–255`). It has no current per-tool exemption; its README calls that deferred. The proposed listener delegates and preserves that explicit content replacement. The real Host tests must establish that their compact summaries fit this separate default; there is no proof that every arbitrarily long accepted identity does. Consequently, neither this proposal nor an upfront Jobs byte reservation can promise unconditional complete JSON under every Host spill/redaction configuration. W12 must distinguish **producer/Jobs transport completeness** from **overriding separate Host policies**. If the latter is intended, this report does not claim it solved: obtaining that authority is coordinator-owned and must not be hidden in an `accept`-content override.
3. **Lifecycle ownership matters.** A plugin-owned listener or the existing short-lived observer would disappear before a retained job can be collected. Use `parent.ctx.on` and an exact Agent check. No Host-wide hook affecting other producers, cross-fiber finalizer wrapping, or `tools/change` watcher.
4. **No new delivery guarantees.** Existing single-consumer semantics, Jobs-plugin HMR losing held notices, committed inline notice consumption, and tiny-cap notice abbreviation remain unchanged. Only producer HMR must retain this presentation support while the owner remains alive.
5. **No streaming assumption.** Autoresearch currently supplies only final result text, no output sources/appends. Exact-text and stock-render guards deliberately refuse to reinterpret future mixed stream/result output; such a producer change would need an explicit presentation-contract update.

## 7. Rejected integration paths

- **Dynamic limit update:** absent from the supported API; registry copies the number before the result exists.
- **Fixed 512/4096/64 KiB/etc. floor or OS-path estimate:** does not prove arbitrary normalized durable/legacy identity sizes. A registration bound also cannot defeat independent Host spill policies.
- **Omit the producer cap:** leaves failed/killed/error/notice paths unbounded unless redesigned; not in scope.
- **Split the result across output sources/appends:** Jobs recombines the read before applying its cap; adds ring/consumption hazards without solving finalization.
- **Single-text post-execute rewrite:** Jobs finalizer still truncates it after this hook.
- **UI-only presenter or `tools/result` rewrite:** wrong surface or frozen observation.
- **Mutate/shadow the generic tool definition, override redaction/spill decisions, add a wrapper tool, or prepare before registration:** unnecessary ownership/policy/lifecycle changes outside this design.

**Recommended implementation slice:** successful serializer plus this narrowly scoped owner-lifetime content adapter in the existing presentation/index layer, focused tests, and coordinator-owned documentation updates. No source/test/doc edits other than this report were made by W11; no commands executing tests, builds, browsers, or Git/GitHub operations were run. W12 decides whether the explicit Host-policy boundary matches AC2 before W5 begins.
