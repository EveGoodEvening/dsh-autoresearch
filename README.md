# dsh-autoresearch

Bounded, metric-driven optimization for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness), inspired by [Karpathy's autoresearch](https://github.com/karpathy/autoresearch).

The `autoresearch` tool measures a baseline, lets an agent edit allowed files in an isolated Git worktree, and keeps only strict improvements. The Host controls evaluation; SQLite records results for inspection and recovery.

## Supported versions

For **`dsh-autoresearch@0.2.2`**:

| Component | Supported | Tested |
| --- | --- | --- |
| DSH CLI (`@deepseek-ai/dsh`) and DSH service peers | **`0.2.0-rc.2`** (exact, coordinated family) | `0.2.0-rc.2` |
| Cordis (`@deepseek-ai/cordis`) | **`~4.0.4`** | `4.0.4` |
| Node.js | `^22.19.0 \|\| >=24.2.0` | `24.21.0` |

Tested pairing observed on **2026-09-30**. Use the **scoped Cordis fork**, not unscoped `cordis`. DSH is a prerelease pairing; other DSH versions are not declared supported. Daily [upstream compatibility checks](https://github.com/EveGoodEvening/dsh-autoresearch/blob/master/.github/workflows/compatibility.yml) do not automatically expand these ranges.

## Install

```sh
dsh plugin --profile <name> add dsh-autoresearch@0.2.2
dsh --profile <name> --dump-config
```

The dump should contain `id: autoresearch` and `name: dsh-autoresearch`. Use `dsh plugin`, not plain `pnpm add`, to activate the bundle.

The Host needs `agents`, `jobs`, `subprocess`, `systemPrompt`, and `tools`. Background runs also need `dsh-tool-jobs` in the calling Agent; the Web `standard` preset and base/headless compositions provide it.

## Use

**Register an evaluator first.** The Host-owned `evaluatorRegistrations` registry is intentionally empty by default: the agent cannot choose an arbitrary evaluator command. Here is a complete toy setup; the Host evaluator computes the distance to 3, rather than trusting a model-reported score. It demonstrates the protocol, not scientific effectiveness.

In a clean, trusted Git repository, create and commit these two files at the repository root:

### `judge.mjs`

```js
import { readFileSync } from 'node:fs'

const { value } = JSON.parse(readFileSync('candidate.json', 'utf8'))
if (typeof value !== 'number' || !Number.isFinite(value)) {
  throw new TypeError('value must be a finite number')
}
const distance = Math.abs(value - 3)
if (!Number.isFinite(distance)) throw new RangeError('distance must be finite')
console.log(JSON.stringify({ distance }))
```

### `candidate.json`

```json
{ "value": 10 }
```

### `cordis.patch.yml`

After installing the plugin, put this override in the chosen profile's `$DSH_HOME/profiles/<name>/cordis.patch.yml` (merge it into any existing patch list):

```yaml
- id: autoresearch
  name: dsh-autoresearch
  config:
    defaultMaxExperiments: 20
    defaultTimeoutMs: 900000
    evaluatorRegistrations:
      - id: toy-distance
        command: node
        args: [judge.mjs]
        metricName: distance
        metricDirection: minimize
        metricParserVersion: final-line-json-v1
        evaluatorFiles: [judge.mjs]
        dataset: { kind: none }
```

Profile overrides replace the **whole row config**, not a deep merge. This minimal row retains the required run defaults; the [Config schema](https://github.com/EveGoodEvening/dsh-autoresearch/blob/master/src/config.ts) materializes omitted deployment defaults from the [shipped patch](cordis.patch.yml). Retain any existing deployment overrides, model-routing settings and evaluator registrations when replacing the row. Restart the profile and inspect `dsh --profile <name> --dump-config` before use.

`node` must be available to the Host. The evaluator runs shell-free with fixed argv; omitting `cwd` selects the isolated evaluation worktree root. It must exit successfully and end stdout with a JSON object containing **exactly one key**, the registered metric name, with a finite numeric value: this baseline ends with `{"distance":7}`. Earlier stdout may contain logs; do not add trailing blank lines. `judge.mjs` is protected against candidate edits. This example explicitly uses no dataset; the schema also supports protected local dataset files or an externally identified dataset.

### Call `autoresearch`

From that repository, ask the agent to call:

```json
{
  "objective": "Reduce the Host-measured distance to 3 by editing candidate.json",
  "run_tag": "toy-distance-1",
  "evaluator_id": "toy-distance",
  "mutable_globs": ["candidate.json"],
  "max_experiments": 5
}
```

- `repository` defaults to the agent's working directory. Use a fresh, Git-safe `run_tag` for each new run.
- Runs are background jobs by default. Inspect or stop them with `job_list`, `job_output`, and `job_kill`; use `"mode": "foreground"` to wait for completion.
- Cancellation waits for evaluator cleanup, reconciles the accepted Git state, and releases the run lock only after durable terminal settlement.
- Plugin unload or hot reload cancels active runs and waits for proposal children and jobs to settle.
- Optional inputs: `target` (stopping threshold), `timeout_ms` (per-attempt watchdog), and `constraints` (advisory guidance, not acceptance rules).
- To resume, replace `run_tag` and `evaluator_id` with `resume_run_id` and retain the original run policy. The stored evaluator registration is revalidated before execution.

Defaults: **20 candidates**, deployment cap **100**, **15-minute evaluator watchdog per attempt** (Host cap **60 minutes**), and **one active run per repository**. The baseline is separate from the candidate cap. Git has independent Host-only limits: `gitTimeoutMs` defaults to **900000** (integer range **1–2147483647**); `gitMaxStdoutBytes` and `gitMaxStderrBytes` each default to **1048576**, independently of evaluator output caps. See [Config](https://github.com/EveGoodEvening/dsh-autoresearch/blob/master/src/config.ts) for deployment limits and retention.

## Behavior and safety

- **Bounded scalar search.** Baseline first; one minimized or maximized scalar, strict improvement only. `constraints` and approval guidance are advisory, not acceptance rules or permission grants. Hard human approval must be enforced by Host policy. This does not establish scientific efficacy or fair resource allocation.
- **Narrow changes, bounded provenance.** Only `mutable_globs` may change; declared evaluator/local dataset files are read-only to candidates. SQLite records decisions and bounded evaluator/dataset/policy evidence; resume revalidates it and fails closed on mismatch or legacy registrations. This is not a complete runtime-image identity.
- **Managed execution, not confinement.** Evaluation uses `ctx.subprocess` for fixed shell-free argv/environment, bounded stdout/stderr collection, a per-attempt watchdog, cancellation/termination and process-tree quiescence checks before continuation. Completion waits for managed cleanup; a watchdog is not a compute budget. A Git worktree and this lifecycle do **not** confine filesystem access, other processes, network, privileges or hostile same-UID interference. Use trusted code; hostile-code support requires an external isolation provider and an explicit Host/product decision, not this plugin alone.
- **Fail closed when uncertain.** Proposal/report/policy errors are terminal; safely quiescent candidate evaluator failures consume a slot and may continue. Baseline failures stop; uncertain process state blocks recovery/continuation. Crash takeover after abnormal Host death requires Linux `/proc` evidence; other platforms remain conservatively blocked.
- **Public metadata is not secret.** Metric name/direction/parser, evaluator ID and generated workspace/branch/commit identity are intentionally disclosed to proposal children; never put credentials there. Raw evaluator argv/environment mappings are not forwarded. Exact known-value redaction of permitted untrusted display/history data is limited, not universal confidentiality.

## Development

Use **pnpm 11.7.0**. Build before testing: integration tests load `lib/`.

```sh
pnpm install --frozen-lockfile
pnpm run typecheck
pnpm run build
pnpm run test
pnpm run release:smoke
```

`release:smoke` checks a packed install and the real DSH Web profile outside the checkout. Run it after tests, not concurrently: packing rebuilds `lib/`.

For local installation, build and run `dsh plugin --profile <name> add .`. Releases use the [publish workflow](https://github.com/EveGoodEvening/dsh-autoresearch/blob/master/.github/workflows/publish.yml) with npm Trusted Publishing and a matching `v<package-version>` tag.

## License

[MIT](LICENSE) © 2026 EveGoodEvening
