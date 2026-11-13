# Issues 21–22: baseline investigation

## Reported baseline — accepted, not rerun

Coordinator reports unchanged implementation at `75ecd4b` (subsequent planning commits only): gated `COREPACK_DEFAULT_TO_LATEST=0 corepack pnpm` build/typecheck passed; coverage finished with 674 passed, 10 skipped, one failed. Failure: `tests/release.spec.ts` → `scripts/release-scenarios.mjs` → nested Vitest, first case at `tests/release-scenarios.integration.spec.ts:138`, 45,000 ms timeout. Other nine nested cases passed; nested duration 342.8 s, full suite approximately 496 s.

This investigation ran no build, tests, fixture, package install, or controller. Only this requested note was written; no implementation, ledger, or PR changes.

## Source evidence

- `vitest.config.ts:4-7` includes every `tests/**/*.spec.ts` without worker/file-parallelism limits. Installed Vitest is `4.1.12`; its `dist/chunks/cli-api.B0Pz1_R7.js:3832-3837` defaults non-watch workers to available CPUs minus one. Current `os.availableParallelism()` is 8: absent overrides, seven outer workers are possible, not proof of the baseline's actual active-worker count.
- `tests/release.spec.ts:32-53` launches a separate Node process and allows 500,000 ms. `scripts/release-scenarios.mjs:15-18,60-75` starts another Vitest process, with inherited environment, only the integration file selected, and no worker flags. Outer CLI flags do not propagate to this nested invocation. Installed Vitest explicitly honors inherited `VITEST_MAX_WORKERS` (`dist/chunks/coverage.DM_a_rWm.js:380`). The nested invocation does **not** pass `--coverage`; do not describe it as a second coverage suite.
- Ordinary outer discovery skips the ten integration cases unless `DSH_AUTORESEARCH_INSTALLED_ROOT` is set (`tests/release-scenarios.integration.spec.ts:15-18`). The wrapper enables them in the child. There are not two active copies by default, but the nested file can overlap other outer test files.
- The 45-second first case covers **Host boot, repository creation, prepare, baseline/candidate execution, controller disposal, owner disposal, and Host cleanup**, not just `prepare()` (`:138-217`). Its inline evaluator reads a scalar and exits; it is not the later held-descendant fixture. The test creates its own non-aborted controller signal, not a Vitest timeout-bound signal.
- The first case stores `evidence.prepareBarrier` at `:205`; the final case checks every evidence entry, including that one (`:458-460`). **[INFERENCE]** Given the reported nine other passes, this final writer passed, so the first case reached its successful evidence assignment. It may have exceeded the deadline during cleanup, or continued after timeout and eventually succeeded. The report alone cannot identify the stalled await or prove `prepare()` hung.
- Work is subprocess-heavy: the first case itself issues 15 synchronous Git commands across repository setup and snapshots. Production `runGit()` spawns through DSH and awaits both direct completion and tree exit (`src/git.ts:54-85`). Repeated config/lineage/tree checks issue further commands; for example `requireWorktreeMatches()` uses five commands, plus one when ignored files exist (`src/git.ts:619-632`). The repository's historical 236-managed-call / approximately 28-second accepted lifecycle was on DSH `0.2.0-rc.2`, **not a measured count or timing for this baseline**.
- Current DSH `0.2.2-rc.1` chooses native Linux scope or detached-process fallback per launch (`dsh-subprocess-local/lib/index.js:1547-1561`). Native scope launches include `systemd-run` and a runner bootstrap (`:563-578`); fallback directly spawns the target (`runner-launch-B2zsQ1Dz.js:1020-1042`). No baseline provider-selection trace was supplied; per-command bootstrap overhead is conditional, not established.

## Later environment snapshot — not baseline telemetry

At investigation time: 8 available CPUs; load averages 12.38 / 11.56 / 9.90; CPU pressure `some avg10=20.82`; approximately 7.9 GiB available memory, no swap, zero current memory-pressure averages. One heavy-gate slot held an unrelated browser job, the other free. `/tmp` was tmpfs with 5.8 GiB free. These observations establish contemporaneous contention, **not** baseline CPU starvation, OOM, or disk exhaustion. The gate sets memory/swap bounds; it neither serializes Vitest workers nor reserves CPU.

No inherited `DSH_*`, `VITEST_MAX_WORKERS`, `NODE_OPTIONS`, `NODE_PATH`, or `NODE_V8_COVERAGE` was observed; `CI=true`. Node was `24.22.3`, Corepack `0.36.0`. These are current observations, not a reconstructed launch environment.

### Temporary-package contamination

The known historical `/tmp/node_modules/dsh-autoresearch` shadowing incident is relevant to copied Host installations: DSH resolves bundles from the Host install anchor **before** the profile (`dsh-app-boot/lib/index.js:1774-1779`). A unique temporary subdirectory alone cannot defeat ancestor resolution.

Currently `/tmp/node_modules` is absent. `/node_modules` exists, but no `dsh-autoresearch` or `@deepseek-ai` entry was found there. The checkout's DSH boot anchor resolves inside this checkout's pnpm store; a read-only `createRequire(anchor).resolve('dsh-autoresearch/package.json')` returned `MODULE_NOT_FOUND`, allowing normal profile fallback rather than identifying a shadow package. `composeHarness()` creates a private profile and links this package there (`tests/fixtures/harness-composition.ts:113-156`). **No current contamination was demonstrated.** For a copied release workspace, inspect its own Host anchor; changing `TMPDIR` alone does not relocate that anchor. Never remove somebody else's ancestor installation.

## Hypotheses and next verification

1. **[INFERENCE, strongest]** Outer parallel work plus machine contention can exhaust the first lifecycle's 45-second wall-clock allowance. First-case cold Host imports and repeated process launches can add latency. This fits the isolated timeout and subsequent evidence success, but is not root-cause proof.
2. **[INFERENCE]** Slow teardown, or work continuing after Vitest timeout, could explain the same report. Timeout location is unresolved; do not label this an evaluator-watchdog regression or change functional code from this evidence alone.
3. Historical package shadowing remains a preflight risk for copied installations, not the leading explanation for one timed-out case with nine subsequent passes.

At the coordinator's **next verification boundary**, use the unchanged complete release wrapper, not a first-case filter or retries. Reserve both heavy slots to avoid another gated heavyweight overlapping; do not stop unrelated jobs. A private temp root under an inspected clean ancestor isolates fixture paths:

```sh
free -m
~/.omp/bin/heavy-gate --status
verification_tmp=$(mktemp -d "$HOME/dsh-baseline-tmp.XXXXXX")
~/.omp/bin/heavy-gate -n 2 -- env \
  COREPACK_DEFAULT_TO_LATEST=0 VITEST_MAX_WORKERS=1 TMPDIR="$verification_tmp" \
  corepack pnpm exec vitest run tests/release.spec.ts \
  --maxWorkers=1 --no-file-parallelism --reporter=verbose
```

Run the finite gated command with tool settings `async:true, timeout:0`, never a shell `timeout` wrapper. Preserve output/durations and any owned failure artifacts before removing the private directory. The inherited worker environment constrains the nested runner too. Keep provider selection, isolation, 45/125/500-second deadlines, all assertions, and process-tree cleanup unchanged; do not run `pack` concurrently or disable acceptance criteria.

A narrow pass establishes the release contract in this controlled environment, not full-suite coverage or causation. When the planned implementation is ready for the required full gate, build first and use the same gate/environment with `corepack pnpm run test:coverage --maxWorkers=1 --no-file-parallelism`; retain every test and coverage threshold. No repeated unchanged full baseline is recommended merely to confirm the reported failure. If the narrow check still times out, preserve the failure and inspect live owned process/tree and resource evidence rather than raising timeouts or retrying until green.
