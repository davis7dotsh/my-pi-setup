# Hardcoded pipelines — design and runtime contract

_Status: implemented design record. The public surface is intentionally four bounded definitions, not a generic workflow API._

## Public definitions and ownership

`pipeline_run` accepts a self-contained `task`, caller-selected `working_dir`, and one of four hardcoded definitions:

- `feature-pipeline`: controller-owned five-track discovery and synthesis, three isolated parallel Luna/xHIGH implementation candidates, one Luna/xHIGH read-only selection plus primary-based bounded synthesis, exact promotion/cleanup, a Luna/xHIGH post-promotion remediation root, four Luna audits, reusable five-contributor final Luna audit segment, root final resolution and factual completion;
- `small-feature-pipeline`: read-only Luna/medium coordinator, one persistent Luna implementer, four parallel Luna auditors, and one same-session implementer remediation pass;
- `plan-pipeline`: persistent Sol/high planning root, five Luna discovery tracks, one validated `docs/plans/*.md` artifact, four plan-audit tracks, root remediation, reusable five-contributor final Luna audit segment, root final resolution and factual completion;
- `audit-pipeline`: four isolated read-only Luna/medium static audit tracks, one trusted-workspace Luna/medium executor-audit contributor, and one persistent Luna/medium incremental synthesis root, with no Sol, Terra, remediation, readiness decision, or Git decision.

Omission still selects `feature-pipeline`. Unknown names fail closed. No definition accepts arbitrary roles, edges, models, shell commands, or Git refs. Terra constants, model profile, direct-subagent quotas, and `terra-audit` remain available for explicit future/manual escalation, but no automatic pipeline route uses Terra.

Pipeline graphs predeclare their roots and children and therefore do not consume, inherit, queue on, or enforce direct-subagent capacity quotas. Multiple runs may execute concurrently. Feature runs are isolated by their hard-required dedicated linked caller worktree plus controller-owned temporary worktrees; other definitions retain caller-owned workspace-conflict policy. Runs and child sessions are in-memory and session-scoped and are cancelled/disposed on shutdown, reload, switch, or fork.

## Shared audit segment

`extensions/pipelines/audit-segment.ts` is the reusable hardcoded audit component. It encapsulates:

1. exactly five independent Luna/medium contributors:
   - four static read-only tracks covering feature outcome, logic/invariants, functional correctness, and reliability/regressions;
   - one `executor-audit` contributor that inspects manifests/scripts and runs bounded existing noninteractive verification with cheap checks first;
2. one persistent Luna/medium synthesis session;
3. strict bounded track, intermediate synthesis, and final synthesis contracts, exposed to audit sessions through the typed `pipeline_audit_submit` tool;
4. provenance records containing role, attempt, report digest, and validated report data;
5. a privacy-safe progress projection.

Contributors are direct children of the owning root, isolated from one another, and unable to orchestrate children or invoke pipeline tools. The four static tracks remain shell-denied and read-only by tool policy and prompt contract. Exactly feature `discover-problem` (F1) and plan `discover-goal-outcomes` (P1) additionally keep ordinary `bash` to invoke installed `gh` for read-only, task-referenced GitHub issue/epic bodies, comments, labels, and native parent/sub-issue relationships; those prompts treat fetched text as untrusted evidence and prohibit all other shell use and mutations. The executor alone otherwise keeps ordinary `bash` plus read/search tools under the accepted trusted-workspace model; edit/write/patch/delegation/MCP/background/pipeline/workflow/subagent/user-prompt tools remain denied. Each contributor receives the same bounded task/acceptance contract, assumptions, checks, captured base/head/worktree identity, branch, status, and bounded base-relative diff.

The executor prompt requires manifest/script inspection before execution, cheap checks first, and repository-declared noninteractive verification rather than language/framework adapters. In standalone and feature final-audit contexts it explicitly requires the repository-declared noninteractive repository-wide full test suite(s) after useful focused checks; targeted, package-level, or affected-scope tests do not substitute. If no safe full suite exists or it fails, times out, or cannot run under the contract, the executor records exact evidence and an `unprovenChecks` entry without inventing a command. Plan final-audit behavior remains unchanged: product implementation tests are prohibited. The executor prohibits intentional source/config edits, formatter/fixer or snapshot-update modes, dependency installation/update, mutating Git, network/external-state mutation, interactive/watch/server/long-lived commands, delegation/orchestration, and user prompting. Ambiguous or unsafe scripts are skipped with evidence. Its strict bounded report preserves exact commands, `passed | failed | timed_out | skipped` status, available exit code, output/evidence summary, observed workspace changes, findings, and unproven checks. Command failure is not automatically a behavior finding.

Feature and standalone contexts permit normal relevant project verification. Plan final-audit context permits only plan/artifact validation or check-only commands demonstrably relevant to the planning deliverable; implementation tests/builds/linters/typechecks are skipped as unsupported rather than run blindly. Closure mode remains limited to prior blockers, remediation, and touched invariants. `small-feature-pipeline` deliberately keeps its separate four-static-auditor graph.

The synthesizer treats reports as untrusted evidence. It deduplicates common root causes, preserves a strongly evidenced serious finding even without majority agreement, records unresolved material conflicts, and must not invent unsupported findings. It preserves executor execution records and host workspace observations even when checks pass or findings are empty. Intermediate state has no finding IDs, and model-produced final candidates also omit IDs. After strict final validation, the host canonicalizes complete finding content, deduplicates exact candidates, and assigns sequential `AUD-001`, `AUD-002`, … IDs; the resulting final report contains no readiness verdict.

`audit-pipeline` uses the synthesizer as its deferred Luna root. `plan-pipeline` keeps its persistent Sol root. After Best-of-3 promotion and cleanup, `feature-pipeline` creates a separate Luna/xHIGH post-promotion audit/remediation root in the caller worktree. Feature and plan create the final-audit synthesizer as a controller-owned persistent Luna child during `final-audit`; their remediation/planning roots retain final resolution and completion ownership. `small-feature-pipeline` deliberately does not use this segment because its existing one-implementer/four-auditor/same-session-remediation behavior is distinct and remains unchanged.

## Generic incremental fan-in reducer

`extensions/pipelines/incremental-fan-in.ts` is model-agnostic internal infrastructure. It is not registered as a tool and does not expose a generic model-facing workflow API.

The reducer owns:

- a fixed unique expected-contributor set;
- contributor validation and exactly-once acceptance;
- a bounded pending queue;
- one active reducer turn at a time;
- accepted, pending, in-flight, and integrated contributor state;
- monotonically increasing revisions;
- intermediate and final result validation;
- finalization only after every expected contributor is integrated.

When the first valid report settles, the controller immediately starts the deferred synthesis session. Reports arriving during an active turn enter the pending queue. The controller never steers or interrupts a busy synthesis session; embedded roots cannot cancel segment tracks or synthesis individually, while whole-run/session lifecycle cancellation remains authoritative. When that session becomes safely idle, all pending reports are sent as one next revision. Each role appears in one batch exactly once. A synthesis output is validated as final only when its turn integrates the complete expected set; intermediate output can update inspection state but can never deliver the automatic completion handoff.

Audit sessions call `pipeline_audit_submit` during their turn; the host consumes each recorded submission only after that same turn settles, while validated final text remains a compatibility fallback. A malformed or missing settled submission gets three correction turns in that same concrete session; the fourth fails the run and cancels remaining sessions. Track counters are independent, while the single persistent synthesizer counter is cumulative across reducer revisions and batches. Provider failure or cancellation still fails immediately. Dynamic host checks remain authoritative for the exact integrated-role set (any model order is canonicalized to declaration order), Git identity, and closure references. Initial final schemas require an empty `closureResults` array; closure schemas retain complete blocker records. Rejections identify bounded fields (roles, mode/Git identity, findings/conflicts/unproven checks, or closure IDs/order/conditions) so the same synthesizer session can correct them within its existing three-turn budget. Standalone completion requires all five validated contributor reports, all five integrations, and one valid final report. Embedded final-audit advancement to `final-resolve` has the same gate.

## Initial and closure audit contracts

The optional `audit` input on `pipeline_run` is valid only with `audit-pipeline`.

Initial mode accepts:

- `mode: "initial"`;
- optional bounded `acceptance_criteria` strings.

Closure mode requires:

- `mode: "closure"`;
- one or more `prior_blockers`, each with an ID and closure condition;
- a bounded supplied `remediation_diff`;
- bounded `touched_invariants`;
- optional acceptance criteria.

Closure tracks and synthesis may evaluate only supplied blocker IDs and closure conditions, the remediation diff, and directly touched invariants. They must not reopen broad discovery. The final report preserves blocker order, IDs, and closure conditions and records `closed`, `open`, or `unproven` with evidence. The public schema has no command or ref field.

## Host-collected Git evidence

The controller captures `HEAD` when a run starts. Feature preflight additionally requires a stable clean attached dedicated linked worktree, rejects the primary checkout, and uses that exact commit as the candidate base. At audit-segment activation the controller resolves current `HEAD`, branch, short status, and base-relative diff using `execFileSync("git", argumentArray, ...)` without shell interpolation. After executor settlement it captures fresh bounded status plus dirty/combined diff evidence, compares it observationally with activation evidence, and carries the result into synthesis/final facts without rollback. Output is bounded before entering model context. Non-feature pipelines in a non-Git workspace degrade to explicit `UNAVAILABLE` identity/evidence rather than guessed state. The public API exposes no arbitrary commands or refs.

## Definition flows

### Feature pipeline

```text
Controller-owned five Luna/medium discovery tracks in parallel
  → validated full discovery fan-in
  → separate read-only Luna/medium discovery synthesis
  → one exact captured Git base
  → three isolated parallel Luna/xHIGH candidates: Minimal | Robust | Architectural
  → three complete committed candidate handoffs and frozen refs
  → one Luna/xHIGH selection-only comparison
  → exactly one validated primary
  → separate synthesis worktree from the exact primary commit
  → optional bounded augmentation, verification, and final synthesis commit
  → exact fast-forward promotion into the original caller feature worktree
  → controller-owned temporary worktree cleanup (refs retained)
  → separate Luna/xHIGH post-promotion audit/remediation root
  → four agent-driven Luna audit tracks
  → root resolves findings in the caller worktree
  → controller-owned reusable five-contributor Luna final audit segment
  → root resolves synthesized findings once
  → factual completion
```

Feature invocation fails before discovery or temporary mutation unless `git_commit` is explicitly true, Linux bubblewrap is executable at `/usr/bin/bwrap`, and `working_dir` is the root of a clean, attached, stable, dedicated linked Git worktree. The repository primary checkout, detached worktree, dirty/untracked state, non-root subdirectory, non-linked directory, unavailable Git identity, or changing HEAD is rejected with a bounded diagnostic. One base commit is captured once. The controller creates run-scoped `candidate-minimal`, `candidate-robust`, and `candidate-architectural` branch/worktree refs from that exact commit; Git commands use argument arrays and cleanup is restricted to paths beneath the run-owned temporary root.

Discovery remains the existing five-track strict `feature-discovery-v2` fan-in. Reports retain exact ordered role coverage, evidence, candidate acceptance records, actionable unknown/safe assumptions, constraints, 12-item collection bounds, 2 KiB ordinary fields, 20 KiB reports, and 100 KiB complete fan-in. The terminating `pipeline_discovery_submit` token binding, final-text fallback, three same-session correction turns, pre-session replacement rule, provider failure behavior, and no-rediscovery boundary are unchanged.

After full fan-in, a separate read-only Luna/medium `discover-synthesis` session returns strict bounded `feature-discovery-synthesis-v1`: summary, feature contract, observable acceptance criteria, constraints/non-goals, exact evidence-backed precedents, relevant paths, contracts/invariants, risks, unknowns, assumptions, and verification expectations. It does not choose a model or implementation role. The host prepares one immutable JSON package containing the original task, all five complete validated reports and synthesis, acceptance/constraints/non-goals, paths/precedents, contracts/invariants, risks/unknowns/assumptions, and verification expectations.

All three candidate sessions start dependency-ready in parallel, use `openai-codex/gpt-5.6-luna` with `xhigh`, and receive that byte-identical package before their first implementation turn. Only the surrounding role objective differs:

- **Minimal** minimizes the correct diff, touched components/abstractions, and scope while preserving all acceptance criteria;
- **Robust** emphasizes invariants, edge/failure/recovery paths, regression resistance, and testability; complexity must reduce a concrete risk;
- **Architectural** emphasizes evidence-backed boundaries, maintainability, and needed extensibility; unsupported layers are negative.

Each works only in its controller-owned worktree, creates a complete implementation with legitimate tests/checks/self-remediation, leaves a clean branch with at least one ordinary implementation commit, and returns a strict bounded handoff: role, approach, changed paths, checks, assumptions, trade-offs, unresolved issues, worktree/branch, base, and head. Host validation compares every Git/path field and changed-path list to actual committed state and proves each head descends from the captured base. A changed historical test is allowed when the behavior change is justified. Candidate built-in read/edit/write/bash tools are replaced by controller-scoped definitions: filesystem operations resolve only beneath the assigned worktree, and bash runs inside bubblewrap with the host root read-only, the run temporary root masked, only the assigned worktree rebound writable, network namespaces isolated, and shared Git metadata masked. Agents request ordinary commits through `pipeline_feature_commit`; only the controller stages/commits the role-owned worktree. Settled candidates are frozen by controller state: neither root continuation/cancellation APIs nor agent-tree view send/cancel controls can target them, while whole-run controller cancellation remains available; the controller rechecks clean immutable heads before selection. Full transcripts and tool history are not synthesis inputs.

One persistent Luna/xHIGH `implementation-synthesis` session owns two distinct turns. Its first turn runs in an empty controller-owned selection directory with no synthesis worktree. It receives the common package plus each compact handoff, changed paths, immutable commit/worktree reference, checks/trade-offs, and a per-candidate diff bounded at 48 KiB; total synthesis input is bounded at 512 KiB. It compares in this exact order: correctness, acceptance coverage, regression risk, repository fit, simplicity, maintainability, verification quality. It chooses the simplest fully reliable candidate, never role name, raw size, or ambition. The host requires all roles exactly once, exactly one usable primary, verifies that the selection directory remained empty and all candidates remained frozen, and fails explicitly if none is usable. During selection only scoped read and bubblewrap read-only bash are active; candidate worktrees are rebound read-only and sibling/run paths remain masked. After selection the controller atomically enables the same session's scoped edit/write and commit tools for its primary-based synthesis worktree.

Only after valid selection does the controller replace that empty path with a linked synthesis worktree created from the exact primary commit. The same Luna session receives its second turn. It may accept zero or a small number of objectively beneficial losing-candidate ideas: simpler local code, concrete edge-case/test/invariant handling, a better boundary, or a justified small structural improvement. It may not author a hidden fourth implementation. Every selection idea names exact unique source paths from a losing candidate's committed diff. Every accepted augmentation must copy that validated idea/source set, map each source path exactly once to a unique actual primary-to-final path, and produce a final Git blob (or deletion) exactly identical to the frozen losing candidate's source blob (or deletion). This intentionally permits only mechanically attributable whole-file adoption; arbitrary hand-written hybrids are rejected as unverifiable fourth implementations. No-augmentation commits must report no accepted ideas or changed paths. Augmentation is capped at 64 paths and 128 KiB of primary-to-final diff, and the final commit must descend from the primary commit. The session runs repository verification, self-remediates, leaves a clean branch, and creates a distinct final commit; an empty commit records a valid no-augmentation result. Strict provenance records the primary, accepted/rejected augmentations, checks, changed paths, assumptions, unresolved issues, and final commit for observability only.

Promotion revalidates that the caller branch/HEAD/clean state still equals preflight, then performs an ancestry-safe exact fast-forward to the synthesis commit and verifies identical HEAD/tree plus a clean caller worktree. Drift fails closed without promotion. Only after success are controller-owned candidate/synthesis directories removed; candidate and synthesis branch refs/commits remain. Failure, cancellation, shutdown, or partial creation cancels active sessions and performs idempotent bounded cleanup only under the run-owned temporary root; incomplete state is never promoted and unrelated worktrees are untouched. If Git refuses a worktree removal, cleanup retains that registered directory/root and records a bounded diagnostic instead of deleting the path behind stale Git metadata.

The controller then creates a separate Luna/xHIGH post-promotion root in the original caller worktree. Candidate roles, winner identity, rationale, borrowed ideas, temporary paths/refs, and commits remain internal. Pre-final and final audit contexts are host-built from the original task, validated discovery reports/synthesis, acceptance/constraints/invariants, a controller-owned count-only synthesis verification summary, and fresh promoted/remediated Git evidence; model-authored synthesis check text and root-supplied provenance-bearing context are withheld. Existing four-track audit, remediation, reusable final audit, final resolution, and factual completion behavior continues against only the caller worktree. When the structured final synthesis validates, `pipeline_child_wait` and synthesis inspection directly return the complete bounded controller-held final report to the root even if the synthesis session's `finalText` is empty, so final-resolve cannot silently skip findings submitted through tools. `pipeline_complete.final_finding_resolutions` must then contain exactly one structured `fixed | rejected` record per delivered finding ID, each with non-empty resolution and verification evidence; duplicate, missing, extra, incidental-string, or evidence-free accounting fails closed. No Sol or direct-subagent quota is used in the candidate/selection/augmentation segment, no discovery is repeated, and no audit-based model-profile escalation exists.

### Small-feature pipeline

```text
Read-only Luna/medium coordinator
  → one persistent Luna/medium implementer
  → four parallel read-only Luna/medium auditors
  → same implementer receives all reports and remediates once
  → factual completion
```

There is no discovery, Sol, Terra, reusable synthesis segment, replacement auditor, or post-remediation re-audit.

### Plan pipeline

```text
Sol/high planning root
  → five Luna discovery tracks
  → validated docs/plans/*.md artifact
  → four Luna plan-quality tracks
  → Sol remediates and revalidates
  → controller-owned reusable five-contributor Luna final audit segment
  → Sol resolves synthesis and revalidates once
  → factual plan completion
```

The root remains unable to use shell/edit/write or delegated mutation tools. It writes only through the validated plan artifact tool and reads bounded plan/Git evidence. Earlier discovery, artifact, audit, retry, and remediation behavior remains intact.

### Standalone audit pipeline

```text
Deferred persistent Luna/medium synthesis root
  ├─ four controller-owned read-only Luna/medium static tracks in parallel
  ├─ one controller-owned Luna/medium executor-audit contributor with bash
  ├─ first valid report activates root synthesis
  ├─ later reports are serialized/batched into that same session
  └─ strict factual structured audit handoff
```

No pipeline agent intentionally mutates source/config, remediates findings, makes readiness claims, or decides Git actions. Executor verification may create test/build/cache artifacts; those effects are observed and reported rather than rolled back.

## Commit permission and audit evidence

`git_commit` remains a public boolean but has definition-specific semantics. `feature-pipeline` hard-requires explicit true; false or omission is rejected before discovery and before temporary Git state. `small-feature-pipeline` keeps optional false-defaulting permission for only its persistent implementer. `plan-pipeline` and `audit-pipeline` reject true. The value is authoritative and never inferred from task text.

Feature true authorizes only the fixed internal lifecycle: controller-created candidate/synthesis branches and linked worktrees, ordinary candidate/synthesis commits, exact ancestry-safe promotion to the caller feature branch, run-owned cleanup, and ordinary post-promotion remediation commits by the persistent root. Candidate/synthesis agents cannot create, switch, remove, merge, reset, rebase, or otherwise manage branches/worktrees/history themselves. Discovery and audit roles cannot commit. No definition gains push, delivery merge, history rewrite, deployment, or external delivery-state authority. Candidate/synthesis branch refs are retained after directory cleanup for observability.

Audit tracks receive reusable host-collected evidence captured with argument-array Git commands: base and current HEAD, branch/status, base ancestry, bounded base-to-head commit list, committed base-to-head diff, dirty HEAD-to-worktree diff, and combined base-to-worktree diff. Every bounded item identifies whether evidence is available, truncated, or unavailable. This evidence is injected into standalone and applicable feature, plan, and small-feature audits. Small-feature remediation stays in the same persistent implementer session and is not re-audited. Feature and small-feature completion append fresh host-collected final Git facts so the factual handoff distinguishes committed, dirty, and combined state without making a readiness or delivery decision.

## Tooling, inspection, and completion

The feature post-promotion remediation root and the plan root receive `pipeline_audit_start`, a definition-specific tool that accepts only the bounded acceptance contract, assumptions, and check evidence. It starts the fixed shared segment and returns the six controller-owned agent IDs (five contributors plus synthesis) for normal run-scoped waiting/inspection. It is not a generic fan-in or workflow API. Pipeline children cannot call it.

`pipeline_check` and `pipeline_list` remain synchronous, nonblocking, and main-agent-only. Audit progress exposes only mode, phase, expected/accepted/pending/integrated counts, reducer idle/busy/finalized state, revision, and final-validation boolean. It never exposes prompts, thinking, tool arguments/results, raw reports, Git evidence, report provenance, session files, or session paths. Text and previews remain bounded.

`pipeline_complete` continues to emit facts rather than readiness. Standalone audit completion is controller-owned after strict final validation and includes the bounded structured final audit report. Feature and plan roots still call `pipeline_complete` after their own final resolution; the controller explicitly injects the validated structured final audit report into the final-resolve wait/check result rather than relying on synthesis `finalText`, requires exact structured per-finding resolution records, and augments feature completion with fresh final host Git observations. The calling main agent owns readiness, remediation outside the standalone audit, and all branch/commit/push/PR decisions beyond the narrowly opted-in ordinary commits described above.
