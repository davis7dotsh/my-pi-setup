import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import type {
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type {
  AgentNodeSpec,
  AgentTreeSession,
  AgentTreeSessionEvent,
} from "../shared/agent-tree/domain.ts";
import {
  PipelineController,
  pipelineDiscoverySubmissionAllowed,
} from "./controller.ts";
import { inspectPipeline, PIPELINE_CHECK_MAX_BYTES } from "./inspection.ts";
import { pipelineSessionToolPolicy, pipelineThinkingLevel } from "./session.ts";
import { buildPipelineRows, cancelPipelineRow } from "./dashboard.ts";
import {
  AUDIT_SEGMENT_LUNA_ROLES,
  EXECUTOR_AUDIT_ROLE,
  FEATURE_PIPELINE_DISCOVERY_ROLES,
  STATIC_LUNA_AUDIT_ROLES,
  FINAL_AUDIT_ROLE,
  LUNA_MODEL,
  PIPELINE_CHILD_ROLES,
  PLAN_PIPELINE_AUDIT_ROLES,
  PLAN_PIPELINE_CHILD_ROLES,
  PLAN_PIPELINE_DISCOVERY_ROLES,
  SMALL_FEATURE_IMPLEMENTER_ROLE,
  SMALL_FEATURE_PIPELINE_CHILD_ROLES,
  SOL_MODEL,
  TERRA_MODEL,
  childContextPolicyFor,
  type PipelineChildRole,
  type PipelineHandoff,
} from "./domain.ts";
import { FEATURE_DISCOVERY_COVERAGE } from "./discovery-report.ts";
import {
  FEATURE_CANDIDATE_ROLES,
  FEATURE_DISCOVERY_SYNTHESIS_ROLE,
  FEATURE_IMPLEMENTATION_SYNTHESIS_ROLE,
  type FeatureCandidateHandoff,
  type FeatureCandidateRole,
  type FeatureSelection,
  type FeatureSynthesisProvenance,
} from "./feature-best-of-three.ts";
import type {
  FeatureCallerWorktree,
  FeatureGitOperations,
  FeatureTemporaryWorktree,
  FeatureWorktreeLifecycle,
  FrozenFeatureCandidate,
  FeatureSynthesisWorktree,
  ValidatedFeatureSynthesis,
} from "./feature-worktrees.ts";

class FakePipelineSession implements AgentTreeSession {
  readonly listeners = new Set<(event: AgentTreeSessionEvent) => void>();
  readonly prompts: string[] = [];
  readonly sends: string[] = [];
  readonly sessionFile: string;
  isStreaming = false;
  interrupted = 0;
  disposed = 0;
  mutationEnabled = 0;

  readonly activeTools: ReadonlyArray<string>;
  readonly spec: AgentNodeSpec;
  readonly autoReport?: string | ((turn: number) => string);
  readonly discoverySubmit?: (value: unknown) => void;
  private turn = 0;

  constructor(
    activeTools: ReadonlyArray<string>,
    spec: AgentNodeSpec,
    autoReport?: string | ((turn: number) => string),
    discoverySubmit?: (value: unknown) => void,
  ) {
    this.activeTools = activeTools;
    this.spec = spec;
    this.autoReport = autoReport;
    this.discoverySubmit = discoverySubmit;
    this.sessionFile = `/tmp/${spec.scopeId}-${spec.role}-${spec.attempt}.jsonl`;
  }

  subscribe(listener: (event: AgentTreeSessionEvent) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event: AgentTreeSessionEvent) {
    if (event.type === "run_started") this.isStreaming = true;
    if (event.type === "settled") this.isStreaming = false;
    for (const listener of this.listeners) listener(event);
  }

  private autoComplete() {
    if (!this.autoReport) return;
    const report =
      typeof this.autoReport === "function"
        ? this.autoReport(this.turn++)
        : this.autoReport;
    queueMicrotask(() =>
      this.emit({
        type: "settled",
        outcome: { type: "completed", finalText: report },
      }),
    );
  }

  async prompt(text: string) {
    this.prompts.push(text);
    this.isStreaming = true;
    this.autoComplete();
  }

  async send(text: string) {
    this.sends.push(text);
    this.emit({ type: "run_started" });
    this.emit({ type: "user", text });
    this.autoComplete();
  }

  enableMutation() {
    this.mutationEnabled++;
  }

  async interrupt() {
    this.interrupted++;
    this.emit({ type: "settled", outcome: { type: "cancelled" } });
  }

  dispose() {
    this.disposed++;
  }
}

const BASE_COMMIT = "a".repeat(40);
const CANDIDATE_COMMITS: Readonly<Record<FeatureCandidateRole, string>> = {
  Minimal: "b".repeat(40),
  Robust: "c".repeat(40),
  Architectural: "d".repeat(40),
};
const FINAL_SYNTHESIS_COMMIT = "e".repeat(40);

class FakeFeatureLifecycle implements FeatureWorktreeLifecycle {
  readonly temporaryRoot: string;
  readonly caller: FeatureCallerWorktree;
  cleaned = 0;
  promoted = 0;
  selectionReadOnlyChecks = 0;
  synthesisCreated = 0;

  constructor(runId: string, caller: FeatureCallerWorktree) {
    this.temporaryRoot = `/tmp/${runId}-best-of-three`;
    this.caller = caller;
  }

  createCandidateWorktrees() {
    return FEATURE_CANDIDATE_ROLES.map((role) => ({
      role,
      path: `${this.temporaryRoot}/candidate-${role.toLowerCase()}`,
      branchRef: `pipi-feature/test/candidate-${role.toLowerCase()}`,
      baseCommit: this.caller.baseCommit,
    }));
  }

  freezeCandidate(
    worktree: FeatureTemporaryWorktree,
    handoff: FeatureCandidateHandoff,
  ): FrozenFeatureCandidate {
    assert.equal(handoff.role, worktree.role);
    assert.equal(handoff.worktreePath, worktree.path);
    assert.equal(handoff.branchRef, worktree.branchRef);
    assert.equal(handoff.baseCommit, worktree.baseCommit);
    assert.equal(handoff.candidateHeadCommit, CANDIDATE_COMMITS[worktree.role]);
    return {
      ...worktree,
      headCommit: handoff.candidateHeadCommit,
      changedPaths: handoff.changedPaths,
      boundedDiff: {
        text: `diff --git a/${handoff.changedPaths[0]} b/${handoff.changedPaths[0]}`,
        truncated: false,
        bytes: 64,
      },
      frozen: true,
    };
  }

  prepareSelectionDirectory() {
    return `${this.temporaryRoot}/selection`;
  }

  assertSelectionReadOnly(_candidates: ReadonlyArray<FrozenFeatureCandidate>) {
    this.selectionReadOnlyChecks++;
  }

  validateSelection(
    selection: FeatureSelection,
    _candidates: ReadonlyArray<FrozenFeatureCandidate>,
  ) {
    if (
      selection.augmentationCandidates.some(
        ({ sourceRole }) => sourceRole === selection.primaryCandidate,
      )
    ) {
      throw new Error(
        "Selection augmentation must originate from a losing candidate before synthesis mutation.",
      );
    }
  }

  createSynthesisWorktree(
    primary: FrozenFeatureCandidate,
  ): FeatureSynthesisWorktree {
    this.synthesisCreated++;
    return {
      path: `${this.temporaryRoot}/selection`,
      branchRef: "pipi-feature/test/synthesis",
      primaryRole: primary.role,
      primaryCommit: primary.headCommit,
    };
  }

  commitAssignedWorktree(role: string, _workingDir: string) {
    const candidate = candidateRoleFromSpec(role);
    return candidate ? CANDIDATE_COMMITS[candidate] : FINAL_SYNTHESIS_COMMIT;
  }

  validateSynthesis(
    worktree: FeatureSynthesisWorktree,
    provenance: FeatureSynthesisProvenance,
    _selection: FeatureSelection,
    _candidates: ReadonlyArray<FrozenFeatureCandidate>,
  ): ValidatedFeatureSynthesis {
    assert.equal(provenance.primaryCandidate, worktree.primaryRole);
    assert.equal(provenance.primaryCommit, worktree.primaryCommit);
    assert.equal(provenance.finalCommit, FINAL_SYNTHESIS_COMMIT);
    return {
      ...worktree,
      finalCommit: FINAL_SYNTHESIS_COMMIT,
      changedPaths: provenance.changedPaths,
    };
  }

  promote(synthesis: ValidatedFeatureSynthesis) {
    assert.equal(synthesis.finalCommit, FINAL_SYNTHESIS_COMMIT);
    this.promoted++;
  }

  cleanup() {
    this.cleaned++;
    return [];
  }
}

function candidateRoleFromSpec(role: string) {
  return FEATURE_CANDIDATE_ROLES.find(
    (candidate) => `candidate-${candidate.toLowerCase()}` === role,
  );
}

function featureGitHarness(
  lifecycles: FakeFeatureLifecycle[],
): FeatureGitOperations {
  return {
    preflight(workingDir) {
      let baseCommit = BASE_COMMIT;
      try {
        baseCommit = execFileSync("git", ["rev-parse", "HEAD"], {
          cwd: workingDir,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        }).trim();
      } catch {
        // Most controller fixtures intentionally use a synthetic workspace.
      }
      return {
        workingDir,
        repositoryRoot: workingDir,
        commonGitDir: "/tmp/repo/.git",
        branch: "feat/test",
        branchRef: "refs/heads/feat/test",
        baseCommit,
      };
    },
    createLifecycle(caller, runId) {
      const lifecycle = new FakeFeatureLifecycle(runId, caller);
      lifecycles.push(lifecycle);
      return lifecycle;
    },
  };
}

function harness(
  options: {
    rootGate?: Promise<void>;
    autoCompleteFeatureDiscovery?: boolean;
    autoCompleteDiscoverySynthesis?: boolean;
    autoCompleteCandidates?: boolean;
    autoCompleteSelectionAndSynthesis?: boolean;
  } = {},
) {
  const sessions: FakePipelineSession[] = [];
  const handoffs: PipelineHandoff[] = [];
  const lifecycles: FakeFeatureLifecycle[] = [];
  let agentSequence = 0;
  let runSequence = 0;
  let rootToolNames: string[] = [];
  const rootToolsByRun = new Map<string, ReadonlyArray<ToolDefinition>>();
  let discoverySubmitCallback:
    | ((
        runId: string,
        role: string,
        sessionToken: string,
        value: unknown,
      ) => void)
    | undefined;
  const controller = new PipelineController({
    makeRunId: () => `run-${++runSequence}`,
    makeAgentId: () => `node-${++agentSequence}`,
    createSessionFactory: (
      rootTools: (runId: string) => ReadonlyArray<ToolDefinition>,
      definitionForRun,
      _auditSubmit,
      _auditSessionCreated,
      _auditToolAllowed,
      discoverySubmit,
      discoverySessionCreated,
      discoveryToolAllowed,
    ) => {
      discoverySubmitCallback = discoverySubmit;
      return {
        async create(spec) {
          if (!spec.parentId && options.rootGate) await options.rootGate;
          const isImplementationRoot =
            !spec.parentId && spec.role === "pipeline-root";
          const configuredRootTools = isImplementationRoot
            ? rootTools(spec.scopeId ?? "")
            : [];
          const orchestration = configuredRootTools.map((tool) => tool.name);
          if (isImplementationRoot) {
            rootToolNames = orchestration;
            rootToolsByRun.set(spec.scopeId ?? "", configuredRootTools);
          }
          const candidateRole = candidateRoleFromSpec(spec.role);
          const autoReport =
            spec.role === FEATURE_DISCOVERY_SYNTHESIS_ROLE &&
            options.autoCompleteDiscoverySynthesis !== false
              ? JSON.stringify(discoverySynthesisResult())
              : candidateRole && options.autoCompleteCandidates !== false
                ? JSON.stringify(
                    candidateHandoff(
                      candidateRole,
                      spec,
                      lifecycles.find((lifecycle) =>
                        spec.cwd.startsWith(lifecycle.temporaryRoot),
                      )?.caller.baseCommit ?? BASE_COMMIT,
                    ),
                  )
                : spec.role === FEATURE_IMPLEMENTATION_SYNTHESIS_ROLE &&
                    options.autoCompleteSelectionAndSynthesis !== false
                  ? (turn: number) =>
                      JSON.stringify(
                        turn === 0
                          ? selectionResult()
                          : implementationSynthesisResult(),
                      )
                  : options.autoCompleteFeatureDiscovery !== false &&
                      spec.parentId &&
                      definitionForRun(spec.scopeId ?? "") ===
                        "feature-pipeline" &&
                      spec.role.startsWith("discover-")
                    ? reportForRole(spec.role)
                    : undefined;
          const discoveryAllowed =
            Boolean(spec.parentId) &&
            Boolean(discoverySubmit) &&
            Boolean(discoveryToolAllowed?.(spec.scopeId ?? "", spec.role));
          const discoveryToken = discoveryAllowed
            ? `token-${spec.scopeId}-${spec.role}-${spec.attempt}`
            : undefined;
          if (discoveryToken) {
            discoverySessionCreated?.(
              spec.scopeId ?? "",
              spec.role,
              discoveryToken,
            );
          }
          const session = new FakePipelineSession(
            !isImplementationRoot
              ? [
                  "read",
                  "fd",
                  "rg",
                  "web_search_codex",
                  "web_fetch_codex",
                  ...(discoveryAllowed ? ["pipeline_discovery_submit"] : []),
                ]
              : ["read", "bash", "edit", "write", ...orchestration],
            spec,
            autoReport,
            discoveryToken
              ? (value) =>
                  discoverySubmit?.(
                    spec.scopeId ?? "",
                    spec.role,
                    discoveryToken,
                    value,
                  )
              : undefined,
          );
          sessions.push(session);
          return session;
        },
      };
    },
    onHandoff: (handoff) => {
      handoffs.push(handoff);
    },
    featureGit: featureGitHarness(lifecycles),
  });
  return {
    controller,
    sessions,
    handoffs,
    lifecycles,
    get rootToolNames() {
      return rootToolNames;
    },
    rootTool(runId: string, name: string) {
      return rootToolsByRun.get(runId)?.find((tool) => tool.name === name);
    },
    submitUnauthorized(role: string, value: unknown) {
      assert.ok(discoverySubmitCallback);
      discoverySubmitCallback("run-1", role, "unauthorized-token", value);
    },
  };
}

const request = (workingDir = "/tmp/work") => ({
  task: "Implement the approved feature",
  workingDir,
  gitCommit: true,
});

test("feature invocation rejects git_commit false or omission before Git lifecycle or sessions", async () => {
  const run = harness();
  assert.throws(
    () =>
      run.controller.start({
        task: "Implement the approved feature",
        workingDir: "/tmp/work",
        pipeline: "feature-pipeline",
        gitCommit: false,
      }),
    /requires explicit git_commit: true/,
  );
  assert.throws(
    () =>
      run.controller.start({
        task: "Implement the approved feature",
        workingDir: "/tmp/work",
        pipeline: "feature-pipeline",
      }),
    /requires explicit git_commit: true/,
  );
  assert.equal(run.sessions.length, 0);
  assert.equal(run.lifecycles.length, 0);
  await run.controller.dispose();
});

test("git_commit keeps plan/audit rejection and small-feature acceptance", async () => {
  const run = harness();
  for (const pipeline of ["plan-pipeline", "audit-pipeline"] as const) {
    assert.throws(
      () => run.controller.start({ ...request(), pipeline, gitCommit: true }),
      new RegExp(
        `git_commit is only supported for feature-pipeline and small-feature-pipeline.*${pipeline}`,
      ),
    );
  }
  const smallFeatureId = run.controller.start({
    ...request(),
    pipeline: "small-feature-pipeline",
    gitCommit: true,
  });
  await settleInitialization();
  assert.equal(run.controller.get(smallFeatureId)?.status, "running");
  await run.controller.dispose();
});

async function settleInitialization() {
  for (let turn = 0; turn < 5; turn++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function discoverySynthesisResult() {
  return {
    reportType: "feature-discovery-synthesis-v1" as const,
    summary: "Synthesized all validated discovery tracks",
    featureContract:
      "Implement the approved feature without changing neighboring pipelines.",
    acceptanceCriteria: [
      {
        scenario: "Best-of-3 implementation completes",
        expected: "The exact verified synthesized state is promoted",
        verification: "Inspect controller lifecycle evidence",
      },
    ],
    constraints: ["Preserve the hardcoded feature-pipeline graph"],
    nonGoals: ["Do not repeat discovery"],
    precedents: [
      {
        reference: "extensions/pipelines/controller.ts",
        discoveryDetail:
          "Controller behavior provides direct repository evidence",
        finding: "Controller-owned fan-in is the established precedent",
      },
    ],
    relevantPaths: ["extensions/pipelines/controller.ts"],
    contractsInvariants: ["Selection happens before synthesis writes"],
    risks: ["Caller worktree drift must prevent promotion"],
    unknowns: ["Live provider availability is not exercised by this fixture"],
    assumptions: ["Validated discovery reports are complete"],
    verificationExpectations: ["Run deterministic repository checks"],
  };
}

function candidateHandoff(
  role: FeatureCandidateRole,
  spec: AgentNodeSpec,
  baseCommit = BASE_COMMIT,
) {
  const changedPath = `src/${role.toLowerCase()}.ts`;
  return {
    reportType: "feature-implementation-candidate-v1" as const,
    role,
    approachSummary: `${role} complete implementation`,
    changedPaths: [changedPath],
    checks: ["focused test passed"],
    assumptions: [],
    tradeoffs: ["Role objective was applied without sacrificing correctness"],
    unresolvedIssues: [],
    worktreePath: spec.cwd,
    branchRef: `pipi-feature/test/candidate-${role.toLowerCase()}`,
    baseCommit,
    candidateHeadCommit: CANDIDATE_COMMITS[role],
  };
}

function comparison(role: FeatureCandidateRole) {
  return {
    role,
    criteria: {
      correctness: "Meets the feature contract",
      acceptanceCoverage: "Covers the observable criterion",
      regressionRisk: "Focused and verified",
      repositoryFit: "Uses repository patterns",
      simplicity:
        role === "Minimal" ? "Simplest reliable candidate" : "More involved",
      maintainability: "Maintainable within scope",
      verificationQuality: "Focused check passed",
    },
    usableBase: true,
  };
}

function selectionResult() {
  return {
    reportType: "feature-implementation-selection-v1" as const,
    selectionOnlyAcknowledgement:
      "No code was written before primary selection." as const,
    comparisons: FEATURE_CANDIDATE_ROLES.map(comparison),
    primaryCandidate: "Minimal" as const,
    rationale:
      "Minimal is the simplest candidate that fully and reliably solves the task.",
    augmentationCandidates: [],
  };
}

function implementationSynthesisResult() {
  return {
    reportType: "feature-implementation-synthesis-v1" as const,
    primaryCandidate: "Minimal" as const,
    primaryCommit: CANDIDATE_COMMITS.Minimal,
    acceptedAugmentations: [],
    rejectedAugmentations: [],
    changedPaths: [],
    checks: [
      `npm test passed; WINNER_MARKER Minimal borrowed idea ${FINAL_SYNTHESIS_COMMIT}`,
    ],
    assumptions: [],
    unresolvedIssues: [],
    finalCommit: FINAL_SYNTHESIS_COMMIT,
  };
}

function reportForRole(role: string) {
  if (role === "implement-small-feature") {
    return JSON.stringify({
      summary: "Implemented and verified the bounded feature",
      changedPaths: ["src/feature.ts"],
      checks: ["focused tests passed"],
      assumptions: [],
      unresolvedItems: [],
    });
  }
  const featureDiscoveryRole = FEATURE_PIPELINE_DISCOVERY_ROLES.find(
    (candidate) => candidate === role,
  );
  if (featureDiscoveryRole) {
    const evidence = [
      {
        kind: "code",
        reference: "extensions/pipelines/controller.ts",
        detail: "Controller behavior provides direct repository evidence",
      },
    ];
    const candidateAcceptanceCriteria = [
      {
        scenario: "A feature discovery report settles",
        expected: "The host receives observable bounded evidence",
        verification: "Validate the parsed report before build activation",
        evidence,
      },
      {
        scenario: "Discovery evidence is incomplete",
        expected: "The report remains explicit and actionable",
        verification: "Inspect the validated report status and evidence",
        evidence,
      },
    ];
    return JSON.stringify({
      reportType: "feature-discovery-v2",
      role: featureDiscoveryRole,
      applicability: "applicable",
      summary: `${role} repository evidence`,
      coverage: FEATURE_DISCOVERY_COVERAGE[featureDiscoveryRole].map(
        (criterion) => ({
          criterion,
          status: "covered",
          conclusion: `${criterion} is covered by repository evidence`,
          evidence,
          implications: [],
        }),
      ),
      candidateAcceptanceCriteria:
        featureDiscoveryRole === "discover-outcome" ||
        featureDiscoveryRole === "discover-user-scenarios"
          ? candidateAcceptanceCriteria
          : [],
      unknowns: [],
      constraints: [],
    });
  }
  if (role.startsWith("discover-")) {
    return JSON.stringify({
      summary: role,
      evidence: ["repository evidence"],
      unknowns: [],
      constraints: [],
    });
  }
  if (role === EXECUTOR_AUDIT_ROLE) {
    return JSON.stringify({
      track: role,
      executedChecks: [
        {
          command: "npm run check",
          status: "passed",
          exitCode: 0,
          evidence: "Type check passed.",
        },
      ],
      workspaceChangesObserved: [],
      findings: [],
      unprovenChecks: [],
    });
  }
  if (role === "final-audit") {
    return JSON.stringify({
      mode: "initial",
      base_sha: "1234567",
      head_sha: "WORKTREE",
      verdict: "READY",
      findings: [],
      summary: "No actionable findings",
    });
  }
  return JSON.stringify({ track: role, findings: [], unprovenChecks: [] });
}

function featureDiscoveryValue(
  role: (typeof FEATURE_PIPELINE_DISCOVERY_ROLES)[number],
) {
  return JSON.parse(reportForRole(role)) as unknown;
}

function settleRole(run: ReturnType<typeof harness>, role: string) {
  const session = run.sessions.find(
    (candidate) => candidate.spec.role === role,
  );
  assert.ok(session);
  session.emit({
    type: "settled",
    outcome: { type: "completed", finalText: reportForRole(role) },
  });
}

function synthesisReport(
  reportType: "audit-synthesis-intermediate" | "audit-synthesis-final",
  integratedRoles: ReadonlyArray<string>,
  gitIdentity: { baseSha: string; headSha: string } = {
    baseSha: "UNAVAILABLE",
    headSha: "UNAVAILABLE",
  },
  findings: ReadonlyArray<Record<string, unknown>> = [],
) {
  if (reportType === "audit-synthesis-intermediate") {
    return JSON.stringify({
      reportType,
      integratedRoles,
      rootCauseCandidates: [],
      unresolvedConflicts: [],
      unprovenChecks: [],
      executedChecks: [],
      workspaceChangesObserved: [],
      hostWorkspaceObservation: null,
      summary: "Incremental synthesis retained validated evidence",
    });
  }
  return JSON.stringify({
    reportType,
    mode: "initial",
    baseSha: gitIdentity.baseSha,
    headSha: gitIdentity.headSha,
    integratedRoles,
    findings: findings.map(({ id: _id, ...finding }) => finding),
    closureResults: [],
    unresolvedConflicts: [],
    unprovenChecks: [],
    executedChecks: [],
    workspaceChangesObserved: [],
    hostWorkspaceObservation: {
      capturedAfterExecutor: true,
      workspaceChanged: false,
      statusBefore: { state: "available", value: "" },
      statusAfter: { state: "available", value: "" },
      dirtyDiffAfter: { state: "available", value: "" },
      combinedDiffAfter: { state: "available", value: "" },
      summary: "Fresh host observation completed.",
    },
    summary: "No supported findings",
  });
}

function finalAuditFinding(id = "AUD-001") {
  return {
    id,
    title: "Concrete final blocker",
    scenario: "The affected path is exercised",
    expected: "The required invariant holds",
    actual: "The invariant is violated",
    affectedPaths: ["extensions/pipelines/controller.ts"],
    relationship: "introduced",
    evidenceType: "static",
    evidence: "The validated audit found a concrete reachable defect.",
    impact: 3,
    confidence: 99,
    minimalNextAction: "Fix the defect and rerun its focused check.",
    sourceRoles: [AUDIT_SEGMENT_LUNA_ROLES[0]],
    scope: "initial",
    scopeReference: "task",
  };
}

async function finishEmbeddedAudit(
  run: ReturnType<typeof harness>,
  runId: string,
  deliverFinalReport = true,
  findings: ReadonlyArray<Record<string, unknown>> = [],
) {
  run.controller.setStage(runId, "final-audit");
  const agents = await run.controller.startFinalAudit(runId, {
    acceptanceContract: "The approved feature contract",
    assumptions: [],
    checks: ["focused checks passed"],
  });
  const firstRole = AUDIT_SEGMENT_LUNA_ROLES[0];
  const first =
    run.sessions.find(
      (session) => session.spec.role === firstRole && session.spec.attempt > 1,
    ) ?? run.sessions.find((session) => session.spec.role === firstRole);
  assert.ok(first);
  const firstReport = JSON.parse(reportForRole(firstRole)) as Record<
    string,
    unknown
  >;
  first.emit({
    type: "settled",
    outcome: {
      type: "completed",
      finalText: JSON.stringify({
        ...firstReport,
        findings: findings.map(
          ({
            id: _id,
            sourceRoles: _roles,
            scope: _scope,
            scopeReference: _reference,
            ...finding
          }) => finding,
        ),
      }),
    },
  });
  await settleInitialization();
  for (const role of AUDIT_SEGMENT_LUNA_ROLES.slice(1)) {
    const session = [...run.sessions]
      .reverse()
      .find((candidate) => candidate.spec.role === role);
    assert.ok(session);
    session.emit({
      type: "settled",
      outcome: { type: "completed", finalText: reportForRole(role) },
    });
  }
  const synthesizer = run.sessions.find(
    (session) => session.spec.role === "audit-synthesis",
  );
  assert.ok(synthesizer);
  synthesizer.emit({
    type: "settled",
    outcome: {
      type: "completed",
      finalText: synthesisReport("audit-synthesis-intermediate", [firstRole]),
    },
  });
  await settleInitialization();
  let headSha = "UNAVAILABLE";
  try {
    headSha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: synthesizer.spec.cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch {
    // Non-Git fixtures intentionally use unavailable identity.
  }
  synthesizer.emit({
    type: "settled",
    outcome: {
      type: "completed",
      finalText: synthesisReport(
        "audit-synthesis-final",
        AUDIT_SEGMENT_LUNA_ROLES,
        {
          baseSha:
            run.controller.get(runId)?.definition === "feature-pipeline"
              ? (run.lifecycles.find((lifecycle) =>
                  lifecycle.temporaryRoot.includes(runId),
                )?.caller.baseCommit ?? BASE_COMMIT)
              : headSha,
          headSha,
        },
        findings,
      ),
    },
  });
  await settleInitialization();
  assert.equal(run.controller.get(runId)?.stage, "final-resolve");
  assert.equal(agents.length, 6);
  if (deliverFinalReport) {
    const waitTool = run.rootTool(runId, "pipeline_child_wait");
    assert.ok(waitTool);
    const synthesisNode = run.controller.agentView
      .list()
      .find((agent) => agent.role === "audit-synthesis");
    assert.ok(synthesisNode);
    await waitTool.execute(
      "final-audit-wait",
      { ids: [synthesisNode.id] },
      undefined,
      undefined,
      {} as ExtensionContext,
    );
  }
}

async function advancePlanToComplete(
  run: ReturnType<typeof harness>,
  runId: string,
  planPath: string,
) {
  await Promise.all(
    PLAN_PIPELINE_DISCOVERY_ROLES.map((role) =>
      run.controller.spawnChild(runId, role),
    ),
  );
  PLAN_PIPELINE_DISCOVERY_ROLES.forEach((role) => settleRole(run, role));
  run.controller.setStage(runId, "build");
  run.controller.writePlan(runId, planPath, validPlan());
  run.controller.setStage(runId, "audit");
  await Promise.all(
    PLAN_PIPELINE_AUDIT_ROLES.map((role) =>
      run.controller.spawnChild(runId, role),
    ),
  );
  PLAN_PIPELINE_AUDIT_ROLES.forEach((role) => settleRole(run, role));
  run.controller.setStage(runId, "audit-resolve");
  await finishEmbeddedAudit(run, runId);
  run.controller.setStage(runId, "complete");
}

function validPlan() {
  return `# Implementation plan

## Goal and non-goals
Goal; non-goal.

## Evidence and assumptions
Evidence; assumption.

## Candidate acceptance criteria
- AC1

## Frontend tasks
Not applicable.

## Backend tasks
Not applicable.

## DevOps tasks
Not applicable.

## Cross-cutting tasks
### TASK-001: Update the package
- **Scope:** Make the bounded change.
- **Likely paths/components:** src/example.ts
- **Dependencies:** None.
- **Acceptance/verification evidence:** Focused test passes.

## Test plan
- Unit checks apply.
- Integration checks are not applicable.
- Contract checks are not applicable.
- E2E checks are not applicable.
- Operational checks are not applicable.

## Implementation waves
- Wave 1: TASK-001

## Risks, rollout, and rollback
Low risk; revert TASK-001 if needed.

## Unresolved questions
None.
`;
}

test("start is fire-and-forget and multiple same-cwd runs are admitted", async () => {
  let releaseRoot = () => {};
  const rootGate = new Promise<void>((resolve) => {
    releaseRoot = resolve;
  });
  const gated = harness({ rootGate });
  const firstId = gated.controller.start(request());
  const secondId = gated.controller.start(request());

  assert.equal(firstId, "run-1");
  assert.equal(secondId, "run-2");
  assert.equal(gated.controller.get(firstId)?.status, "starting");
  assert.equal(gated.controller.get(secondId)?.workingDir, "/tmp/work");
  releaseRoot();
  await settleInitialization();
  assert.equal(gated.controller.get(firstId)?.status, "running");
  assert.equal(gated.controller.get(secondId)?.status, "running");
  assert.equal(gated.sessions.length, 22);
  assert.equal(
    gated.sessions
      .filter((session) => session.spec.role === "pipeline-root")
      .every(
        (session) => session.prompts.length === 0 && session.sends.length === 1,
      ),
    true,
  );

  await gated.controller.dispose();
});

test("feature discovery fan-in feeds three parallel Luna/xHIGH candidates with identical complete context", async () => {
  const run = harness({
    autoCompleteFeatureDiscovery: false,
    autoCompleteDiscoverySynthesis: false,
  });
  const runId = run.controller.start(request());
  await settleInitialization();

  const synthesis = run.sessions.find(
    (session) => session.spec.role === FEATURE_DISCOVERY_SYNTHESIS_ROLE,
  );
  assert.ok(synthesis);
  assert.equal(synthesis.prompts.length, 0);
  assert.equal(synthesis.sends.length, 0);
  assert.equal(
    run.sessions.some((session) => candidateRoleFromSpec(session.spec.role)),
    false,
  );

  for (const role of [...FEATURE_PIPELINE_DISCOVERY_ROLES].reverse()) {
    settleRole(run, role);
  }
  await settleInitialization();
  assert.equal(synthesis.sends.length, 1);
  let priorIndex = -1;
  for (const role of FEATURE_PIPELINE_DISCOVERY_ROLES) {
    const index = (synthesis.sends[0] ?? "").indexOf(`\"role\":\"${role}\"`);
    assert.ok(index > priorIndex, role);
    priorIndex = index;
  }

  synthesis.emit({
    type: "settled",
    outcome: {
      type: "completed",
      finalText: JSON.stringify(discoverySynthesisResult()),
    },
  });
  await settleInitialization();

  const candidates = run.sessions.filter((session) =>
    candidateRoleFromSpec(session.spec.role),
  );
  assert.equal(candidates.length, 3);
  assert.deepEqual(
    candidates.map((session) => candidateRoleFromSpec(session.spec.role)),
    [...FEATURE_CANDIDATE_ROLES],
  );
  assert.equal(
    candidates.every(
      (session) =>
        session.spec.model === LUNA_MODEL &&
        session.spec.thinkingLevel === "xhigh" &&
        session.prompts.length === 1,
    ),
    true,
  );
  assert.equal(new Set(candidates.map((session) => session.spec.cwd)).size, 3);
  const packages = candidates.map(
    (session) =>
      (session.prompts[0] ?? "")
        .split("COMMON_PREPARED_DISCOVERY_PACKAGE:\n")[1]
        ?.split("\nEND_COMMON_PREPARED_DISCOVERY_PACKAGE")[0],
  );
  assert.equal(packages.every(Boolean), true);
  assert.equal(new Set(packages).size, 1);
  assert.match(packages[0] ?? "", /Implement the approved feature/);
  for (const role of FEATURE_PIPELINE_DISCOVERY_ROLES) {
    assert.match(packages[0] ?? "", new RegExp(role));
  }
  assert.match(packages[0] ?? "", /verificationExpectations/);
  assert.equal(run.controller.get(runId)?.stage, "build");
  assert.equal(run.lifecycles[0]?.promoted, 1);
  assert.equal(run.lifecycles[0]?.cleaned, 1);

  const implementationSynthesis = run.sessions.filter(
    (session) => session.spec.role === FEATURE_IMPLEMENTATION_SYNTHESIS_ROLE,
  );
  assert.equal(implementationSynthesis.length, 1);
  assert.equal(implementationSynthesis[0]?.spec.model, LUNA_MODEL);
  assert.equal(implementationSynthesis[0]?.spec.thinkingLevel, "xhigh");
  assert.equal(implementationSynthesis[0]?.prompts.length, 1);
  assert.equal(implementationSynthesis[0]?.sends.length, 1);
  const root = run.sessions.find(
    (session) => session.spec.role === "pipeline-root",
  );
  assert.ok(root);
  assert.doesNotMatch(root.sends[0] ?? "", /bbbbbbbb|"primaryCandidate"/);
  assert.doesNotMatch(
    root.sends[0] ?? "",
    /WINNER_MARKER|dddddddd|npm test passed/,
  );
  assert.match(
    root.sends[0] ?? "",
    /reported 1 verification check\(s\).*text is withheld/,
  );

  for (const candidate of candidates) {
    const node = run.controller.agentView
      .list()
      .find((item) => item.role === candidate.spec.role);
    assert.ok(node);
    const sendsBefore = candidate.sends.length;
    const interruptsBefore = candidate.interrupted;
    run.controller.agentView.requestSend(node.id, "restart frozen candidate");
    run.controller.agentView.requestCancel(node.id);
    await settleInitialization();
    assert.equal(candidate.sends.length, sendsBefore);
    assert.equal(candidate.interrupted, interruptsBefore);
  }

  await run.controller.dispose();
});

test("Best-of-3 provenance is retained internally but excluded from pre-final and final audit prompts", async () => {
  const run = harness();
  const runId = run.controller.start(request());
  await settleInitialization();
  run.controller.setStage(runId, "audit");
  const child = await run.controller.spawnChild(
    runId,
    "audit-feature-outcome",
    "WINNER_MARKER primaryCandidate Minimal bbbbbbbb borrowed idea",
  );
  const preFinal = run.sessions.find(
    (session) =>
      session.spec.role === child.role &&
      session.spec.attempt === child.attempt,
  );
  assert.ok(preFinal);
  assert.doesNotMatch(
    preFinal.prompts[0] ?? "",
    /WINNER_MARKER|"primaryCandidate"|bbbbbbbb|pipi-feature\/test\/candidate/,
  );
  assert.match(preFinal.prompts[0] ?? "", /reviewedState/);

  run.controller.setStage(runId, "final-audit");
  const finalAgents = await run.controller.startFinalAudit(runId, {
    acceptanceContract: "WINNER_MARKER primaryCandidate Minimal",
    assumptions: ["borrowed idea from Robust"],
    checks: ["candidate commit bbbbbbbb"],
  });
  assert.equal(finalAgents.length, 6);
  const finalTrack = run.sessions.find(
    (session) =>
      session.spec.role === "audit-logic-invariants" &&
      session.spec.attempt === 1,
  );
  assert.ok(finalTrack);
  assert.doesNotMatch(
    finalTrack.prompts[0] ?? "",
    /WINNER_MARKER|"primaryCandidate"|bbbbbbbb|borrowed idea/,
  );
  assert.match(
    finalTrack.prompts[0] ?? "",
    /reported 1 verification check\(s\).*text is withheld/,
  );
  await run.controller.dispose();
});

test("selection is read-only before the same Luna agent receives primary-based augmentation", async () => {
  const run = harness({ autoCompleteSelectionAndSynthesis: false });
  const runId = run.controller.start(request());
  await settleInitialization();

  const synthesis = run.sessions.find(
    (session) => session.spec.role === FEATURE_IMPLEMENTATION_SYNTHESIS_ROLE,
  );
  assert.ok(synthesis);
  assert.equal(run.controller.get(runId)?.stage, "discover");
  assert.equal(run.lifecycles[0]?.selectionReadOnlyChecks, 0);
  assert.equal(run.lifecycles[0]?.synthesisCreated, 0);
  assert.match(synthesis.prompts[0] ?? "", /selection-only and read-only/i);
  assert.match(
    synthesis.prompts[0] ?? "",
    /correctness, acceptance coverage, regression risk, repository fit, simplicity, maintainability, verification quality/,
  );

  synthesis.emit({
    type: "settled",
    outcome: {
      type: "completed",
      finalText: JSON.stringify(selectionResult()),
    },
  });
  await settleInitialization();
  assert.equal(run.lifecycles[0]?.selectionReadOnlyChecks, 1);
  assert.equal(run.lifecycles[0]?.synthesisCreated, 1);
  assert.equal(synthesis.sends.length, 1);
  assert.equal(synthesis.mutationEnabled, 1);
  assert.match(
    synthesis.sends[0] ?? "",
    /starting from that immutable primary commit/,
  );
  assert.match(
    synthesis.sends[0] ?? "",
    /do not silently write a fourth implementation/i,
  );

  synthesis.emit({
    type: "settled",
    outcome: {
      type: "completed",
      finalText: JSON.stringify(implementationSynthesisResult()),
    },
  });
  await settleInitialization();
  assert.equal(run.controller.get(runId)?.stage, "build");
  assert.equal(
    run.sessions.filter(
      (session) => session.spec.role === FEATURE_IMPLEMENTATION_SYNTHESIS_ROLE,
    ).length,
    1,
  );
  assert.equal(run.lifecycles[0]?.promoted, 1);
  await run.controller.dispose();
});

test("invalid selection is corrected in the same session and no fourth implementation is created", async () => {
  const run = harness({ autoCompleteSelectionAndSynthesis: false });
  const runId = run.controller.start(request());
  await settleInitialization();
  const synthesis = run.sessions.find(
    (session) => session.spec.role === FEATURE_IMPLEMENTATION_SYNTHESIS_ROLE,
  );
  assert.ok(synthesis);

  synthesis.emit({
    type: "settled",
    outcome: {
      type: "completed",
      finalText: JSON.stringify({
        ...selectionResult(),
        augmentationCandidates: [
          {
            sourceRole: "Minimal",
            idea: "Reuse the selected primary as an augmentation",
            objectiveBenefit: "None",
            evidence: "Primary candidate diff",
            sourcePaths: ["src/minimal.ts"],
          },
        ],
      }),
    },
  });
  await settleInitialization();
  assert.equal(run.controller.get(runId)?.status, "running");
  assert.equal(run.lifecycles[0]?.synthesisCreated, 0);
  assert.equal(synthesis.mutationEnabled, 0);
  assert.equal(synthesis.sends.length, 1);

  for (let rejection = 2; rejection <= 3; rejection++) {
    synthesis.emit({
      type: "settled",
      outcome: { type: "completed", finalText: `invalid-${rejection}` },
    });
    await settleInitialization();
    assert.equal(run.controller.get(runId)?.status, "running");
    assert.equal(synthesis.sends.length, rejection);
    assert.equal(
      run.sessions.filter((session) => candidateRoleFromSpec(session.spec.role))
        .length,
      3,
    );
  }
  synthesis.emit({
    type: "settled",
    outcome: { type: "completed", finalText: "invalid-four" },
  });
  await settleInitialization();
  assert.equal(run.controller.get(runId)?.status, "failed");
  assert.match(
    run.controller.get(runId)?.error ?? "",
    /rejected settled turn 4/,
  );
  assert.equal(run.lifecycles[0]?.promoted, 0);
  assert.ok((run.lifecycles[0]?.cleaned ?? 0) >= 1);
  await run.controller.dispose();
});

test("feature cancellation cleans only the run lifecycle without promotion", async () => {
  const run = harness({ autoCompleteFeatureDiscovery: false });
  const runId = run.controller.start(request());
  await settleInitialization();
  await run.controller.cancelRun(runId);
  assert.equal(run.controller.get(runId)?.status, "cancelled");
  assert.equal(run.lifecycles[0]?.promoted, 0);
  assert.ok((run.lifecycles[0]?.cleaned ?? 0) >= 1);
  await run.controller.dispose();
});

test("feature discovery tool payload is bound to its session and consumed only after settlement", async () => {
  const run = harness({ autoCompleteFeatureDiscovery: false });
  const runId = run.controller.start(request());
  await settleInitialization();

  for (const role of FEATURE_PIPELINE_DISCOVERY_ROLES.slice(1)) {
    settleRole(run, role);
  }
  const problem = run.sessions.find(
    (session) => session.spec.role === "discover-problem",
  );
  assert.ok(problem?.discoverySubmit);
  assert.throws(
    () =>
      run.submitUnauthorized(
        "discover-problem",
        featureDiscoveryValue("discover-problem"),
      ),
    /session is not registered/,
  );
  problem.discoverySubmit(featureDiscoveryValue("discover-problem"));
  assert.throws(
    () => problem.discoverySubmit?.(featureDiscoveryValue("discover-problem")),
    /already recorded a submission/,
  );
  assert.equal(run.controller.get(runId)?.stage, "discover");
  assert.equal(
    run.sessions.some((session) => session.spec.role === "pipeline-root"),
    false,
  );

  problem.emit({
    type: "settled",
    outcome: {
      type: "completed",
      finalText: "Tool result text is not the compatibility report",
    },
  });
  await settleInitialization();

  assert.equal(run.controller.get(runId)?.stage, "build");
  const candidate = run.sessions.find(
    (session) => session.spec.role === "candidate-minimal",
  );
  assert.equal(candidate?.prompts.length, 1);
  assert.match(candidate?.prompts[0] ?? "", /"submission":"tool"/);
  assert.match(
    candidate?.prompts[0] ?? "",
    /"reportType":"feature-discovery-v2"/,
  );
  await run.controller.dispose();
});

test("feature discovery submission scope is fixed to active feature discovery roles", () => {
  assert.equal(
    pipelineDiscoverySubmissionAllowed(
      "feature-pipeline",
      "discover-problem",
      "discover",
      false,
    ),
    true,
  );
  assert.equal(
    pipelineDiscoverySubmissionAllowed(
      "plan-pipeline",
      "discover-goal-outcomes",
      "discover",
      false,
    ),
    false,
  );
  assert.equal(
    pipelineDiscoverySubmissionAllowed(
      "feature-pipeline",
      "discover-problem",
      "build",
      false,
    ),
    false,
  );
  assert.equal(
    pipelineDiscoverySubmissionAllowed(
      "feature-pipeline",
      "discover-problem",
      "discover",
      true,
    ),
    false,
  );
});

test("programmatic feature discovery retries one malformed report in the same session", async () => {
  const run = harness({ autoCompleteFeatureDiscovery: false });
  const runId = run.controller.start(request());
  await settleInitialization();

  for (const role of [
    "discover-outcome",
    "discover-context",
    "discover-user-scenarios",
    "discover-product-precedents",
  ]) {
    settleRole(run, role);
  }
  const problem = run.sessions.find(
    (session) => session.spec.role === "discover-problem",
  );
  assert.ok(problem);
  problem.emit({
    type: "settled",
    outcome: { type: "completed", finalText: "not-json" },
  });
  await settleInitialization();

  assert.equal(run.controller.get(runId)?.stage, "discover");
  assert.equal(problem.sends.length, 1);
  assert.match(problem.sends[0] ?? "", /correction 1\/3/);
  problem.emit({
    type: "settled",
    outcome: {
      type: "completed",
      finalText: reportForRole("discover-problem"),
    },
  });
  await settleInitialization();

  assert.equal(run.controller.get(runId)?.stage, "build");
  assert.equal(
    run.sessions.find((session) => session.spec.role === "pipeline-root")?.sends
      .length,
    1,
  );
  await run.controller.dispose();
});

test("feature discovery uses independent correction counters and fails on rejection four", async () => {
  const run = harness({ autoCompleteFeatureDiscovery: false });
  const runId = run.controller.start(request());
  await settleInitialization();

  for (const role of [
    "discover-outcome",
    "discover-user-scenarios",
    "discover-product-precedents",
  ]) {
    settleRole(run, role);
  }
  const problem = run.sessions.find(
    (session) => session.spec.role === "discover-problem",
  );
  const context = run.sessions.find(
    (session) => session.spec.role === "discover-context",
  );
  assert.ok(problem);
  assert.ok(context);

  for (let rejection = 1; rejection <= 3; rejection++) {
    problem.emit({
      type: "settled",
      outcome: {
        type: "completed",
        finalText: `not-json-${rejection}`,
      },
    });
    await settleInitialization();
    assert.equal(run.controller.get(runId)?.status, "running");
    assert.equal(run.controller.get(runId)?.stage, "discover");
    assert.equal(problem.sends.length, rejection);
    assert.match(
      problem.sends.at(-1) ?? "",
      new RegExp(`correction ${rejection}/3`),
    );
    assert.equal(context.interrupted, 0);
  }

  problem.emit({
    type: "settled",
    outcome: { type: "completed", finalText: "fourth-invalid-report" },
  });
  await settleInitialization();

  assert.equal(run.controller.get(runId)?.status, "failed");
  assert.match(
    run.controller.get(runId)?.error ?? "",
    /rejected settled turn 4/,
  );
  assert.equal(context.interrupted, 1);
  assert.equal(
    run.sessions.some((session) => session.spec.role === "pipeline-root"),
    false,
  );
  await run.controller.dispose();
});

test("dashboard cancellation of a starting run prevents its root prompt", async () => {
  let releaseRoot = () => {};
  const rootGate = new Promise<void>((resolve) => {
    releaseRoot = resolve;
  });
  const run = harness({ rootGate });
  const runId = run.controller.start(request());
  const runRow = buildPipelineRows([run.controller.get(runId)!]).find(
    (row) => row.kind === "run" && row.runId === runId,
  );
  assert.ok(runRow);

  await cancelPipelineRow(run.controller, runRow);
  assert.equal(run.controller.get(runId)?.status, "cancelled");
  assert.equal(run.handoffs.length, 1);

  releaseRoot();
  await settleInitialization();

  assert.equal(run.sessions.length, 1);
  assert.equal(run.sessions[0]?.prompts.length, 0);
  assert.equal(run.sessions[0]?.disposed, 1);
  assert.equal(run.controller.get(runId)?.rootId, "node-1");
  assert.equal(run.controller.get(runId)?.agents[0]?.status, "cancelled");
  assert.equal(
    run.controller
      .get(runId)
      ?.agents.some(
        (agent) => agent.status === "starting" || agent.status === "running",
      ),
    false,
  );
  assert.equal(run.handoffs.length, 1);
  await run.controller.dispose();
});

test("root tools are run-scoped and feature discovery children are read-only", async () => {
  const run = harness();
  const runId = run.controller.start(request());
  await settleInitialization();

  assert.equal(run.controller.get(runId)?.agents.length, 11);
  assert.deepEqual(run.rootToolNames, [
    "pipeline_stage",
    "pipeline_child_spawn",
    "pipeline_child_list",
    "pipeline_child_check",
    "pipeline_child_wait",
    "pipeline_child_send",
    "pipeline_child_cancel",
    "pipeline_audit_start",
    "pipeline_complete",
  ]);
  const childSession = run.sessions.find(
    (session) => session.spec.role === "discover-problem",
  );
  assert.deepEqual(childSession?.activeTools, [
    "read",
    "fd",
    "rg",
    "web_search_codex",
    "web_fetch_codex",
    "pipeline_discovery_submit",
  ]);
  for (const mutator of [
    "bash",
    "edit",
    "write",
    "apply_patch_codex",
    "codex_task",
    "mcp",
    "bg_start",
    "ask_user",
  ]) {
    assert.equal(childSession?.activeTools.includes(mutator), false);
  }
  for (const forbidden of [
    "pipeline_run",
    "pipeline_check",
    "pipeline_list",
    "pipeline_child_spawn",
    "workflow",
    "subagent_spawn",
  ]) {
    assert.equal(childSession?.activeTools.includes(forbidden), false);
  }

  await run.controller.dispose();
});

test("definition role policies centralize child context requirements", () => {
  for (const role of STATIC_LUNA_AUDIT_ROLES) {
    assert.deepEqual(childContextPolicyFor("feature-pipeline", role), {
      gitEvidence: true,
    });
    assert.deepEqual(childContextPolicyFor("audit-pipeline", role), {
      gitEvidence: true,
    });
  }
  assert.deepEqual(
    childContextPolicyFor("feature-pipeline", FINAL_AUDIT_ROLE),
    {},
  );
  for (const role of STATIC_LUNA_AUDIT_ROLES) {
    assert.deepEqual(childContextPolicyFor("small-feature-pipeline", role), {
      gitEvidence: true,
      priorReportRole: SMALL_FEATURE_IMPLEMENTER_ROLE,
    });
  }
  assert.deepEqual(
    childContextPolicyFor("feature-pipeline", "discover-problem"),
    {},
  );
  assert.deepEqual(
    childContextPolicyFor("plan-pipeline", "audit-decomposition-dag"),
    {},
  );
});

test("feature root retains commit-capable tools while every child stays constrained", () => {
  const rootDenied = new Set<string>(
    pipelineSessionToolPolicy("feature-pipeline", true, "pipeline-root")
      .excludeTools,
  );
  for (const rootTool of ["bash", "edit", "write"]) {
    assert.equal(rootDenied.has(rootTool), false);
  }

  const discoverySynthesisDenied = new Set<string>(
    pipelineSessionToolPolicy(
      "feature-pipeline",
      true,
      FEATURE_DISCOVERY_SYNTHESIS_ROLE,
    ).excludeTools,
  );
  for (const mutator of ["bash", "edit", "write", "pipeline_child_spawn"]) {
    assert.equal(discoverySynthesisDenied.has(mutator), true);
  }
  for (const role of [
    "candidate-minimal",
    FEATURE_IMPLEMENTATION_SYNTHESIS_ROLE,
  ]) {
    const denied = new Set<string>(
      pipelineSessionToolPolicy("feature-pipeline", false, role).excludeTools,
    );
    for (const codingTool of ["bash", "edit", "write"]) {
      assert.equal(denied.has(codingTool), false, role);
    }
    assert.equal(denied.has("pipeline_child_spawn"), true, role);
    assert.equal(denied.has("codex_task"), true, role);
  }

  const discoveryDenied = new Set<string>(
    pipelineSessionToolPolicy("feature-pipeline", false, "discover-problem")
      .excludeTools,
  );
  const ordinaryAuditDenied = new Set<string>(
    pipelineSessionToolPolicy(
      "feature-pipeline",
      false,
      "audit-feature-outcome",
    ).excludeTools,
  );
  for (const allowed of [
    "read",
    "fd",
    "rg",
    "web_search_codex",
    "web_fetch_codex",
  ]) {
    assert.equal(discoveryDenied.has(allowed), false);
  }
  assert.equal(discoveryDenied.has("bash"), false);
  for (const denied of [
    "edit",
    "write",
    "apply_patch_codex",
    "codex_task",
    "mcp",
    "bg_start",
    "bg_kill",
    "ask_user",
    "pipeline_child_spawn",
    "workflow",
    "subagent_spawn",
  ]) {
    assert.equal(discoveryDenied.has(denied), true);
  }
  assert.equal(ordinaryAuditDenied.has("bash"), true);
  for (const role of PIPELINE_CHILD_ROLES) {
    const denied = new Set<string>(
      pipelineSessionToolPolicy("feature-pipeline", false, role).excludeTools,
    );
    assert.equal(denied.has("edit"), true, role);
    assert.equal(denied.has("write"), true, role);
    if (role !== EXECUTOR_AUDIT_ROLE && role !== "discover-problem") {
      assert.equal(denied.has("bash"), true, role);
    }
  }

  const planGoalDiscoveryDenied = new Set<string>(
    pipelineSessionToolPolicy("plan-pipeline", false, "discover-goal-outcomes")
      .excludeTools,
  );
  assert.equal(planGoalDiscoveryDenied.has("bash"), false);
  for (const role of PLAN_PIPELINE_DISCOVERY_ROLES) {
    const denied = new Set<string>(
      pipelineSessionToolPolicy("plan-pipeline", false, role).excludeTools,
    );
    assert.equal(denied.has("edit"), true, role);
    assert.equal(denied.has("write"), true, role);
    if (role !== "discover-goal-outcomes") {
      assert.equal(denied.has("bash"), true, role);
    }
  }
});

test("small-feature Luna root and audit Lunas are read-only while the implementer keeps coding tools", () => {
  const rootDenied = new Set<string>(
    pipelineSessionToolPolicy("small-feature-pipeline", true, "pipeline-root")
      .excludeTools,
  );
  const implementerDenied = new Set<string>(
    pipelineSessionToolPolicy(
      "small-feature-pipeline",
      false,
      "implement-small-feature",
    ).excludeTools,
  );
  const auditorDenied = new Set<string>(
    pipelineSessionToolPolicy(
      "small-feature-pipeline",
      false,
      STATIC_LUNA_AUDIT_ROLES[0],
    ).excludeTools,
  );
  for (const workspaceMutator of ["bash", "edit", "write"]) {
    assert.equal(rootDenied.has(workspaceMutator), true);
    assert.equal(auditorDenied.has(workspaceMutator), true);
    assert.equal(implementerDenied.has(workspaceMutator), false);
  }
  for (const delegatedOrExternalMutator of [
    "apply_patch_codex",
    "bg_start",
    "bg_kill",
    "codex_task",
    "mcp",
  ]) {
    assert.equal(rootDenied.has(delegatedOrExternalMutator), true);
    assert.equal(auditorDenied.has(delegatedOrExternalMutator), true);
    assert.equal(implementerDenied.has(delegatedOrExternalMutator), true);
  }
  assert.equal(rootDenied.has("pipeline_child_spawn"), false);
  assert.equal(implementerDenied.has("pipeline_child_spawn"), true);
  assert.equal(auditorDenied.has("pipeline_child_spawn"), true);
  for (const mainOnlyTool of ["pipeline_check", "pipeline_list"]) {
    assert.equal(rootDenied.has(mainOnlyTool), true);
    assert.equal(implementerDenied.has(mainOnlyTool), true);
    assert.equal(auditorDenied.has(mainOnlyTool), true);
  }
});

test("roles select fixed models, remain direct root children, and record attempts", async () => {
  const run = harness();
  const runId = run.controller.start(request());
  await settleInitialization();
  const rootId = run.controller.get(runId)?.rootId;
  assert.ok(rootId);

  run.controller.setStage(runId, "audit");
  const first = await run.controller.spawnChild(runId, "audit-feature-outcome");
  const retry = await run.controller.spawnChild(runId, "audit-feature-outcome");
  run.controller.setStage(runId, "final-audit");
  const finalAgents = await run.controller.startFinalAudit(runId, {
    acceptanceContract: "approved contract",
    assumptions: [],
    checks: [],
  });
  assert.equal(first.model, LUNA_MODEL);
  assert.equal(retry.model, LUNA_MODEL);
  assert.equal(
    finalAgents.every((agent) => agent.model === LUNA_MODEL),
    true,
  );
  assert.equal(first.parentId, rootId);
  assert.equal(retry.parentId, rootId);
  assert.equal(
    finalAgents.every((agent) => agent.parentId === rootId),
    true,
  );
  assert.equal(first.attempt, 1);
  assert.equal(retry.attempt, 2);
  assert.equal(run.controller.getAgent(runId, rootId).model, LUNA_MODEL);
  assert.equal(run.controller.getAgent(runId, rootId).thinkingLevel, "xhigh");
  assert.equal(pipelineThinkingLevel(SOL_MODEL), "high");
  assert.equal(pipelineThinkingLevel(TERRA_MODEL), "high");
  assert.equal(pipelineThinkingLevel(LUNA_MODEL, "xhigh"), "xhigh");
  assert.equal(pipelineThinkingLevel(SOL_MODEL, "medium"), "medium");
  assert.equal(
    run.controller
      .get(runId)
      ?.agents.some((agent) => agent.model === TERRA_MODEL),
    false,
  );
  await assert.rejects(
    run.controller.spawnChild(runId, "not-a-role" as PipelineChildRole),
    /Unsupported feature-pipeline child role/,
  );

  await run.controller.dispose();
});

test("plan-pipeline preserves earlier roles and uses a controller-owned Luna final audit", async () => {
  const workingDir = fs.mkdtempSync(path.join(os.tmpdir(), "plan-roles-"));
  const run = harness();
  const runId = run.controller.start({
    ...request(workingDir),
    pipeline: "plan-pipeline",
    gitCommit: false,
  });
  await settleInitialization();
  const snapshot = run.controller.get(runId);
  assert.equal(snapshot?.definition, "plan-pipeline");
  assert.equal(snapshot?.agents[0]?.model, SOL_MODEL);
  assert.equal(snapshot?.agents[0]?.title, "Plan pipeline Sol");
  assert.deepEqual(run.rootToolNames.slice(0, 4), [
    "pipeline_stage",
    "pipeline_plan_write",
    "pipeline_plan_validate",
    "pipeline_git_status",
  ]);

  const discovery = await Promise.all(
    PLAN_PIPELINE_DISCOVERY_ROLES.map((role) =>
      run.controller.spawnChild(runId, role),
    ),
  );
  PLAN_PIPELINE_DISCOVERY_ROLES.forEach((role) => settleRole(run, role));
  run.controller.setStage(runId, "build");
  run.controller.writePlan(runId, "docs/plans/roles.md", validPlan());
  run.controller.setStage(runId, "audit");
  const audits = await Promise.all(
    PLAN_PIPELINE_AUDIT_ROLES.map((role) =>
      run.controller.spawnChild(runId, role),
    ),
  );
  PLAN_PIPELINE_AUDIT_ROLES.forEach((role) => settleRole(run, role));
  run.controller.setStage(runId, "audit-resolve");
  run.controller.setStage(runId, "final-audit");
  const finalAgents = await run.controller.startFinalAudit(runId, {
    acceptanceContract: "validated plan artifact",
    assumptions: [],
    checks: ["plan contract passed"],
  });
  await assert.rejects(
    run.controller.startFinalAudit(runId, {
      acceptanceContract: "duplicate",
      assumptions: [],
      checks: [],
    }),
    /already started its final audit segment/,
  );
  const children = [...discovery, ...audits, ...finalAgents];
  assert.deepEqual(
    children.map((child) => child.role),
    [...PLAN_PIPELINE_CHILD_ROLES],
  );
  assert.equal(
    children.every((child) => child.parentId === snapshot?.rootId),
    true,
  );
  assert.equal(
    children.every((child) => child.model === LUNA_MODEL),
    true,
  );
  assert.equal(
    children.some((child) => child.model === TERRA_MODEL),
    false,
  );
  await assert.rejects(
    run.controller.spawnChild(runId, "discover-problem"),
    /Unsupported plan-pipeline child role/,
  );
  await assert.rejects(
    run.controller.spawnChild(runId, "final-audit"),
    /Unsupported plan-pipeline child role/,
  );
  assert.throws(
    () => run.controller.setStage(runId, "final-resolve"),
    /validated Luna audit synthesis/,
  );

  await run.controller.dispose();
  fs.rmSync(workingDir, { recursive: true, force: true });
});

test("small-feature-pipeline fans four Luna audits into one same-session remediation", async () => {
  const run = harness();
  const runId = run.controller.start({
    ...request(),
    pipeline: "small-feature-pipeline",
    gitCommit: false,
  });
  await settleInitialization();

  const initial = run.controller.get(runId);
  assert.equal(initial?.stage, "build");
  assert.equal(initial?.agents[0]?.title, "Small feature pipeline Luna");
  assert.equal(initial?.agents[0]?.model, LUNA_MODEL);
  assert.equal(
    pipelineThinkingLevel(initial?.agents[0]?.model ?? ""),
    "medium",
  );
  assert.deepEqual(SMALL_FEATURE_PIPELINE_CHILD_ROLES, [
    SMALL_FEATURE_IMPLEMENTER_ROLE,
    ...STATIC_LUNA_AUDIT_ROLES,
  ]);

  const implementer = await run.controller.spawnChild(
    runId,
    SMALL_FEATURE_IMPLEMENTER_ROLE,
  );
  assert.equal(implementer.model, LUNA_MODEL);
  assert.equal(implementer.persistent, true);
  await assert.rejects(
    run.controller.spawnChild(runId, SMALL_FEATURE_IMPLEMENTER_ROLE),
    /already has its allowed child session/,
  );
  settleRole(run, SMALL_FEATURE_IMPLEMENTER_ROLE);
  assert.equal(run.controller.getAgent(runId, implementer.id).status, "idle");
  await run.controller.waitForChildren(runId, [implementer.id]);
  assert.equal(run.controller.get(runId)?.stage, "final-audit");

  const auditors = await Promise.all(
    STATIC_LUNA_AUDIT_ROLES.map((role) =>
      run.controller.spawnChild(runId, role),
    ),
  );
  await assert.rejects(
    run.controller.spawnChild(runId, STATIC_LUNA_AUDIT_ROLES[0]),
    /already has its allowed child session/,
  );
  for (const [index, role] of STATIC_LUNA_AUDIT_ROLES.entries()) {
    const auditor = auditors[index];
    assert.ok(auditor);
    assert.equal(auditor.model, LUNA_MODEL);
    assert.equal(auditor.persistent, false);
    const auditorSession = run.sessions.find(
      (session) => session.spec.role === role,
    );
    assert.ok(auditorSession);
    assert.equal(
      auditorSession.prompts[0]?.includes(
        reportForRole(SMALL_FEATURE_IMPLEMENTER_ROLE),
      ),
      true,
    );
  }
  const firstAuditor = auditors[0];
  assert.ok(firstAuditor);
  settleRole(run, STATIC_LUNA_AUDIT_ROLES[0]);
  await run.controller.waitForChildren(runId, [firstAuditor.id]);
  assert.equal(run.controller.get(runId)?.stage, "final-audit");
  for (const role of STATIC_LUNA_AUDIT_ROLES.slice(1)) settleRole(run, role);
  await run.controller.waitForChildren(
    runId,
    auditors.slice(1).map((auditor) => auditor.id),
  );
  assert.equal(run.controller.get(runId)?.stage, "final-resolve");
  await assert.rejects(
    run.controller.sendChild(runId, firstAuditor.id, "Audit again"),
    /cannot be retried or continued/,
  );
  await run.controller.waitForChildren(runId, [implementer.id]);
  assert.equal(run.controller.get(runId)?.stage, "final-resolve");
  assert.throws(
    () => run.controller.setStage(runId, "complete"),
    /requires one same-session Luna remediation pass/,
  );

  const remediationMessage = "Resolve all audit reports";
  await run.controller.sendChild(runId, implementer.id, remediationMessage);
  const implementerSession = run.sessions.find(
    (session) => session.spec.role === SMALL_FEATURE_IMPLEMENTER_ROLE,
  );
  assert.ok(implementerSession);
  assert.equal(implementerSession.sends.length, 1);
  assert.match(
    implementerSession.sends[0] ?? "",
    /Independent Luna audit reports to resolve/,
  );
  for (const role of STATIC_LUNA_AUDIT_ROLES) {
    assert.equal(
      implementerSession.sends[0]?.includes(reportForRole(role)),
      true,
    );
  }
  assert.equal(implementerSession.sends[0]?.includes(remediationMessage), true);
  settleRole(run, SMALL_FEATURE_IMPLEMENTER_ROLE);
  await run.controller.waitForChildren(runId, [implementer.id]);
  assert.equal(run.controller.get(runId)?.stage, "complete");
  await assert.rejects(
    run.controller.sendChild(runId, implementer.id, "Fix twice"),
    /only run during final-resolve/,
  );

  const facts = {
    outcome: "Small feature implemented and remediated",
    changedPaths: ["src/feature.ts"],
    checks: ["focused tests passed"],
    assumptions: [],
    git: ["working tree inspected"],
    reports: ["Luna implementation", "Four Luna audits", "Luna remediation"],
    unresolvedItems: [],
    workingDir: "/tmp/work",
  };
  run.controller.complete(runId, facts);
  const finalFacts = run.controller.get(runId)?.completion;
  assert.equal(run.controller.get(runId)?.status, "completed");
  assert.ok(finalFacts?.git.some((item) => item.startsWith("Final Git HEAD:")));
  assert.ok(
    finalFacts?.git.some((item) =>
      item.includes("Final dirty HEAD..WORKTREE diff"),
    ),
  );
  assert.equal(run.handoffs[0]?.definition, "small-feature-pipeline");
  assert.deepEqual(
    run.controller
      .get(runId)
      ?.agents.filter((agent) => agent.parentId)
      .map((agent) => agent.role),
    [...SMALL_FEATURE_PIPELINE_CHILD_ROLES],
  );

  await run.controller.dispose();
});

test("feature audits and the embedded Luna segment receive captured fresh Git evidence", async () => {
  const workingDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "feature-audit-evidence-"),
  );
  execFileSync("git", ["init", "-q"], { cwd: workingDir });
  execFileSync("git", ["config", "user.email", "test@example.com"], {
    cwd: workingDir,
  });
  execFileSync("git", ["config", "user.name", "Test"], {
    cwd: workingDir,
  });
  fs.mkdirSync(path.join(workingDir, "src"));
  fs.writeFileSync(path.join(workingDir, "src", "feature.ts"), "before\n");
  execFileSync("git", ["add", "."], { cwd: workingDir });
  execFileSync("git", ["commit", "-qm", "baseline"], { cwd: workingDir });
  const baseSha = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: workingDir,
    encoding: "utf8",
  }).trim();

  const run = harness();
  const runId = run.controller.start(request(workingDir));
  await settleInitialization();
  fs.writeFileSync(path.join(workingDir, "src", "feature.ts"), "after\n");
  run.controller.setStage(runId, "audit");
  await Promise.all(
    STATIC_LUNA_AUDIT_ROLES.map((role) =>
      run.controller.spawnChild(runId, role),
    ),
  );
  for (const role of STATIC_LUNA_AUDIT_ROLES) {
    const lunaAudit = run.sessions.find(
      (session) => session.spec.role === role,
    );
    assert.ok(lunaAudit);
    assert.equal(lunaAudit.prompts[0]?.includes(baseSha), true);
    assert.equal(lunaAudit.prompts[0]?.includes("-before"), true);
    assert.equal(lunaAudit.prompts[0]?.includes("+after"), true);
    settleRole(run, role);
  }

  fs.writeFileSync(path.join(workingDir, "src", "feature.ts"), "final\n");
  run.controller.setStage(runId, "final-audit");
  await run.controller.startFinalAudit(runId, {
    acceptanceContract: "approved feature contract",
    assumptions: [],
    checks: ["focused tests passed"],
  });
  const finalAudits = STATIC_LUNA_AUDIT_ROLES.map((role) =>
    [...run.sessions].reverse().find((session) => session.spec.role === role),
  );
  assert.equal(finalAudits.every(Boolean), true);
  for (const lunaAudit of finalAudits) {
    assert.equal(lunaAudit?.prompts[0]?.includes(baseSha), true);
    assert.equal(lunaAudit?.prompts[0]?.includes("-before"), true);
    assert.equal(lunaAudit?.prompts[0]?.includes("+final"), true);
    assert.equal(lunaAudit?.prompts[0]?.includes("+after"), false);
  }
  assert.equal(
    run.sessions.some((session) => session.spec.model === TERRA_MODEL),
    false,
  );

  await run.controller.dispose();
  fs.rmSync(workingDir, { recursive: true, force: true });
});

test("small-feature Luna audits receive the captured base, implementation report, and actual diff", async () => {
  const workingDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "small-feature-audit-"),
  );
  execFileSync("git", ["init", "-q"], { cwd: workingDir });
  execFileSync("git", ["config", "user.email", "test@example.com"], {
    cwd: workingDir,
  });
  execFileSync("git", ["config", "user.name", "Test"], {
    cwd: workingDir,
  });
  fs.mkdirSync(path.join(workingDir, "src"));
  fs.writeFileSync(path.join(workingDir, "src", "feature.ts"), "before\n");
  execFileSync("git", ["add", "."], { cwd: workingDir });
  execFileSync("git", ["commit", "-qm", "baseline"], { cwd: workingDir });
  const baseSha = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: workingDir,
    encoding: "utf8",
  }).trim();

  const run = harness();
  const runId = run.controller.start({
    ...request(workingDir),
    pipeline: "small-feature-pipeline",
    gitCommit: false,
  });
  await settleInitialization();
  fs.writeFileSync(path.join(workingDir, "src", "feature.ts"), "committed\n");
  execFileSync("git", ["add", "src/feature.ts"], { cwd: workingDir });
  execFileSync("git", ["commit", "-qm", "implementation commit"], {
    cwd: workingDir,
  });
  fs.writeFileSync(
    path.join(workingDir, "src", "feature.ts"),
    `after\n${"x".repeat(300 * 1024)}`,
  );
  const implementer = await run.controller.spawnChild(
    runId,
    "implement-small-feature",
  );
  settleRole(run, "implement-small-feature");
  await run.controller.waitForChildren(runId, [implementer.id]);
  await Promise.all(
    STATIC_LUNA_AUDIT_ROLES.map((role) =>
      run.controller.spawnChild(runId, role),
    ),
  );

  for (const role of STATIC_LUNA_AUDIT_ROLES) {
    const auditorSession = run.sessions.find(
      (session) => session.spec.role === role,
    );
    assert.ok(auditorSession);
    assert.equal(auditorSession.prompts[0]?.includes(baseSha), true);
    assert.equal(
      auditorSession.prompts[0]?.includes("implementation commit"),
      true,
    );
    assert.equal(auditorSession.prompts[0]?.includes("-before"), true);
    assert.equal(auditorSession.prompts[0]?.includes("+committed"), true);
    assert.equal(auditorSession.prompts[0]?.includes("-committed"), true);
    assert.equal(auditorSession.prompts[0]?.includes("+after"), true);
    assert.equal(
      auditorSession.prompts[0]?.includes('"baseIsAncestor": "yes"'),
      true,
    );
    assert.equal(
      auditorSession.prompts[0]?.includes('"state": "truncated"'),
      true,
    );
    assert.equal(
      auditorSession.prompts[0]?.includes(
        reportForRole(SMALL_FEATURE_IMPLEMENTER_ROLE),
      ),
      true,
    );
  }

  await run.controller.dispose();
  fs.rmSync(workingDir, { recursive: true, force: true });
});

test("small-feature-pipeline fails closed on a malformed implementation report", async () => {
  const run = harness();
  const runId = run.controller.start({
    ...request(),
    pipeline: "small-feature-pipeline",
    gitCommit: false,
  });
  await settleInitialization();
  const implementer = await run.controller.spawnChild(
    runId,
    "implement-small-feature",
  );
  const implementerSession = run.sessions.find(
    (session) => session.spec.role === "implement-small-feature",
  );
  assert.ok(implementerSession);
  implementerSession.emit({
    type: "settled",
    outcome: { type: "completed", finalText: "not structured JSON" },
  });

  await run.controller.waitForChildren(runId, [implementer.id]);

  assert.equal(run.controller.get(runId)?.status, "failed");
  assert.equal(run.controller.get(runId)?.stage, "build");
  assert.equal(run.handoffs[0]?.status, "failed");
  assert.match(run.handoffs[0]?.error ?? "", /valid report/);
  assert.equal(
    run.controller.getAgent(runId, run.controller.get(runId)?.rootId ?? "")
      .status,
    "cancelled",
  );
  await run.controller.dispose();
});

test("small-feature-pipeline fails closed on a malformed Luna audit report", async () => {
  const run = harness();
  const runId = run.controller.start({
    ...request(),
    pipeline: "small-feature-pipeline",
    gitCommit: false,
  });
  await settleInitialization();
  const implementer = await run.controller.spawnChild(
    runId,
    SMALL_FEATURE_IMPLEMENTER_ROLE,
  );
  settleRole(run, SMALL_FEATURE_IMPLEMENTER_ROLE);
  await run.controller.waitForChildren(runId, [implementer.id]);

  const auditRole = STATIC_LUNA_AUDIT_ROLES[0];
  const auditor = await run.controller.spawnChild(runId, auditRole);
  const auditorSession = run.sessions.find(
    (session) => session.spec.role === auditRole,
  );
  assert.ok(auditorSession);
  auditorSession.emit({
    type: "settled",
    outcome: { type: "completed", finalText: "not structured JSON" },
  });

  await run.controller.waitForChildren(runId, [auditor.id]);

  assert.equal(run.controller.get(runId)?.status, "failed");
  assert.equal(run.controller.get(runId)?.stage, "final-audit");
  assert.equal(run.handoffs[0]?.status, "failed");
  assert.match(run.handoffs[0]?.error ?? "", /valid report/);
  await run.controller.dispose();
});

test("children run in parallel and wait returns reports in caller order", async () => {
  const run = harness();
  const runId = run.controller.start({
    ...request(),
    pipeline: "plan-pipeline",
    gitCommit: false,
  });
  await settleInitialization();
  const roles = PLAN_PIPELINE_DISCOVERY_ROLES;
  const children = await Promise.all(
    roles.map((role) => run.controller.spawnChild(runId, role)),
  );
  assert.equal(
    children.every((child) => child.status === "running"),
    true,
  );

  const wait = run.controller.waitForChildren(
    runId,
    children.map((child) => child.id),
  );
  for (const child of children) {
    const session = run.sessions.find(
      (candidate) => candidate.spec.role === child.role,
    );
    session?.emit({
      type: "settled",
      outcome: {
        type: "completed",
        finalText: reportForRole(child.role),
      },
    });
  }
  const reports = await wait;
  assert.deepEqual(
    reports.map((child) => child.role),
    [...roles],
  );
  assert.equal(run.controller.get(runId)?.stage, "build");

  await run.controller.dispose();
});

test("successful audit fan-in atomically enters audit-resolve", async () => {
  const run = harness();
  const runId = run.controller.start(request());
  await settleInitialization();
  run.controller.setStage(runId, "audit");
  const auditRoles = STATIC_LUNA_AUDIT_ROLES;
  const children = await Promise.all(
    auditRoles.map((role) => run.controller.spawnChild(runId, role)),
  );
  auditRoles.forEach((role) => settleRole(run, role));

  await run.controller.waitForChildren(
    runId,
    children.map((child) => child.id),
  );

  const snapshot = run.controller.get(runId);
  assert.equal(snapshot?.stage, "audit-resolve");
  const rows = buildPipelineRows(
    snapshot ? [snapshot] : [],
    new Set(snapshot ? [snapshot.id] : []),
  );
  assert.equal(
    rows.find((row) => row.kind === "stage" && row.stage === "audit-resolve")
      ?.label,
    "audit-resolve · running",
  );

  await finishEmbeddedAudit(run, runId);

  await run.controller.dispose();
});

test("child wait delivers the validated final audit report even when synthesis finalText is empty", async () => {
  const run = harness();
  const runId = run.controller.start(request());
  await settleInitialization();
  await finishEmbeddedAudit(run, runId, false);

  const synthesizer = run.controller.agentView
    .list()
    .find((agent) => agent.role === "audit-synthesis");
  assert.ok(synthesizer);
  Reflect.set(synthesizer, "finalText", "");
  const waitTool = run.rootTool(runId, "pipeline_child_wait");
  assert.ok(waitTool);
  const result = await waitTool.execute(
    "final-audit-wait",
    { ids: [synthesizer.id] },
    undefined,
    undefined,
    {} as ExtensionContext,
  );
  const rendered = JSON.stringify(result);
  assert.match(
    rendered,
    /VALIDATED_FINAL_AUDIT_REPORT_FOR_REQUIRED_RESOLUTION/,
  );
  assert.match(rendered, /audit-synthesis-final/);
  assert.match(rendered, /resolve every concrete finding/i);
  assert.match(rendered, /"finalAuditReportDelivered":true/);
  await run.controller.dispose();
});

test("embedded roots cannot cancel a busy controller-owned audit synthesizer", async () => {
  const run = harness();
  const runId = run.controller.start(request());
  await settleInitialization();
  run.controller.setStage(runId, "final-audit");
  const agents = await run.controller.startFinalAudit(runId, {
    acceptanceContract: "approved contract",
    assumptions: [],
    checks: [],
  });
  const firstRole = STATIC_LUNA_AUDIT_ROLES[0];
  settleRole(run, firstRole);
  await settleInitialization();
  const synthesizer = agents.find((agent) => agent.role === "audit-synthesis");
  assert.ok(synthesizer);
  const synthesisSession = run.sessions.find(
    (session) => session.spec.role === "audit-synthesis",
  );
  assert.ok(synthesisSession);
  assert.equal(synthesisSession.sends.length, 1);

  settleRole(run, STATIC_LUNA_AUDIT_ROLES[1]);
  await settleInitialization();
  assert.equal(run.controller.get(runId)?.auditSegment?.pendingReportCount, 1);
  await assert.rejects(
    run.controller.cancelChild(runId, synthesizer.id),
    /only be cancelled with the whole pipeline run/,
  );
  assert.equal(synthesisSession.interrupted, 0);
  assert.equal(run.controller.get(runId)?.status, "running");
  assert.equal(run.controller.get(runId)?.auditSegment?.reducerStatus, "busy");

  await run.controller.cancelRun(runId);
  assert.equal(synthesisSession.interrupted, 1);
  await run.controller.dispose();
});

test("fan-in does not advance when a required plan report is invalid", async () => {
  const run = harness();
  const runId = run.controller.start({
    ...request(),
    pipeline: "plan-pipeline",
    gitCommit: false,
  });
  await settleInitialization();
  const children = await Promise.all(
    PLAN_PIPELINE_DISCOVERY_ROLES.map((role) =>
      run.controller.spawnChild(runId, role),
    ),
  );
  PLAN_PIPELINE_DISCOVERY_ROLES.slice(0, -1).forEach((role) =>
    settleRole(run, role),
  );
  const invalidRole = PLAN_PIPELINE_DISCOVERY_ROLES.at(-1);
  const invalidSession = run.sessions.find(
    (session) => session.spec.role === invalidRole,
  );
  assert.ok(invalidSession);
  invalidSession.emit({
    type: "settled",
    outcome: { type: "completed", finalText: "not valid report JSON" },
  });

  await run.controller.waitForChildren(
    runId,
    children.map((child) => child.id),
  );

  assert.equal(run.controller.get(runId)?.stage, "discover");
  await run.controller.dispose();
});

test("a settled child can be retried in its existing session", async () => {
  const run = harness();
  const runId = run.controller.start(request());
  await settleInitialization();
  run.controller.setStage(runId, "audit");
  const child = await run.controller.spawnChild(
    runId,
    "audit-logic-invariants",
  );
  const childSession = run.sessions.find(
    (session) => session.spec.role === child.role,
  );
  assert.ok(childSession);
  childSession.emit({
    type: "settled",
    outcome: { type: "failed", error: "transient provider failure" },
  });

  await run.controller.sendChild(
    runId,
    child.id,
    "Retry the same report once.",
  );

  assert.deepEqual(childSession.sends, ["Retry the same report once."]);
  assert.equal(
    run.controller
      .get(runId)
      ?.agents.filter((agent) => agent.role === "audit-logic-invariants")
      .length,
    1,
  );
  assert.equal(run.controller.getAgent(runId, child.id).status, "running");
  await run.controller.dispose();
});

test("plan-pipeline enforces stage order and one Luna retry", async () => {
  const run = harness();
  const runId = run.controller.start({
    ...request(),
    pipeline: "plan-pipeline",
    gitCommit: false,
  });
  await settleInitialization();
  await assert.rejects(
    run.controller.spawnChild(runId, "audit-decomposition-dag"),
    /can only start during plan-pipeline stage audit/,
  );
  const child = await run.controller.spawnChild(
    runId,
    "discover-goal-outcomes",
  );
  const session = run.sessions.find(
    (candidate) => candidate.spec.role === child.role,
  );
  assert.ok(session);
  session.emit({
    type: "settled",
    outcome: { type: "failed", error: "transient failure" },
  });
  await run.controller.sendChild(runId, child.id, "Retry once.");
  await assert.rejects(
    run.controller.sendChild(runId, child.id, "Retry twice."),
    /already used its retry/,
  );
  assert.throws(
    () => run.controller.setStage(runId, "audit"),
    /Invalid plan-pipeline stage transition/,
  );
  await run.controller.dispose();
});

test("persistent Sol session survives idle remediation turns", async () => {
  const run = harness();
  const runId = run.controller.start(request());
  await settleInitialization();
  const rootId = run.controller.get(runId)?.rootId;
  assert.ok(rootId);
  const rootSession = run.sessions.find(
    (session) => session.spec.role === "pipeline-root",
  )!;
  rootSession.emit({
    type: "settled",
    outcome: { type: "completed", finalText: "implementation turn" },
  });
  assert.equal(run.controller.agentView.get(rootId)?.status, "idle");

  run.controller.agentView.requestSend(rootId, "Resolve the audit reports");
  await settleInitialization();
  assert.equal(rootSession.sends.length, 2);
  assert.equal(rootSession.sends.at(-1), "Resolve the audit reports");
  assert.equal(
    run.sessions.filter((session) => session.spec.role === "pipeline-root")
      .length,
    1,
  );
  assert.equal(run.controller.agentView.get(rootId)?.status, "running");

  await run.controller.dispose();
});

test("completion is rejected while a child is still active", async () => {
  const run = harness();
  const runId = run.controller.start(request());
  await settleInitialization();
  run.controller.setStage(runId, "audit");
  await run.controller.spawnChild(runId, "audit-feature-outcome");
  const facts = {
    outcome: "Feature behavior implemented",
    changedPaths: [],
    checks: [],
    assumptions: [],
    git: [],
    reports: [],
    unresolvedItems: [],
    workingDir: "/tmp/work",
  };

  assert.throws(
    () => run.controller.complete(runId, facts),
    /while children are active/,
  );
  assert.equal(run.controller.get(runId)?.status, "running");
  assert.equal(run.handoffs.length, 0);
  await run.controller.dispose();
});

test("dashboard cancellation of an idle root cancels the run and active children", async () => {
  const run = harness();
  const runId = run.controller.start(request());
  await settleInitialization();
  const rootId = run.controller.get(runId)?.rootId;
  assert.ok(rootId);
  const rootSession = run.sessions.find(
    (session) => session.spec.role === "pipeline-root",
  )!;
  rootSession.emit({
    type: "settled",
    outcome: { type: "completed", finalText: "waiting for next stage" },
  });
  assert.equal(run.controller.agentView.get(rootId)?.status, "idle");
  run.controller.setStage(runId, "audit");
  const child = await run.controller.spawnChild(
    runId,
    "audit-reliability-regressions",
  );
  const rootRow = buildPipelineRows(
    [run.controller.get(runId)!],
    new Set([runId]),
  ).find((row) => row.kind === "agent" && row.agentId === rootId);
  assert.ok(rootRow);

  await cancelPipelineRow(run.controller, rootRow);

  assert.equal(run.controller.get(runId)?.status, "cancelled");
  assert.equal(run.controller.getAgent(runId, rootId).status, "cancelled");
  assert.equal(run.controller.getAgent(runId, child.id).status, "cancelled");
  assert.equal(run.handoffs.length, 1);
  assert.equal(run.handoffs[0]?.status, "cancelled");
  await run.controller.dispose();
});

test("feature completion appends committed and dirty Git facts without readiness status", async () => {
  const workingDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "feature-completion-git-"),
  );
  execFileSync("git", ["init", "-q"], { cwd: workingDir });
  execFileSync("git", ["config", "user.email", "test@example.com"], {
    cwd: workingDir,
  });
  execFileSync("git", ["config", "user.name", "Test"], {
    cwd: workingDir,
  });
  fs.writeFileSync(path.join(workingDir, "feature.txt"), "base\n");
  execFileSync("git", ["add", "."], { cwd: workingDir });
  execFileSync("git", ["commit", "-qm", "baseline"], { cwd: workingDir });

  const run = harness();
  const runId = run.controller.start(request(workingDir));
  await settleInitialization();
  const facts = {
    outcome: "Feature behavior implemented",
    changedPaths: ["feature.txt"],
    checks: ["npm test passed"],
    assumptions: ["Existing authenticated users are the target audience"],
    git: ["Sol reported implementation Git state"],
    reports: ["discover-problem: user need verified"],
    unresolvedItems: ["manual browser check pending"],
    workingDir,
  };
  assert.throws(
    () => run.controller.complete(runId, { ...facts, workingDir: "/other" }),
    /working_dir must be/,
  );
  await finishEmbeddedAudit(run, runId, true, [finalAuditFinding()]);
  fs.writeFileSync(path.join(workingDir, "feature.txt"), "committed\n");
  execFileSync("git", ["add", "feature.txt"], { cwd: workingDir });
  execFileSync("git", ["commit", "-qm", "feature implementation"], {
    cwd: workingDir,
  });
  fs.writeFileSync(path.join(workingDir, "feature.txt"), "dirty follow-up\n");
  assert.throws(
    () =>
      run.controller.complete(runId, {
        ...facts,
        reports: [...facts.reports, "Incidental AUD-001 mention only"],
      }),
    /final_finding_resolutions.*AUD-001/,
  );
  assert.throws(
    () =>
      run.controller.complete(runId, {
        ...facts,
        finalFindingResolutions: [
          {
            findingId: "AUD-001",
            disposition: "fixed",
            evidence: "",
            verification: ["Focused check passed"],
          },
        ],
      }),
    /non-empty evidence and verification/,
  );
  const resolvedFacts = {
    ...facts,
    reports: [...facts.reports, "Final audit resolutions recorded"],
    finalFindingResolutions: [
      {
        findingId: "AUD-001",
        disposition: "fixed" as const,
        evidence:
          "Enforced direct final-report delivery and completion gating.",
        verification: ["Focused final-resolve regression passed"],
      },
    ],
  };
  run.controller.complete(runId, resolvedFacts);
  await settleInitialization();

  assert.equal(run.handoffs.length, 1);
  const handoff = run.handoffs[0];
  assert.ok(handoff);
  const { auditReport, ...completedFacts } = handoff.facts;
  assert.equal(completedFacts.git[0], facts.git[0]);
  assert.ok(
    completedFacts.git.some(
      (item) =>
        item.startsWith("Final base..HEAD commits") &&
        item.includes("feature implementation"),
    ),
  );
  assert.ok(
    completedFacts.git.some(
      (item) =>
        item.startsWith("Final committed diff") && item.includes("+committed"),
    ),
  );
  assert.ok(
    completedFacts.git.some(
      (item) =>
        item.startsWith("Final dirty HEAD..WORKTREE diff") &&
        item.includes("+dirty follow-up"),
    ),
  );
  assert.deepEqual(
    { ...completedFacts, git: resolvedFacts.git },
    resolvedFacts,
  );
  assert.deepEqual(auditReport?.integratedRoles, AUDIT_SEGMENT_LUNA_ROLES);
  assert.equal(auditReport?.executedChecks[0]?.status, "passed");
  assert.equal(
    auditReport?.hostWorkspaceObservation.capturedAfterExecutor,
    true,
  );
  assert.equal("readiness" in handoff, false);
  assert.equal(run.controller.get(runId)?.status, "completed");
  await assert.rejects(
    Promise.resolve().then(() =>
      run.controller.complete(runId, { ...facts, workingDir: "/other" }),
    ),
    /is completed/,
  );

  await run.controller.dispose();
  fs.rmSync(workingDir, { recursive: true, force: true });
});

test("plan completion requires and validates a repository-local plan artifact", async () => {
  const workingDir = fs.mkdtempSync(path.join(os.tmpdir(), "plan-pipeline-"));
  const run = harness();
  const runId = run.controller.start({
    task: "Plan the approved goal",
    workingDir,
    pipeline: "plan-pipeline",
    gitCommit: false,
  });
  await settleInitialization();
  await advancePlanToComplete(run, runId, "docs/plans/example.md");
  const facts = {
    outcome: "Implementation plan written and audited",
    changedPaths: [],
    checks: ["plan contract passed"],
    assumptions: ["No UI layer exists"],
    git: ["working tree contains the plan artifact"],
    reports: ["five discovery and five audit reports summarized"],
    unresolvedItems: ["Owner assignment remains open"],
    workingDir,
  };

  assert.throws(
    () => run.controller.complete(runId, facts),
    /requires plan_path/,
  );
  const artifactPath = path.join(workingDir, "docs", "plans", "example.md");
  const replacementPath = path.join(
    workingDir,
    "docs",
    "plans",
    "replacement.md",
  );
  fs.writeFileSync(
    replacementPath,
    validPlan().replace("# Implementation plan", "# Replacement plan"),
  );
  fs.renameSync(replacementPath, artifactPath);
  assert.throws(
    () =>
      run.controller.complete(runId, {
        ...facts,
        planPath: "docs/plans/example.md",
      }),
    /changed after this plan-pipeline run wrote it/,
  );
  run.controller.writePlan(runId, "docs/plans/example.md", validPlan());
  run.controller.complete(runId, {
    ...facts,
    planPath: "docs/plans/example.md",
  });
  assert.equal(run.handoffs[0]?.definition, "plan-pipeline");
  assert.equal(run.handoffs[0]?.facts.planPath, "docs/plans/example.md");
  assert.deepEqual(run.handoffs[0]?.facts.changedPaths, [
    "docs/plans/example.md",
  ]);
  assert.deepEqual(
    run.handoffs[0]?.facts.auditReport?.integratedRoles,
    AUDIT_SEGMENT_LUNA_ROLES,
  );
  assert.equal(
    run.handoffs[0]?.facts.auditReport?.executedChecks[0]?.command,
    "npm run check",
  );

  await run.controller.dispose();
  fs.rmSync(workingDir, { recursive: true, force: true });
});

test("pipeline inspection does not mutate lifecycle state or consume the automatic handoff", async () => {
  const run = harness();
  const runId = run.controller.start(request());
  await settleInitialization();
  const facts = {
    outcome: "Feature behavior implemented",
    changedPaths: ["src/feature.ts"],
    checks: ["focused test passed"],
    assumptions: [],
    git: [],
    reports: [],
    unresolvedItems: [],
    workingDir: "/tmp/work",
  };
  await finishEmbeddedAudit(run, runId);
  run.controller.complete(runId, facts);
  await settleInitialization();
  const before = structuredClone(run.controller.get(runId));
  assert.equal(run.handoffs.length, 1);

  const inspected = inspectPipeline(run.controller, runId, 123_456);

  assert.equal(inspected.details.pipeline.id, runId);
  assert.deepEqual(run.controller.get(runId), before);
  assert.equal(run.handoffs.length, 1);
  const { auditReport: _auditReport, ...handoffFacts } =
    run.handoffs[0]?.facts ?? {};
  assert.deepEqual(
    { ...handoffFacts, git: handoffFacts.git?.slice(0, facts.git.length) },
    facts,
  );
  assert.ok(
    handoffFacts.git?.some((item) => item.startsWith("Final Git HEAD:")),
  );
  await run.controller.dispose();
});

test("pipeline inspection compactly represents every controller-reachable settled attempt", async () => {
  const run = harness();
  const runId = run.controller.start(request());
  await settleInitialization();

  run.controller.setStage(runId, "audit");
  for (let attempt = 1; attempt <= 300; attempt++) {
    await run.controller.spawnChild(runId, "audit-feature-outcome");
    const session = run.sessions.at(-1);
    assert.ok(session);
    session.emit({
      type: "settled",
      outcome: {
        type: "completed",
        finalText: reportForRole("audit-feature-outcome"),
      },
    });
  }

  const inspected = inspectPipeline(run.controller, runId, 123_456);
  const text = inspected.content[0]?.text ?? "";
  assert.equal(inspected.details.pipeline.agents.length, 311);
  assert.equal(inspected.details.pipeline.agents[0]?.id, "node-11");
  assert.equal(inspected.details.pipeline.agents.at(-1)?.id, "node-311");
  assert.ok(Buffer.byteLength(text, "utf8") <= PIPELINE_CHECK_MAX_BYTES);
  assert.match(
    text,
    /audit-feature-outcome · attempts 1–300 .* · done · 300 agents/,
  );
  assert.match(text, /- node-11 · pipeline-root/);
  await run.controller.dispose();
});

test("unknown IDs fail closed and cancellation/disposal stop active sessions", async () => {
  const run = harness();
  const runId = run.controller.start(request());
  await settleInitialization();
  run.controller.setStage(runId, "audit");
  const child = await run.controller.spawnChild(
    runId,
    "audit-logic-invariants",
  );
  await assert.rejects(
    run.controller.waitForChildren(runId, ["unknown"]),
    /Unknown agent id/,
  );
  await assert.rejects(
    run.controller.cancelChild(runId, "unknown"),
    /Unknown agent id/,
  );

  await run.controller.cancelChild(runId, child.id);
  assert.equal(run.controller.getAgent(runId, child.id).status, "cancelled");
  await run.controller.cancelRun(runId);
  assert.equal(run.controller.get(runId)?.status, "cancelled");
  assert.equal(run.handoffs.length, 1);
  await run.controller.dispose();
  assert.equal(
    run.sessions.every((session) => session.disposed === 1),
    true,
  );
});

test("pipeline roots and children do not apply direct-subagent capacity limits", async () => {
  let releaseRoot = () => {};
  const rootGate = new Promise<void>((resolve) => {
    releaseRoot = resolve;
  });
  const run = harness({ rootGate });
  const ids = Array.from({ length: 5 }, () => run.controller.start(request()));
  await settleInitialization();
  assert.equal(
    ids.every((id) => run.controller.get(id)?.status === "starting"),
    true,
  );
  releaseRoot();
  await settleInitialization();
  assert.equal(
    ids.every((id) => run.controller.get(id)?.status === "running"),
    true,
  );
  assert.equal(run.sessions.length, 55);

  await run.controller.dispose();
});
