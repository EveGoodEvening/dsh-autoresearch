# Issues #21–#22 — independent release metadata review

## Verdict

**Accept the `0.0.7` release metadata slice. Zero open Fix/Replan findings.**
This satisfies the independent whole-diff review for ledger AC6/D11; it does not declare publication complete or waive the coordinator-owned artifact/CI/registry gates.

## Inspected evidence

- At inspected HEAD `77d1c8c`, the release diff changes only `package.json` version `0.0.6` → `0.0.7` and `CHANGELOG.md` heading `Unreleased` → `v0.0.7`. The other working change is coordinator-owned ledger accounting. Comparison against merged code `8dece815` lists only those three files: source, tests, dependencies, lockfile, workflow and release scripts are unchanged.
- `package.json:3` and `CHANGELOG.md:3` agree. The root importer in `pnpm-lock.yaml:14–138` records dependency specifiers/resolutions, not this package’s version; this bump requires no lockfile version edit. Dependency declarations and package/export/bundle identity are preserved.
- `CHANGELOG.md:7–15` preserves both reviewed fixes: whole-process-tree deadline/cancellation authority and quiescence before persistence/lock release; complete small success JSON and the required compact summary. It explicitly retains the tiny-cap summary floor, independent Host spill/redaction/denial authority, canonical durable results and failure/cancellation limits. These match AC1–2/D5/D8 and the prior final review; no unconditional Host-policy bypass is claimed. The unchanged Node engine remains `^24.22.1 || >=26.12.1`.
- `scripts/release-smoke.mjs:22–40,112–121` derives the tarball filename from the current manifest, producing `dsh-autoresearch-0.0.7.tgz`; no old-version script edit is needed. Its exact allowlist includes generated JS/declarations/maps, both READMEs, CHANGELOG, license, notices, patch and manifest. It checks installed ESM/declarations, native DSH profile activation/compatibility, isolation, installed scenarios and authenticated Web HTTP.
- `.github/workflows/publish.yml:3–68` triggers on pushed `v*` tags and rejects any tag other than `v${package.version}`. It uses Node `24.22.1`, npm `11.16.0`, a GitHub-hosted runner, job-scoped `id-token: write`, read-only contents and checkout without persisted credentials. Frozen-lockfile install → peers → typecheck → build → full coverage → packed release smoke must all succeed before `npm publish` via OIDC. Build precedes coverage; packing follows tests, avoiding the shared-`lib/` prepack race. No required release safety step is missing from this metadata slice.

## Release boundary

AC6/D11 explicitly authorizes the master release commit and new immutable annotated `v0.0.7`; the recorded `Release 0.0.7` annotation follows the existing convention. The prior 703-pass/full-coverage/installed-Web gates, fresh 9.48-second peer/type/build gate, exact-version registry 404 and remote-tag absence are coordinator-recorded evidence, not executions repeated by this reviewer.

The coordinator retains the planned ignore-scripts pack and exact tarball metadata check, commit/master/tag push, observation of actual tagged CI success, and fresh exact-version/dist-tag/download-integrity verification. No pre-tag publish dry run or old-tag rewrite is required or authorized by this review.

Method: static file/diff inspection only. No tests, builds, installs, publication, Git mutations, GitHub operations, browser/heavy work or delegation. This report is the only reviewer write; source and ledger were not edited.
