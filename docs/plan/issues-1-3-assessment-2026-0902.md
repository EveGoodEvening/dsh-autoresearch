# GitHub Issues #1–#3: Scoped Assessment and Remediation Tracker

## Authority and scope

This file is the sole live plan and sequential checklist for GitHub issues [#1](https://github.com/EveGoodEvening/dsh-autoresearch/issues/1), [#2](https://github.com/EveGoodEvening/dsh-autoresearch/issues/2), and [#3](https://github.com/EveGoodEvening/dsh-autoresearch/issues/3).

The issue body’s demonstrated defect and explicit remedies define each closure boundary. A broader security or reproducibility concern is recorded separately and does not block an issue unless the issue text makes it part of the required boundary. Conversely, closure may not omit an explicit issue requirement.

This is a planning artifact only. It changes no source or tests, runs no verification gate, posts no issue comment, and changes no issue state. Checked historical evidence below remains evidence of work previously observed, not fresh proof for closing these issues. Every new implementation, verification, review, accounting, comment, and closure step starts unchecked.

`docs/plan/handoff-2026-0830-checklist.md` remains the historical authority for its completed H-01 through H-15 remediation. This tracker neither rewrites nor reopens that history.

## Initial GitHub state baseline

Observed by unauthenticated direct read of each canonical GitHub issue page at **2026-09-02T13:01:32Z**. The rendered pages exposed the open state but no separate state reason. Later read-backs supersede these observations for current state while preserving this baseline historically.

| Issue | Canonical URL | Observed state | State reason | Evidence source |
|---|---|---|---|---|
| #1 | https://github.com/EveGoodEvening/dsh-autoresearch/issues/1 | open | not exposed | canonical issue page, direct read |
| #2 | https://github.com/EveGoodEvening/dsh-autoresearch/issues/2 | open | not exposed | canonical issue page, direct read |
| #3 | https://github.com/EveGoodEvening/dsh-autoresearch/issues/3 | open | not exposed | canonical issue page, direct read |

## Scoped dispositions

| Issue | Exact defect and required remedy | Current assessment | Closure boundary |
|---|---|---|---|
| #1 | A model-selected target repository can escape the parent Agent repository/workspace. Default to the canonical parent repository or canonical containment within the parent workspace. Cross-repository operation must require separate human command/approval or deployment-controlled allowlisting; the same model call may not both select and authorize the other repository. | Open. The current plan has not freshly proved this containment contract on every start/resume path. | Close after canonical containment is enforced before target repository discovery or mutation, escape cases fail without effects, and any cross-repository route is separately authenticated and non-model-owned—or cross-repository requests are simply rejected. No external Host effect-capability is required for ordinary same-repository closure. |
| #2 | Model-provided evaluator command, args, and environment reached Host subprocess authority. Establish a non-model trust boundary through deployment-pre-registered evaluator IDs or a human-created immutable run manifest; if raw argv remains model-facing, use the issue’s sandbox + approval + allowlist alternative. | Evidence-backed prior remediation exists: Host-owned evaluator registration, removed raw model authority, durable registration identity, and mismatch handling were implemented and reviewed. Fresh verification and issue-specific review are still required before closure. | Close when fresh evidence proves evaluator selection and exact argv/environment are immutable Host/human-owned data unavailable to model modification across start, resume, and recovery, with pre-effect rejection of missing, unknown, submitted-on-resume, changed, or mismatched identity. Hostile candidate isolation is separate and non-blocking. |
| #3 | Declared evaluator and dataset files were not actually frozen: their identity/SHA-256 was absent from the production boundary, not revalidated before every spawn, and not automatically excluded from mutation. | Evidence-backed prior remediation exists: explicit Host declarations, SHA-256 manifests, mutable-surface exclusion, pre/post-spawn checks, resume/recovery handling, and typed mismatch blocking were implemented and reviewed. Fresh verification and issue-specific review are still required before closure. | Close when fresh evidence proves exact declared evaluator/local-dataset file identity and SHA-256 are recorded before baseline, excluded without filename heuristics, and revalidated before baseline, candidate, resume, and recovery spawns, rejecting mismatch before spawn. Runtime executable/dependency closure is separate and non-blocking. |

## Preserved completed remediation evidence

The following is historical evidence from `docs/plan/handoff-2026-0830-checklist.md`; it must be cited accurately but must not be treated as a substitute for fresh closure verification:

- **Chronology — preparation:** `174ecb01d2834398c9b0c2496c0f53a679ed5730` prepared durable evaluator registration identity; accounting `efaabef4da68387c417371a4a8611f2b6bb60667`.
- **Chronology — preparation:** `75949d0fe7aa504537e98b5941e14f7da364279e` prepared declared evaluator/dataset hashing, exact-path protection, and revalidation primitives; accounting `b2a7f14d2e3f8bdaa375d659a02abbb50564db28`.
- **Chronology — preparation:** `cf3d0c3` prepared the Host evaluator registry and model contract; accounting `488c73a1edb43671730ca8dbe5f257f8f8c461db`.
- **Chronology — hardening:** `d9c10369cdc83948dd6cd0960fe2d63caf1d2fac` plus review fixes `da87f21276a83f842cee15f6870818caada71751`, `aca459bb94a895078cda855f64c8fde5e7e356e5`, `653add91657902e3e4889796da510dbdb1d191b9`, and `9d6b3ca503fa27256095765a1dbdc807188c6689` hardened activation primitives; accounting `5df192445a6d2da96958590d3d4c00d8f1b015a9` and `ed849ad18279e14e54ac69072b6e32b5873e3df9`.
- **Chronology — activation:** `4b9e93efcb343b9a9cf017ba47605dc44e867e6a` activated Host-owned evaluator selection and frozen evaluator/data identity; accounting `0dee00d206dd4414c4034255c0affd5a2050b730`.
- **Chronology — documentation predecessor:** `aec50bc625d1635297f83643d00834adfb194744` aligned README trust and evaluator/data wording with the implemented boundary.
- **Chronology — subsequent boundary fix:** `f511456436d2067a522e8e001f49dd8bdeb13603` fixed the typed frozen-boundary gap; its recorded focused suite passed 301 tests and typecheck, followed by clean review; accounting `6cbe16c0a702c2976a4d5401d3d0fdf34389cfdc` (`docs(plan): record handoff chunk 08`).

Fresh verification must exercise the current tree, current public contract, all named lifecycle paths, and every issue-specific negative case. A fresh finding reopens only its owning scoped chunk and any truly dependent later step.

## Separately recorded, non-blocking concerns

These concerns may warrant separate issues, but they are not closure prerequisites for #1–#3:

1. **Broader effect authority and delegation:** cwd/repository containment is not a complete grant for Git, SQLite, artifacts, child Agents, subprocesses, or cleanup. Track separately; do not convert it into an external-capability blocker for ordinary same-repository #1 closure.
2. **Hostile candidate isolation:** a Host-selected evaluator may execute or import candidate-controlled code without complete filesystem/process/network/credential isolation. Track separately; do not redefine #2 after evaluator argv/environment selection is Host/human-owned.
3. **Runtime dependency reproducibility:** executable, interpreter, shared-library, external module, provider, and image identities may not be content-bound. Track separately; do not expand #3 beyond the declared evaluator/dataset files named by the issue.
4. **External dataset identity:** remote or otherwise repository-unavailable dataset bytes may need an immutable algorithm-qualified digest contract. Track separately; this is not verification, remediation, or closure work for #3, which is limited to the declared evaluator and dataset files required by the issue.

Any follow-on record must clearly say it is non-blocking for #1–#3 and must not be cited as a reason to withhold closure after the scoped contracts pass.

## Durable accounting checkpoint protocol

An accounting checkbox may assert only facts observable before its commit: that the record is complete and its staged diff was reviewed. It must never claim that its own commit has already landed. The reviewed tracker-only accounting commit is itself the durable checkpoint; its resulting SHA is recorded in the next chunk's accounting record before that later work is accounted. For the terminal accounting commit, Git history plus its unique terminal commit subject is the durable locator, while the committed tracker content carries the final canonical state and any resume pointer. If later tracker work occurs, that next commit records the terminal accounting SHA. No follow-up commit exists solely to make a self-referential checkbox true.

## Minimal sequential plan

### Chunk 00 — Land and account for this scoped assessment

- **Path:** only `docs/plan/issues-1-3-assessment-2026-0902.md`.
- **Work:** replace the obsolete unconditional activation shutdown, external Host effect-grant dependency, full isolation-provider dependency, runtime/image identity dependency, and their expanded chunks/blockers with this scoped plan; preserve the initial GitHub baseline and historical remediation evidence.
- **Planning review:** compare the staged diff with all three issue bodies and `local://issues-plan-scope-arbitration.json`; confirm every arbitration decision is implemented, future steps remain unchecked, and no source, test, README, historical tracker, issue comment, or issue state changed.
- **Planning commit:** `4aa1cdadd0263ca57db16309df90af8bd911fb6e` (`docs(plan): assess issues 1 through 3`).
- **Changed-path proof:** the planning commit added only `docs/plan/issues-1-3-assessment-2026-0902.md`, with 158 insertions and no source, test, README, historical-tracker, issue-comment, or issue-state change.
- **Planning review result:** clean; two final reviewers compared the scoped assessment with all three issue bodies and the approved arbitration, and returned zero findings. The review confirmed that #1 is limited to canonical parent repository/workspace containment with separately authorized or rejected cross-repository operation; #2 retains the Host/human-owned evaluator authority boundary without adding hostile-candidate isolation or metric-definition ownership; #3 retains declared evaluator/dataset file identity and SHA-256 without adding runtime/image or external-dataset identity; and every later implementation, verification, issue action, and closure item remains unchecked.
- **Initial-state evidence:** the planning commit preserves the unauthenticated canonical-page baseline observed at `2026-09-02T13:01:32Z`: issues #1, #2, and #3 were open and no separate state reason was exposed.
- **Rollback:** revert only `4aa1cdadd0263ca57db16309df90af8bd911fb6e` and this tracker-only accounting commit before Chunk 01 begins. After dependent work begins, preserve the scoped arbitration and roll forward rather than restoring the obsolete expanded blockers.
- **Dependency-ready next chunk:** `resume at Chunk 01 — canonicalize and compare the requested target before repository discovery`.
- **Exact Chunk 01 targets:** `src/controller.ts`, `src/git.ts`, `src/types.ts`, `tests/git.spec.ts`, `tests/controller.spec.ts`, and `tests/composition.integration.spec.ts`; no other path is in the dependency-ready slice unless the implementation proves a direct caller or public-contract dependency.
- **Acceptance:** derive the canonical allowed parent repository/workspace independently of model input; canonicalize and compare every requested start/resume target before repository discovery, retention, tracker access, Git/worktree/ref mutation, job/Agent creation, evaluator spawn, artifacts, or cleanup; allow the canonical parent repository and the plan's single documented contained-workspace rule; reject lexical, symlink, nested-repository, sibling, external-repository, linked-worktree, and canonical-alias escapes without effects; and reject cross-repository operation unless a separate non-model-owned human/deployment authority is implemented and durably preserved across resume.
- **Verification commands:** `pnpm exec vitest run tests/git.spec.ts tests/controller.spec.ts tests/composition.integration.spec.ts`; `pnpm run typecheck`.
- **Commit subjects:** implementation `fix(security): contain autoresearch repository targets`; tracker-only accounting `docs(plan): record issue 1 containment`.
- [x] Planning diff reviewed and planning commit landed.
- [ ] Accounting record complete and staged tracker-only diff reviewed for commit.

### Chunk 01 — Implement and freshly verify issue #1 repository containment

- **Issue owner:** #1 only.
- **Work:** derive the canonical parent repository/workspace boundary independently of the model-selected target; canonicalize the requested target before repository discovery, retention, tracker access, Git/worktree/ref mutation, job/Agent creation, evaluator spawn, artifacts, or cleanup. Permit ordinary operation when the target is the canonical parent repository or is canonically contained within the allowed parent workspace, according to the chosen single documented rule. Reject lexical and canonical escapes before effects.
- **Cross-repository rule:** the model-facing request alone can never authorize an external repository. Either reject all cross-repository targets or accept them only through a separately authenticated human command/approval or deployment-owned allowlist whose authority cannot be created, selected, or widened by the same model call. Same-repository operation has no external capability prerequisite.
- **Verification:** fresh start and resume; repository root and allowed contained workspace; `..`, symlink, nested repository, sibling, external repository, linked worktree, canonical alias, foreground, and background paths. Rejections must prove no discovery/mutation side effects. If a cross-repository authority route exists, verify allow, deny, provenance, model non-widening, and resume persistence.
- **Review:** issue-text scope, canonical-path correctness, check ordering, TOCTOU assumptions actually claimed, start/resume parity, and no accidental requirement for a broader effect-class grant.
- **Implementation commit:** one focused source/test commit after the verification/review/fix loop is clean.
- **Tracker-only accounting commit:** record exact implementation SHA, paths, observed commands/results, review evidence, compatibility, rollback, and residual non-blocking risks; stage and review this tracker-only diff before committing.
- [ ] Scoped implementation complete.
- [ ] Fresh verification passes on the current tree.
- [ ] Issue-specific review/fix loop is clean.
- [ ] Accounting record complete and staged tracker-only diff reviewed for commit.

### Chunk 02 — Freshly verify and account issue #2 Host/human-owned evaluator authority

- **Issue owner:** #2 only.
- **Work:** inspect the current production start/resume/recovery paths and preserve the existing clean cutover: model input selects only an opaque registered evaluator ID for a new run; raw command, args, cwd, environment, and evaluator registration content are unavailable to model modification; resume derives the durable registration and rejects a submitted evaluator ID; recovery uses the same durable identity. Exact argv and the closed environment originate from immutable Host/deployment configuration or an immutable human-created run manifest. Metric-definition ownership is outside #2 and cannot trigger remediation or prevent closure.
- **Verification:** omitted/unknown evaluator ID on start, removed raw authority keys, submitted evaluator ID on resume, registration removal/change/reordering/environment drift, durable fingerprint mismatch, legacy policy handling, recovery/replay, and rejection before repository mutation or spawn. Confirm the actually spawned argv/environment equal the accepted Host/human-owned registration.
- **Alternative only if raw argv is reintroduced:** the issue’s sandbox, explicit approval, and command allowlist requirements become mandatory and must be verified together.
- **Review:** trace ownership from deployment/human input through persistence to every spawn; confirm no model field, candidate content, resume input, migration, or recovery fallback can alter selection/argv/environment. Do not add hostile-candidate OS isolation as a closure condition.
- **Implementation policy:** if fresh verification finds no scoped defect, make no source/test change; account the current evidence. If it finds one, land one focused corrective commit and rerun the full scoped verification/review.
- **Tracker-only accounting commit:** record historical SHAs cited, current-tree evidence, any corrective SHA, exact paths/results, review, rollback, and the separately tracked isolation risk; stage and review before commit.
- [ ] Fresh current-tree verification passes.
- [ ] Issue-specific ownership review/fix loop is clean.
- [ ] Accounting record complete and staged tracker-only diff reviewed for commit.

### Chunk 03 — Freshly verify and account issue #3 declared evaluator/dataset bytes

- **Issue owner:** #3 only.
- **Work:** inspect the current production boundary and preserve explicit Host declarations for evaluator files and local dataset files; derive identity and SHA-256 from the isolated start commit before baseline; persist the exact manifest; automatically exclude every declared path from the mutable surface regardless of mutable globs or filename; revalidate on baseline, every candidate, resume, and recovery before spawn. Retain attempt-local anti-swap checks where implemented. Do not add an external-dataset digest contract to #3 verification, remediation, or closure work.
- **Verification:** the issue’s representative `bench/score.mjs` and `data/holdout.json` cases plus broad mutable globs, missing file, symlink, rename, content replacement, declaration drift, manifest corruption, inode/device swap, accepted-candidate resume, recovery rerun, and mismatch rejection before spawn. Confirm protection is declaration-driven, never based on `eval`/`evaluator`/`dataset` filename heuristics.
- **Public wording review:** claims must say the **declared evaluator and dataset files** are content-bound/frozen and revalidated, not that the executable, interpreter, dependency graph, provider, or image is frozen.
- **Implementation policy:** if fresh verification finds no scoped defect, make no source/test change; account the current evidence. If it finds one, land one focused corrective commit and rerun the full scoped verification/review.
- **Tracker-only accounting commit:** record historical SHAs cited, current-tree evidence, any corrective SHA, exact paths/results, review, rollback, and the separately tracked runtime-dependency risk; stage and review before commit.
- [ ] Fresh current-tree verification passes.
- [ ] Issue-specific file-identity review/fix loop is clean.
- [ ] Public wording is exact and truthful.
- [ ] Accounting record complete and staged tracker-only diff reviewed for commit.

### Chunk 04 — Aggregate review, issue comments, and closure accounting

- **Clean entry path:** enter after Chunks 00–03 are complete and accounted with no unresolved in-scope blocker; perform aggregate verification/review, then the issue actions and terminal accounting below.
- **Blocker-mode entry path:** when any Chunk 01–03 has a genuine in-scope blocker, enter after all reachable work and its blocker record are accounted. Skip only aggregate prerequisites that the blocker makes impossible. Prepare and process issue-specific blocker comments, independently close every satisfied issue, leave blocked issues open, perform the post-action state read-backs, and publish terminal accounting with one canonical aggregate resume pointer.
- **Aggregate verification (clean mode, and reachable portions in blocker mode):** run the repository’s final required checks and smoke path, but credit only observed results. Review the complete implementation/accounting range and resolve every reachable in-scope finding before preparing issue actions.
- **Separate prepared comments:** create one evidence comment per issue containing its exact defect, remedy, current implementation SHA(s), fresh verification, review result, residual non-blocking risks, and closure condition. In blocker mode, the blocked issue instead receives the issue-specific blocker comment required below. #1 must not cite external Host effect authority; #2 must not require hostile-candidate isolation or metric-definition ownership; #3 must not require runtime dependency/image identity or an external-dataset digest contract.
- **Pre-post review gate:** before posting each comment, review its prepared text against the current issue body/state, accounted SHAs, observed evidence, and intended closure or leave-open action. Fix discrepancies before posting. Do not post a combined or generic comment.
- **Comment post/read-back gate:** after posting, read back the canonical issue URL, canonical comment URL, UTC timestamp, then-current issue state/reason, and exact rendered content. If a posted comment is wrong, post an explicit corrective comment identifying and superseding it; read back and account both canonical URLs and their relationship before any issue-state action.
- **Issue-state action:** close only an issue whose scoped contract is fully satisfied; explicitly leave a genuinely blocked issue open. Issues are independent: a separately recorded broader risk does not prevent closure, and one genuinely blocked issue does not prevent another satisfied issue from closing.
- **Mandatory post-action canonical state gate:** after each close or explicit leave-open decision, read back the canonical issue URL again and record the observed final state, state reason, and UTC timestamp. A successful post-action read-back for every issue is required before terminal accounting; the earlier comment read-back cannot satisfy this gate.
- **Terminal tracker-only accounting:** stage a tracker-only diff recording the exact implementation/accounting range, final checks, reviews, comment and correction URLs/timestamps, each post-action canonical state/reason/timestamp, residual risks, rollback, and one canonical aggregate resume pointer if anything remains. Review/fix the staged diff before the terminal accounting commit.
- [ ] Aggregate current-tree verification and review are clean, or blocker mode records every unreachable portion and its owning blocker.
- [ ] Each prepared closure or blocker comment passes pre-post review.
- [ ] Each posted comment is read back; corrections, if any, are explicit and accounted.
- [ ] Each satisfied issue is closed independently; each blocked issue explicitly remains open.
- [ ] Every post-action canonical issue state/reason/timestamp is read back successfully.
- [ ] Terminal accounting record complete and staged tracker-only diff reviewed for commit.

## Genuine in-scope blocker and resume protocol

A blocker is valid only when it prevents an explicit requirement inside the scoped remedy above. The external Host effect grant, hostile-candidate isolation provider, and executable/runtime/image dependency identity are not valid blockers for #1–#3.

For a genuine blocker:

1. Finish and account all reachable in-scope work.
2. Prepare a tracker-only blocker record naming the issue owner, exact missing in-scope prerequisite, evidence/source inspected, completed and accounted predecessor SHA range, remaining reachable work, residual risk, and exactly one pointer in the form **`resume at Chunk NN — <named step>`**.
3. Review/fix the staged tracker-only blocker diff before committing `docs(plan): record issue N in-scope blocker`.
4. Enter Chunk 04 through its blocker-mode path. Prepare the issue-specific blocker comment with the same evidence and resume pointer; apply the pre-post review, comment post/read-back, correction, issue-state action, and mandatory post-action canonical state gates.
5. In terminal accounting, publish one canonical aggregate pointer to the earliest blocked in-scope step; it supersedes individual pointers without erasing them. Terminal accounting is prohibited until every issue's post-action canonical state/reason/timestamp has been read back successfully. Never use a vague pointer such as “resume security work.”

Expected pointers if a blocker occurs in this plan:

- #1: `resume at Chunk 01 — canonicalize and compare the requested target before repository discovery`.
- #2: `resume at Chunk 02 — trace immutable Host/human evaluator registration through the first failing lifecycle path`.
- #3: `resume at Chunk 03 — revalidate the declared evaluator/dataset manifest before the first failing spawn path`.
- Issue-action/accounting only: `resume at Chunk 04 — pre-post review of the first unposted or uncorrected issue comment`.

## Final completion criteria

- [ ] #1 enforces canonical parent repository/workspace containment before effects; cross-repository authority is separate and non-model-owned, or cross-repository operation is rejected.
- [ ] #2 proves immutable Host/human ownership of evaluator selection, argv, and environment through start, resume, recovery, and spawn.
- [ ] #3 proves declared evaluator/dataset identity, SHA-256, automatic exclusion, and pre-spawn revalidation through baseline, candidate, resume, and recovery.
- [ ] Historical remediation is preserved but closure relies on fresh current-tree verification and issue-specific review.
- [ ] Broader effect authority, hostile-candidate isolation, and runtime dependency closure are separately recorded and explicitly non-blocking.
- [ ] Every tracker-only accounting or blocker record is complete and its staged diff is reviewed before commit; landed accounting SHAs are carried forward by the durable checkpoint protocol without self-reference.
- [ ] Every external comment passes pre-post review, is read back, and is explicitly corrected and re-accounted if inaccurate.
- [ ] After every close or leave-open action, the canonical issue is read back again; final state, state reason, UTC timestamp, canonical URLs, comment URLs, SHAs, evidence, residual risks, rollback, and any exact aggregate resume pointer are durably accounted.
