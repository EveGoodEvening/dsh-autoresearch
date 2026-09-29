# dsh-autoresearch

Bounded, metric-driven optimization for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness), inspired by [Karpathy's autoresearch](https://github.com/karpathy/autoresearch).

The `autoresearch` tool measures a baseline, lets an agent edit allowed files in an isolated Git worktree, and keeps only strict improvements. The Host controls evaluation; SQLite records results for inspection and recovery.

## Supported versions

For **`dsh-autoresearch@0.2.1`**:

| Component | Supported | Tested |
| --- | --- | --- |
| DSH CLI (`@deepseek-ai/dsh`) and DSH service peers | **`0.2.0-rc.2`** (exact, coordinated family) | `0.2.0-rc.2` |
| Cordis (`@deepseek-ai/cordis`) | **`~4.0.4`** | `4.0.4` |
| Node.js | `^22.19.0 \|\| >=24.2.0` | `24.21.0` |

Verified on **2026-09-29**. Use the **scoped Cordis fork**, not unscoped `cordis`. DSH is a prerelease pairing; other DSH versions are not declared supported. Daily [upstream compatibility checks](https://github.com/EveGoodEvening/dsh-autoresearch/blob/master/.github/workflows/compatibility.yml) do not automatically expand these ranges.

## Install

```sh
dsh plugin --profile <name> add dsh-autoresearch@0.2.1
dsh --profile <name> --dump-config
```

The dump should contain `id: autoresearch` and `name: dsh-autoresearch`. Use `dsh plugin`, not plain `pnpm add`, to activate the bundle.

The Host needs `agents`, `jobs`, `subprocess`, `systemPrompt`, and `tools`. Background runs also need `dsh-tool-jobs` in the calling Agent; the Web `standard` preset and base/headless compositions provide it.

## Use

**Register an evaluator first.** Set `evaluatorRegistrations` in the plugin's Host configuration; none are supplied by default. Each registration fixes the command/argv, metric, environment, evaluator files, and dataset identity. See the [configuration schema](https://github.com/EveGoodEvening/dsh-autoresearch/blob/master/src/config.ts) and [shipped defaults](cordis.patch.yml).

Then ask the agent to run `autoresearch`. For example, with a registered `validation-loss` evaluator and `train.py` in the repository:

```json
{
  "objective": "Reduce validation loss",
  "run_tag": "loss-trial-1",
  "evaluator_id": "validation-loss",
  "mutable_globs": ["train.py"],
  "max_experiments": 20
}
```

- `repository` defaults to the agent's working directory. Use a fresh, Git-safe `run_tag` for each new run.
- Runs are background jobs by default. Inspect or stop them with `job_list`, `job_output`, and `job_kill`; use `"mode": "foreground"` to wait for completion.
- Optional inputs: `target` (stopping threshold), `timeout_ms` (per-attempt watchdog), and `constraints` (advisory guidance, not acceptance rules).
- To resume, replace `run_tag` and `evaluator_id` with `resume_run_id` and retain the original run policy. The stored evaluator registration is revalidated before execution.

Defaults: **20 candidates**, deployment cap **100**, **15-minute watchdog per attempt**, and **one active run per repository**. The baseline is separate from the candidate cap. Limits and retention are configurable.

## Behavior and safety

- **Baseline first; strict keep/reject.** One scalar metric, minimized or maximized. Only improvements over the current best are accepted.
- **Narrow edits.** Only `mutable_globs` may change; registered evaluator and local dataset files remain protected.
- **Bounded execution.** Safely terminated candidate evaluator failures consume a candidate slot and may continue. Baseline failures or uncertain process/policy state stop or block the run.
- **Durable recovery.** SQLite preserves decisions and evidence. Resume fails closed on registration or provenance mismatch; legacy runs without Host registrations cannot resume.
- **Not a security sandbox.** A Git worktree isolates repository changes, not hostile code. Use trusted evaluators/candidates or separately provide an external sandbox. The watchdog is not a fair-compute budget.
- **Crash takeover requires Linux.** Reclaiming a stale controller after abnormal Host death needs `/proc` evidence; non-Linux recovery remains conservatively blocked.

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
