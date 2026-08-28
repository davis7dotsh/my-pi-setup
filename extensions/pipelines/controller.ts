import { execFileSync } from "node:child_process";
import { StringEnum } from "@earendil-works/pi-ai";
import {
  defineTool,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { AgentTreeController } from "../shared/agent-tree/control.ts";
import type {
  AgentNodeSnapshot,
  AgentTreeSessionFactory,
} from "../shared/agent-tree/domain.ts";
import {
  AUDIT_PIPELINE_ID,
  AUDIT_SEGMENT_LUNA_ROLES,
  AUDIT_SYNTHESIS_ROLE,
  EXECUTOR_AUDIT_ROLE,
  FEATURE_PIPELINE_DISCOVERY_ROLES,
  FEATURE_PIPELINE_ID,
  LUNA_MODEL,
  PIPELINE_STAGES,
  STATIC_LUNA_AUDIT_ROLES,
  PLAN_PIPELINE_AUDIT_ROLES,
  PLAN_PIPELINE_DISCOVERY_ROLES,
  PLAN_PIPELINE_ID,
  SMALL_FEATURE_IMPLEMENTER_ROLE,
  SMALL_FEATURE_PIPELINE_CHILD_ROLES,
  SMALL_FEATURE_PIPELINE_ID,
  assertPipelineGitCommitSupported,
  childContextPolicyFor,
  definitionFor,
  initialStageForDefinition,
  modelForRole,
  roleBelongsToDefinition,
  rolesForDefinition,
  stagesForDefinition,
  titleForRole,
  type AuditPipelineInput,
  type FeaturePipelineDiscoveryRole,
  type PipelineChildRole,
  type PipelineCompletionFacts,
  type PipelineDefinitionId,
  type PipelineHandoff,
  type PipelineRunRequest,
  type PipelineRunSnapshot,
  type PipelineStage,
} from "./domain.ts";
import {
  resolvePlanArtifact,
  validatePipelineReport,
  writePlanArtifact,
} from "./plan-contract.ts";
import {
  parseFeatureDiscoveryReport,
  parseFeatureDiscoveryReportText,
  validateFeatureDiscoveryFanIn,
  type FeatureDiscoveryReportV2,
} from "./discovery-report.ts";
import {
  buildPipelineChildPrompt,
  buildPipelinePrompt,
  type FeatureDiscoveryReportContext,
} from "./prompt.ts";
import {
  FEATURE_CANDIDATE_ROLES,
  FEATURE_DISCOVERY_SYNTHESIS_ROLE,
  FEATURE_IMPLEMENTATION_SYNTHESIS_ROLE,
  assertBoundedSynthesisInput,
  buildFeatureAugmentationPrompt,
  buildFeatureCandidatePrompt,
  buildFeatureDiscoverySynthesisPrompt,
  buildFeatureSelectionPrompt,
  parseFeatureCandidateHandoff,
  parseFeatureDiscoverySynthesis,
  parseFeatureSelection,
  parseFeatureSynthesisProvenance,
  preparedDiscoveryPackage,
  type FeatureCandidateComparisonInput,
  type FeatureCandidateHandoff,
  type FeatureDiscoverySynthesis,
  type FeatureSelection,
  type FeatureSynthesisProvenance,
} from "./feature-best-of-three.ts";
import {
  defaultFeatureGitOperations,
  type FeatureCallerWorktree,
  type FeatureGitOperations,
  type FeatureWorktreeLifecycle,
  type FrozenFeatureCandidate,
} from "./feature-worktrees.ts";
import {
  AuditSegment,
  buildAuditTrackPrompt,
  type AuditGitIdentity,
  type AuditSegmentContext,
} from "./audit-segment.ts";

export function pipelineDiscoverySubmissionAllowed(
  definition: PipelineDefinitionId,
  role: string,
  stage: PipelineStage,
  bootstrapped: boolean,
) {
  return (
    definition === FEATURE_PIPELINE_ID &&
    stage === "discover" &&
    !bootstrapped &&
    FEATURE_PIPELINE_DISCOVERY_ROLES.some(
      (discoveryRole) => discoveryRole === role,
    )
  );
}

export function pipelineAuditSubmissionAllowed(
  definition: PipelineDefinitionId,
  role: string,
  segmentActive: boolean,
) {
  const definitionUsesSegment =
    definition === AUDIT_PIPELINE_ID ||
    definition === FEATURE_PIPELINE_ID ||
    definition === PLAN_PIPELINE_ID;
  if (!definitionUsesSegment) return false;
  if (role === AUDIT_SYNTHESIS_ROLE) {
    return definition === AUDIT_PIPELINE_ID || segmentActive;
  }
  return (
    segmentActive &&
    AUDIT_SEGMENT_LUNA_ROLES.some((auditRole) => auditRole === role)
  );
}

function isFeatureDiscoveryRole(
  role: string,
): role is FeaturePipelineDiscoveryRole {
  return (FEATURE_PIPELINE_DISCOVERY_ROLES as ReadonlyArray<string>).includes(
    role,
  );
}

function isFeatureInternalImplementationRole(role: string) {
  return (
    role === FEATURE_DISCOVERY_SYNTHESIS_ROLE ||
    role === FEATURE_IMPLEMENTATION_SYNTHESIS_ROLE ||
    FEATURE_CANDIDATE_ROLES.some(
      (candidateRole) => `candidate-${candidateRole.toLowerCase()}` === role,
    )
  );
}

function featureAuditVerificationSummary(reportedCheckCount: number) {
  return [
    `The synthesized implementation reported ${reportedCheckCount} verification check(s) before exact clean promotion; model-authored check text is withheld so independent audits receive no Best-of-3 provenance.`,
  ];
}

interface MutableRun {
  id: string;
  definition: PipelineDefinitionId;
  request: PipelineRunRequest;
  baseSha: string;
  stage: PipelineStage;
  status: PipelineRunSnapshot["status"];
  startedAt: number;
  finishedAt?: number;
  error?: string;
  rootId?: string;
  featureDiscoveryBootstrapped: boolean;
  featureDiscoveryReports: Map<
    FeaturePipelineDiscoveryRole,
    FeatureDiscoveryReportContext
  >;
  featureCaller?: FeatureCallerWorktree;
  featureLifecycle?: FeatureWorktreeLifecycle;
  featureDiscoverySynthesis?: FeatureDiscoverySynthesis;
  featureCandidates?: ReadonlyArray<{
    readonly candidate: FrozenFeatureCandidate;
    readonly handoff: FeatureCandidateHandoff;
  }>;
  featureSelection?: FeatureSelection;
  featureSynthesisProvenance?: FeatureSynthesisProvenance;
  featureSynthesisChecks: ReadonlyArray<string>;
  auditSegment?: AuditSegment;
  auditSegmentStarting?: Promise<ReadonlyArray<AgentNodeSnapshot>>;
  finalAuditReportDelivered: boolean;
  completion?: PipelineCompletionFacts;
  planArtifactsWritten: Map<
    string,
    { digest: string; device: number; inode: number }
  >;
}

function finalAuditResolutionHandoff(run: MutableRun) {
  const report = run.auditSegment?.finalReport;
  if (run.stage !== "final-resolve" || !report) return undefined;
  return `VALIDATED_FINAL_AUDIT_REPORT_FOR_REQUIRED_RESOLUTION
The controller received and validated the structured final audit report below. Its findings are authoritative input for this final-resolve turn even when the synthesis session has empty finalText. Evaluate and resolve every concrete finding now; fix it or reject it with specific evidence, run appropriate checks, and do not start another audit.
${JSON.stringify(report)}
END_VALIDATED_FINAL_AUDIT_REPORT_FOR_REQUIRED_RESOLUTION`;
}

function requireFinalFindingResolutionEvidence(
  run: MutableRun,
  facts: PipelineCompletionFacts,
) {
  const missing = (run.auditSegment?.finalReport?.findings ?? [])
    .map(({ id }) => id)
    .filter((id) => !facts.reports.some((summary) => summary.includes(id)));
  if (missing.length > 0) {
    throw new Error(
      `pipeline_complete must account for every delivered final-audit finding ID with fix or evidence-backed rejection: ${missing.join(", ")}.`,
    );
  }
}

function gitHead(workingDir: string) {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: workingDir,
      encoding: "utf8",
      maxBuffer: 16 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch {
    return "UNAVAILABLE";
  }
}

export interface PipelineControllerOptions {
  readonly createSessionFactory: (
    rootTools: (runId: string) => ReadonlyArray<ToolDefinition>,
    definitionForRun: (runId: string) => PipelineDefinitionId,
    auditSubmit?: (
      runId: string,
      role: string,
      sessionToken: string,
      value: unknown,
    ) => void,
    auditSessionCreated?: (runId: string, role: string, token: string) => void,
    auditToolAllowed?: (runId: string, role: string) => boolean,
    discoverySubmit?: (
      runId: string,
      role: string,
      sessionToken: string,
      value: unknown,
    ) => void,
    discoverySessionCreated?: (
      runId: string,
      role: string,
      token: string,
    ) => void,
    discoveryToolAllowed?: (runId: string, role: string) => boolean,
    featureCommit?: (runId: string, role: string, workingDir: string) => string,
  ) => AgentTreeSessionFactory;
  readonly onHandoff: (handoff: PipelineHandoff) => void | Promise<void>;
  readonly makeRunId?: () => string;
  readonly makeAgentId?: () => string;
  readonly featureGit?: FeatureGitOperations;
}

function completionSchema() {
  return Type.Object({
    outcome: Type.String({ maxLength: 32_768 }),
    plan_path: Type.Optional(Type.String({ maxLength: 16_384 })),
    changed_paths: Type.Array(Type.String({ maxLength: 4_096 }), {
      maxItems: 512,
    }),
    checks_evidence: Type.Array(Type.String({ maxLength: 8_192 }), {
      maxItems: 512,
    }),
    assumptions: Type.Array(Type.String({ maxLength: 8_192 }), {
      maxItems: 256,
    }),
    git_commits: Type.Array(Type.String({ maxLength: 8_192 }), {
      maxItems: 256,
    }),
    report_summaries_references: Type.Array(
      Type.String({ maxLength: 16_384 }),
      { maxItems: 256 },
    ),
    unresolved_items: Type.Array(Type.String({ maxLength: 16_384 }), {
      maxItems: 256,
    }),
    working_dir: Type.String({ maxLength: 16_384 }),
  });
}

export class PipelineController {
  private readonly runs = new Map<string, MutableRun>();
  private readonly listeners = new Set<() => void>();
  private readonly handoffs = new Set<string>();
  private readonly childContinuations = new Map<string, number>();
  private readonly auditPumps = new Set<string>();
  private readonly auditCorrections = new Map<string, number>();
  private readonly auditSessionTokens = new Map<string, string>();
  private readonly discoveryCorrections = new Map<string, number>();
  private readonly featureSynthesisCorrections = new Map<string, number>();
  private readonly discoverySessionTokens = new Map<string, string>();
  private readonly discoverySubmissions = new Map<string, unknown>();
  private readonly tree: AgentTreeController;
  private readonly onHandoff: PipelineControllerOptions["onHandoff"];
  private readonly makeRunId: () => string;
  private readonly featureGit: FeatureGitOperations;
  private runSequence = 0;
  private shuttingDown = false;

  constructor(options: PipelineControllerOptions) {
    this.onHandoff = options.onHandoff;
    this.makeRunId =
      options.makeRunId ?? (() => `pipeline-${++this.runSequence}`);
    this.featureGit = options.featureGit ?? defaultFeatureGitOperations;
    this.tree = new AgentTreeController({
      factory: options.createSessionFactory(
        (runId) => this.createRootTools(runId),
        (runId) => this.requireRun(runId).definition,
        (runId, role, token, value) =>
          this.submitAuditReport(runId, role, token, value),
        (runId, role, token) =>
          this.registerAuditSessionToken(runId, role, token),
        (runId, role) => {
          const run = this.requireRun(runId);
          return pipelineAuditSubmissionAllowed(
            run.definition,
            role,
            Boolean(run.auditSegment),
          );
        },
        (runId, role, token, value) =>
          this.submitDiscoveryReport(runId, role, token, value),
        (runId, role, token) =>
          this.registerDiscoverySessionToken(runId, role, token),
        (runId, role) => {
          const run = this.requireRun(runId);
          return pipelineDiscoverySubmissionAllowed(
            run.definition,
            role,
            run.stage,
            run.featureDiscoveryBootstrapped,
          );
        },
        (runId, role, workingDir) =>
          this.commitFeatureWorktree(runId, role, workingDir),
      ),
      // Pipeline graphs predeclare their model fan-out. Direct-subagent quotas
      // intentionally do not apply to pipeline roots or children.
      makeId: options.makeAgentId,
    });
    this.tree.view.subscribe(() => this.onTreeChange());
  }

  get agentView() {
    return this.tree.view;
  }

  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private registerDiscoverySessionToken(
    runId: string,
    role: string,
    token: string,
  ) {
    const run = this.requireRun(runId);
    if (
      !pipelineDiscoverySubmissionAllowed(
        run.definition,
        role,
        run.stage,
        run.featureDiscoveryBootstrapped,
      )
    ) {
      return;
    }
    const node = this.agentsFor(runId)
      .filter((agent) => agent.role === role && agent.status === "starting")
      .at(-1);
    if (node) this.discoverySessionTokens.set(token, node.id);
  }

  private submitDiscoveryReport(
    runId: string,
    role: string,
    token: string,
    value: unknown,
  ) {
    const run = this.requireActiveRun(runId);
    if (
      !pipelineDiscoverySubmissionAllowed(
        run.definition,
        role,
        run.stage,
        run.featureDiscoveryBootstrapped,
      )
    ) {
      throw new Error("Feature discovery submission is not active.");
    }
    const sessionId = this.discoverySessionTokens.get(token);
    const node = sessionId ? this.tree.view.get(sessionId) : undefined;
    if (
      !sessionId ||
      !node ||
      node.scopeId !== runId ||
      node.role !== role ||
      node.status !== "running"
    ) {
      throw new Error("Discovery submission session is not registered.");
    }
    if (this.discoverySubmissions.has(sessionId)) {
      throw new Error("This discovery turn already recorded a submission.");
    }
    this.discoverySubmissions.set(sessionId, value);
  }

  private registerAuditSessionToken(
    runId: string,
    role: string,
    token: string,
  ) {
    const node = this.agentsFor(runId)
      .filter((agent) => agent.role === role && agent.status === "starting")
      .at(-1);
    if (node) this.auditSessionTokens.set(token, node.id);
  }

  private submitAuditReport(
    runId: string,
    role: string,
    token: string,
    value: unknown,
  ) {
    const run = this.requireActiveRun(runId);
    const segment = run.auditSegment;
    if (!segment) throw new Error("No audit segment is active.");
    const sessionId = this.auditSessionTokens.get(token);
    const registeredRole = sessionId
      ? segment.roleForSession(sessionId)
      : undefined;
    if (!sessionId || registeredRole !== role) {
      throw new Error("Audit submission session is not registered.");
    }
    segment.submit(sessionId, value);
  }

  private notify() {
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch {
        // Dashboard listeners cannot alter run state.
      }
    }
  }

  private agentsFor(runId: string) {
    return this.tree.view
      .list()
      .filter((agent) => agent.scopeId === runId)
      .sort((left, right) => left.createdAt - right.createdAt);
  }

  list() {
    return [...this.runs.values()]
      .map((run) => this.snapshot(run))
      .sort((left, right) => right.startedAt - left.startedAt);
  }

  get(runId: string) {
    const run = this.runs.get(runId);
    return run ? this.snapshot(run) : undefined;
  }

  private snapshot(run: MutableRun): PipelineRunSnapshot {
    return {
      id: run.id,
      definition: run.definition,
      workingDir: run.request.workingDir,
      stage: run.stage,
      status: run.status,
      startedAt: run.startedAt,
      ...(run.finishedAt ? { finishedAt: run.finishedAt } : {}),
      ...(run.error ? { error: run.error } : {}),
      ...(run.rootId ? { rootId: run.rootId } : {}),
      ...(run.completion ? { completion: run.completion } : {}),
      ...(run.auditSegment
        ? { auditSegment: run.auditSegment.progress() }
        : {}),
      agents: this.agentsFor(run.id),
    };
  }

  start(request: PipelineRunRequest) {
    if (this.shuttingDown)
      throw new Error("Pipeline controller is shutting down.");
    const definition = request.pipeline ?? FEATURE_PIPELINE_ID;
    assertPipelineGitCommitSupported(definition, request.gitCommit === true);
    const featureCaller =
      definition === FEATURE_PIPELINE_ID
        ? this.featureGit.preflight(request.workingDir)
        : undefined;
    const effectiveRequest = featureCaller
      ? { ...request, workingDir: featureCaller.workingDir }
      : request;
    if (request.audit && definition !== AUDIT_PIPELINE_ID) {
      throw new Error("Audit input is only valid for audit-pipeline.");
    }
    const audit: AuditPipelineInput = request.audit ?? {
      mode: "initial",
      acceptanceCriteria: [],
    };
    if (
      definition === AUDIT_PIPELINE_ID &&
      audit.mode === "closure" &&
      (!audit.priorBlockers?.length ||
        !audit.remediationDiff ||
        !audit.touchedInvariants?.length)
    ) {
      throw new Error(
        "Closure audit requires prior blockers, closure conditions, a remediation diff, and at least one directly touched invariant.",
      );
    }
    const normalizedRequest =
      definition === AUDIT_PIPELINE_ID
        ? { ...effectiveRequest, audit }
        : effectiveRequest;
    const id = this.makeRunId();
    const featureLifecycle = featureCaller
      ? this.featureGit.createLifecycle(featureCaller, id)
      : undefined;
    const run: MutableRun = {
      id,
      definition,
      request: {
        ...normalizedRequest,
        gitCommit: normalizedRequest.gitCommit === true,
      },
      baseSha:
        featureCaller?.baseCommit ?? gitHead(effectiveRequest.workingDir),
      stage: initialStageForDefinition(definition),
      status: "starting",
      startedAt: Date.now(),
      featureDiscoveryBootstrapped: false,
      featureDiscoveryReports: new Map(),
      ...(featureCaller ? { featureCaller } : {}),
      ...(featureLifecycle ? { featureLifecycle } : {}),
      featureSynthesisChecks: [],
      finalAuditReportDelivered: false,
      planArtifactsWritten: new Map(),
    };
    this.runs.set(id, run);
    this.notify();
    void this.initialize(run);
    return id;
  }

  private async initialize(run: MutableRun) {
    try {
      if (run.definition === FEATURE_PIPELINE_ID) {
        await this.initializeFeaturePipeline(run);
        return;
      }
      const root = await this.tree.spawn({
        scopeId: run.id,
        role:
          run.definition === AUDIT_PIPELINE_ID
            ? AUDIT_SYNTHESIS_ROLE
            : "pipeline-root",
        attempt: 1,
        title: definitionFor(run.definition).rootTitle,
        model: definitionFor(run.definition).rootModel,
        cwd: run.request.workingDir,
        prompt: buildPipelinePrompt(run.definition, run.request),
        persistent: true,
        deferPrompt: run.definition === AUDIT_PIPELINE_ID,
        shouldStart: () => run.status === "starting",
      });
      run.rootId = root.id;
      if (run.status !== "starting") {
        this.notify();
        return;
      }
      if (root.status === "error") {
        this.failRun(run, root.error ?? "Pipeline root failed.");
      } else if (root.status === "cancelled") {
        run.status = "cancelled";
        run.finishedAt = Date.now();
        run.error = root.error;
        this.notify();
        this.deliver(run);
      } else {
        run.status = "running";
        this.notify();
        if (run.definition === AUDIT_PIPELINE_ID) {
          run.auditSegmentStarting = this.startAuditSegment(run, {
            acceptanceContract:
              run.request.audit?.acceptanceCriteria.join("\n") ||
              "Use the task statement as the bounded acceptance contract.",
            assumptions: [],
            checks: [],
            standalone: true,
          });
          await run.auditSegmentStarting;
        }
      }
    } catch (error) {
      this.failRun(
        run,
        error instanceof Error ? error.message : String(error),
        Boolean(run.rootId),
      );
    }
  }

  private async initializeFeaturePipeline(run: MutableRun) {
    const lifecycle = run.featureLifecycle;
    if (!lifecycle || !run.featureCaller) {
      throw new Error("feature-pipeline Git lifecycle was not initialized.");
    }
    const discoverySynthesisAgent = await this.tree.spawn({
      scopeId: run.id,
      role: FEATURE_DISCOVERY_SYNTHESIS_ROLE,
      attempt: 1,
      title: "Feature discovery synthesis",
      model: LUNA_MODEL,
      thinkingLevel: "medium",
      cwd: run.request.workingDir,
      prompt: "Controller-deferred feature discovery synthesis.",
      persistent: true,
      deferPrompt: true,
      shouldStart: () => run.status === "starting",
    });
    run.rootId = discoverySynthesisAgent.id;
    if (run.status !== "starting") return;
    run.status = "running";
    this.notify();

    const discoveryReports = await this.bootstrapFeatureDiscovery(run);
    if (run.status !== "running") return;
    await this.tree.startDeferred(
      discoverySynthesisAgent.id,
      buildFeatureDiscoverySynthesisPrompt(
        run.request.task,
        run.request.workingDir,
        discoveryReports,
      ),
    );
    const discoverySynthesis = await this.settleFeatureSession(
      run,
      discoverySynthesisAgent.id,
      "Feature discovery synthesis",
      (text) => parseFeatureDiscoverySynthesis(text, discoveryReports),
      "Return one complete strict feature-discovery-synthesis-v1 JSON object. Do not repeat discovery or choose an implementation model/candidate.",
    );
    run.featureDiscoverySynthesis = discoverySynthesis;
    if (run.status !== "running") return;

    const prepared = preparedDiscoveryPackage(
      run.request.task,
      discoveryReports,
      discoverySynthesis,
    );
    const preparedPackageJson = JSON.stringify(prepared);
    assertBoundedSynthesisInput(prepared);
    const candidateWorktrees = lifecycle.createCandidateWorktrees();
    const candidateAgents = await Promise.all(
      candidateWorktrees.map((worktree) =>
        this.tree.spawn({
          scopeId: run.id,
          parentId: discoverySynthesisAgent.id,
          role: `candidate-${worktree.role.toLowerCase()}`,
          attempt: 1,
          title: `${worktree.role} implementation candidate`,
          model: LUNA_MODEL,
          thinkingLevel: "xhigh",
          cwd: worktree.path,
          prompt: buildFeatureCandidatePrompt(
            worktree.role,
            worktree.path,
            worktree.branchRef,
            worktree.baseCommit,
            preparedPackageJson,
          ),
          shouldStart: () => run.status === "running",
        }),
      ),
    );
    const frozenCandidates = await Promise.all(
      candidateAgents.map(async (agent, index) => {
        const worktree = candidateWorktrees[index];
        if (!worktree)
          throw new Error("Candidate worktree mapping disappeared.");
        return this.settleFeatureSession(
          run,
          agent.id,
          `${worktree.role} implementation candidate`,
          (text) => {
            const handoff = parseFeatureCandidateHandoff(text);
            const candidate = lifecycle.freezeCandidate(worktree, handoff);
            this.tree.disableViewMutations(agent.id);
            return { candidate, handoff };
          },
          `Return one complete strict ${worktree.role} candidate handoff after committing and verifying the complete implementation in your assigned worktree.`,
        );
      }),
    );
    run.featureCandidates = frozenCandidates;
    if (run.status !== "running") return;

    const comparisonInput: ReadonlyArray<FeatureCandidateComparisonInput> =
      frozenCandidates.map(({ candidate, handoff }) => ({
        role: candidate.role,
        handoff,
        changedPaths: candidate.changedPaths,
        boundedDiff: candidate.boundedDiff,
        immutableCommit: candidate.headCommit,
        worktreeReference: candidate.path,
      }));
    const selectionDirectory = lifecycle.prepareSelectionDirectory();
    const synthesisAgent = await this.tree.spawn({
      scopeId: run.id,
      parentId: discoverySynthesisAgent.id,
      role: FEATURE_IMPLEMENTATION_SYNTHESIS_ROLE,
      attempt: 1,
      title: "Best-of-3 selection and bounded synthesis",
      model: LUNA_MODEL,
      thinkingLevel: "xhigh",
      cwd: selectionDirectory,
      prompt: buildFeatureSelectionPrompt(
        prepared,
        comparisonInput,
        selectionDirectory,
      ),
      persistent: true,
      shouldStart: () => run.status === "running",
    });
    const selection = await this.settleFeatureSession(
      run,
      synthesisAgent.id,
      "Best-of-3 primary selection",
      (text) => {
        lifecycle.assertSelectionReadOnly(
          frozenCandidates.map(({ candidate }) => candidate),
        );
        return parseFeatureSelection(text);
      },
      "Return one strict selection-only JSON object. Do not write code, mutate candidates, or invent a fourth implementation.",
    );
    run.featureSelection = selection;
    const primary = frozenCandidates.find(
      ({ candidate }) => candidate.role === selection.primaryCandidate,
    );
    const primaryInput = comparisonInput.find(
      ({ role }) => role === selection.primaryCandidate,
    );
    if (!primary || !primaryInput) {
      throw new Error("Validated primary candidate is unavailable.");
    }
    const synthesisWorktree = lifecycle.createSynthesisWorktree(
      primary.candidate,
    );
    this.tree.enableMutation(synthesisAgent.id);
    await this.tree.send(
      synthesisAgent.id,
      buildFeatureAugmentationPrompt({
        selection,
        primary: primaryInput,
        synthesisWorktree: synthesisWorktree.path,
        synthesisBranchRef: synthesisWorktree.branchRef,
      }),
    );
    const synthesized = await this.settleFeatureSession(
      run,
      synthesisAgent.id,
      "Primary-based bounded synthesis",
      (text) => {
        const provenance = parseFeatureSynthesisProvenance(text);
        return {
          provenance,
          validated: lifecycle.validateSynthesis(
            synthesisWorktree,
            provenance,
            selection,
            frozenCandidates.map(({ candidate }) => candidate),
          ),
        };
      },
      "Return one strict synthesis provenance JSON object after bounded primary-based augmentation, repository verification, a clean worktree, and a distinct final commit. Do not rewrite from scratch.",
    );
    run.featureSynthesisProvenance = synthesized.provenance;
    run.featureSynthesisChecks = featureAuditVerificationSummary(
      synthesized.provenance.checks.length,
    );
    lifecycle.promote(synthesized.validated);
    const cleanupFailures = lifecycle.cleanup();
    if (cleanupFailures.length > 0) {
      throw new Error(cleanupFailures.join(" "));
    }

    const postPromotionRoot = await this.tree.spawn({
      scopeId: run.id,
      role: "pipeline-root",
      attempt: 1,
      title: definitionFor(run.definition).rootTitle,
      model: LUNA_MODEL,
      thinkingLevel: "xhigh",
      cwd: run.request.workingDir,
      prompt: "Controller-deferred post-promotion audit and remediation root.",
      persistent: true,
      deferPrompt: true,
      shouldStart: () => run.status === "running",
    });
    if (postPromotionRoot.status === "error") {
      throw new Error(
        postPromotionRoot.error ?? "Post-promotion pipeline root failed.",
      );
    }
    this.tree.reparent(discoverySynthesisAgent.id, postPromotionRoot.id);
    run.rootId = postPromotionRoot.id;
    run.stage = "build";
    this.notify();
    await this.tree.startDeferred(
      postPromotionRoot.id,
      buildPipelinePrompt(
        run.definition,
        run.request,
        discoverySynthesis,
        run.featureSynthesisChecks,
      ),
    );
  }

  private async settleFeatureSession<T>(
    run: MutableRun,
    sessionId: string,
    label: string,
    parse: (text: string) => T,
    correctionInstruction: string,
  ) {
    while (run.status === "running") {
      const [settled] = await this.tree.wait([sessionId]);
      if (!settled)
        throw new Error(`${label} session ${sessionId} disappeared.`);
      if (settled.status === "error" || settled.status === "cancelled") {
        throw new Error(
          `${label} session ${settled.status}: ${settled.error ?? "provider failure or cancellation"}.`,
        );
      }
      try {
        return parse(settled.finalText);
      } catch (error) {
        const count =
          (this.featureSynthesisCorrections.get(sessionId) ?? 0) + 1;
        this.featureSynthesisCorrections.set(sessionId, count);
        const detail = error instanceof Error ? error.message : String(error);
        if (count >= 4) {
          throw new Error(`${label} rejected settled turn ${count}: ${detail}`);
        }
        await this.tree.send(
          sessionId,
          `${label} was rejected (correction ${count}/3): ${detail} ${correctionInstruction}`,
        );
      }
    }
    throw new Error(`${label} ended because the run stopped.`);
  }

  private async spawnFeatureDiscoveryAttempt(
    run: MutableRun,
    role: FeaturePipelineDiscoveryRole,
  ) {
    try {
      return await this.spawnChildForRun(run, role, "", true);
    } catch (error) {
      if (run.status !== "running") throw error;
      const attempts = this.agentsFor(run.id).filter(
        (agent) => agent.role === role,
      );
      const failedBeforeSession =
        attempts.length === 1 &&
        attempts[0]?.status === "error" &&
        !attempts[0].sessionFile;
      if (!failedBeforeSession) throw error;
      return this.spawnChildForRun(run, role, "", true);
    }
  }

  private featureDiscoveryReports(run: MutableRun) {
    return FEATURE_PIPELINE_DISCOVERY_ROLES.map((role) => {
      const report = run.featureDiscoveryReports.get(role);
      if (!report) {
        throw new Error(
          `feature-pipeline programmatic discovery has no valid ${role} report.`,
        );
      }
      return report;
    });
  }

  private acceptFeatureDiscoveryTurn(
    run: MutableRun,
    role: FeaturePipelineDiscoveryRole,
    agent: AgentNodeSnapshot,
  ) {
    const hasSubmission = this.discoverySubmissions.has(agent.id);
    const submitted = this.discoverySubmissions.get(agent.id);
    this.discoverySubmissions.delete(agent.id);
    const report: FeatureDiscoveryReportV2 = hasSubmission
      ? parseFeatureDiscoveryReport(role, submitted)
      : parseFeatureDiscoveryReportText(role, agent.finalText);
    run.featureDiscoveryReports.set(role, {
      role,
      provenance: {
        sessionId: agent.id,
        attempt: agent.attempt,
        submission: hasSubmission ? "tool" : "final-text-json",
      },
      report,
    });
  }

  private async settleFeatureDiscoveryRole(
    run: MutableRun,
    role: FeaturePipelineDiscoveryRole,
    initial: AgentNodeSnapshot,
  ) {
    const sessionId = initial.id;
    while (run.status === "running") {
      const [settled] = await this.waitForChildren(run.id, [sessionId]);
      if (!settled) {
        throw new Error(`Feature discovery session ${sessionId} disappeared.`);
      }
      if (settled.status === "error" || settled.status === "cancelled") {
        throw new Error(
          `Feature discovery ${role} session ${settled.status}: ${settled.error ?? "provider failure or cancellation"}.`,
        );
      }
      try {
        this.acceptFeatureDiscoveryTurn(run, role, settled);
        return;
      } catch (error) {
        const count = (this.discoveryCorrections.get(sessionId) ?? 0) + 1;
        this.discoveryCorrections.set(sessionId, count);
        const detail = error instanceof Error ? error.message : String(error);
        if (count >= 4) {
          throw new Error(
            `Feature discovery ${role} rejected settled turn ${count}: ${detail}`,
          );
        }
        await this.tree.send(
          sessionId,
          `Your feature discovery V2 submission was rejected (correction ${count}/3): ${detail} Use pipeline_discovery_submit with the complete strict ${role} report, correcting the reported fields, then stop. If the tool is unavailable, return the same object as compact final-text JSON. Do not rerun or disturb other discovery tracks.`,
        );
      }
    }
    throw new Error(`Feature discovery ${role} ended because the run stopped.`);
  }

  private async bootstrapFeatureDiscovery(run: MutableRun) {
    const initial = await Promise.all(
      FEATURE_PIPELINE_DISCOVERY_ROLES.map((role) =>
        this.spawnFeatureDiscoveryAttempt(run, role),
      ),
    );
    await Promise.all(
      FEATURE_PIPELINE_DISCOVERY_ROLES.map((role, index) => {
        const child = initial[index];
        if (!child) {
          throw new Error(`Feature discovery ${role} session was not created.`);
        }
        return this.settleFeatureDiscoveryRole(run, role, child);
      }),
    );
    if (run.status !== "running") return [];
    const reports = this.featureDiscoveryReports(run);
    const fanInIssues = validateFeatureDiscoveryFanIn(reports);
    if (fanInIssues.length > 0) throw new Error(fanInIssues.join(" "));
    run.featureDiscoveryBootstrapped = true;
    this.notify();
    return reports;
  }

  private auditGitIdentity(run: MutableRun): AuditGitIdentity {
    const workingDir = run.request.workingDir;
    const headSha = gitHead(workingDir);
    const bounded = (args: ReadonlyArray<string>, label: string) => {
      try {
        const value = execFileSync("git", [...args], {
          cwd: workingDir,
          encoding: "utf8",
          maxBuffer: 256 * 1024,
          stdio: ["ignore", "pipe", "pipe"],
        }).trim();
        const maxBytes = 64 * 1024;
        if (Buffer.byteLength(value, "utf8") > maxBytes) {
          const marker = `\n[${label} truncated at ${maxBytes} bytes.]`;
          const payload = Buffer.from(value, "utf8")
            .subarray(0, maxBytes - Buffer.byteLength(marker, "utf8"))
            .toString("utf8");
          return {
            state: "truncated" as const,
            value: `${payload}${marker}`,
          };
        }
        return { state: "available" as const, value };
      } catch (error) {
        const partial =
          error && typeof error === "object"
            ? Reflect.get(error, "stdout")
            : undefined;
        if (typeof partial === "string" && partial.length > 0) {
          const marker = `\n[${label} truncated after the Git output limit.]`;
          const payload = Buffer.from(partial, "utf8")
            .subarray(0, 64 * 1024 - Buffer.byteLength(marker, "utf8"))
            .toString("utf8");
          return { state: "truncated" as const, value: `${payload}${marker}` };
        }
        return {
          state: "unavailable" as const,
          value: `${label} unavailable: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    };
    let branch = "UNAVAILABLE";
    try {
      branch =
        execFileSync("git", ["branch", "--show-current"], {
          cwd: workingDir,
          encoding: "utf8",
          maxBuffer: 16 * 1024,
          stdio: ["ignore", "pipe", "pipe"],
        }).trim() || "DETACHED";
    } catch {
      // Explicit unavailable evidence is safer than guessing repository state.
    }
    const status = bounded(["status", "--short", "--branch"], "Git status");
    const baseAvailable =
      run.baseSha !== "UNAVAILABLE" && headSha !== "UNAVAILABLE";
    let baseIsAncestor: AuditGitIdentity["baseIsAncestor"] = "unavailable";
    if (baseAvailable) {
      try {
        execFileSync(
          "git",
          ["merge-base", "--is-ancestor", run.baseSha, headSha],
          {
            cwd: workingDir,
            stdio: "ignore",
          },
        );
        baseIsAncestor = "yes";
      } catch (error) {
        const status =
          error && typeof error === "object"
            ? Reflect.get(error, "status")
            : undefined;
        baseIsAncestor = status === 1 ? "no" : "unavailable";
      }
    }
    const rawCommits = baseAvailable
      ? bounded(
          [
            "log",
            "--oneline",
            "--no-decorate",
            "--max-count=201",
            `${run.baseSha}..${headSha}`,
          ],
          "Commit list",
        )
      : {
          state: "unavailable" as const,
          value:
            "Commit list unavailable: captured base or current HEAD is unavailable.",
        };
    const commitLines = rawCommits.value
      .split("\n")
      .filter((line) => line.length > 0);
    const commits =
      rawCommits.state === "available" && commitLines.length > 200
        ? {
            state: "truncated" as const,
            value: `${commitLines.slice(0, 200).join("\n")}\n[Commit list truncated at 200 entries.]`,
          }
        : rawCommits;
    const committedDiff = baseAvailable
      ? bounded(
          [
            "diff",
            "--no-ext-diff",
            "--no-color",
            `${run.baseSha}..${headSha}`,
            "--",
          ],
          "Committed diff",
        )
      : {
          state: "unavailable" as const,
          value:
            "Committed diff unavailable: captured base or current HEAD is unavailable.",
        };
    const dirtyDiff =
      headSha !== "UNAVAILABLE"
        ? bounded(
            ["diff", "--no-ext-diff", "--no-color", headSha, "--"],
            "Dirty working-tree diff",
          )
        : {
            state: "unavailable" as const,
            value:
              "Dirty working-tree diff unavailable: current HEAD is unavailable.",
          };
    const combinedDiff = baseAvailable
      ? bounded(
          ["diff", "--no-ext-diff", "--no-color", run.baseSha, "--"],
          "Combined base-to-worktree diff",
        )
      : {
          state: "unavailable" as const,
          value:
            "Combined base-to-worktree diff unavailable: captured base or current HEAD is unavailable.",
        };
    return {
      baseSha: run.baseSha,
      headSha,
      worktreeLabel: "WORKTREE",
      workingDir,
      branch,
      status,
      baseIsAncestor,
      commits,
      committedDiff,
      dirtyDiff,
      combinedDiff,
    };
  }

  private async startAuditSegment(
    run: MutableRun,
    options: {
      acceptanceContract: string;
      assumptions: ReadonlyArray<string>;
      checks: ReadonlyArray<string>;
      standalone: boolean;
    },
  ) {
    if (run.auditSegment) {
      throw new Error("This pipeline run already has an audit segment.");
    }
    if (!run.rootId) throw new Error(`Pipeline run "${run.id}" has no root.`);
    const input = run.request.audit ?? {
      mode: "initial" as const,
      acceptanceCriteria: [],
    };
    const featureSynthesis = run.featureDiscoverySynthesis;
    const acceptanceContract =
      run.definition === FEATURE_PIPELINE_ID && featureSynthesis
        ? JSON.stringify({
            featureContract: featureSynthesis.featureContract,
            acceptanceCriteria: featureSynthesis.acceptanceCriteria,
            constraints: featureSynthesis.constraints,
            nonGoals: featureSynthesis.nonGoals,
            contractsInvariants: featureSynthesis.contractsInvariants,
            verificationExpectations: featureSynthesis.verificationExpectations,
          })
        : options.acceptanceContract;
    const assumptions =
      run.definition === FEATURE_PIPELINE_ID && featureSynthesis
        ? featureSynthesis.assumptions
        : options.assumptions;
    const checks =
      run.definition === FEATURE_PIPELINE_ID
        ? run.featureSynthesisChecks
        : options.checks;
    const context: AuditSegmentContext = {
      task: run.request.task,
      acceptanceContract: acceptanceContract.slice(0, 64 * 1024),
      assumptions: assumptions.slice(0, 128),
      checks: checks.slice(0, 128),
      input,
      git: this.auditGitIdentity(run),
      purpose:
        run.definition === AUDIT_PIPELINE_ID
          ? "standalone"
          : run.definition === PLAN_PIPELINE_ID
            ? "plan-final"
            : "feature-final",
    };
    const segment = new AuditSegment(context);
    run.auditSegment = segment;
    this.notify();

    if (options.standalone) {
      segment.registerSynthesis(run.rootId);
    } else {
      const synthesis = await this.tree.spawn({
        scopeId: run.id,
        parentId: run.rootId,
        role: AUDIT_SYNTHESIS_ROLE,
        attempt: 1,
        title: titleForRole(AUDIT_SYNTHESIS_ROLE),
        model: modelForRole(AUDIT_SYNTHESIS_ROLE),
        cwd: run.request.workingDir,
        prompt: "Controller-deferred audit synthesis.",
        persistent: true,
        deferPrompt: true,
        shouldStart: () => run.status === "running",
      });
      segment.registerSynthesis(synthesis.id);
    }

    const tracks = await Promise.all(
      AUDIT_SEGMENT_LUNA_ROLES.map(async (role) => {
        const attempt =
          this.agentsFor(run.id).filter((agent) => agent.role === role).length +
          1;
        const child = await this.tree.spawn({
          scopeId: run.id,
          parentId: run.rootId,
          role,
          attempt,
          title: titleForRole(role),
          model: modelForRole(role),
          cwd: run.request.workingDir,
          prompt: buildAuditTrackPrompt(role, context),
          shouldStart: () => run.status === "running",
        });
        segment.registerTrack(role, child.id);
        return child;
      }),
    );
    await this.pumpAuditSegment(run);
    const synthesis = this.tree.view.get(segment.synthesizerId!);
    return synthesis ? [...tracks, synthesis] : tracks;
  }

  async startFinalAudit(
    runId: string,
    context: {
      acceptanceContract: string;
      assumptions: ReadonlyArray<string>;
      checks: ReadonlyArray<string>;
    },
  ) {
    const run = this.requireActiveRun(runId);
    if (
      run.definition !== FEATURE_PIPELINE_ID &&
      run.definition !== PLAN_PIPELINE_ID
    ) {
      throw new Error(
        "Embedded audit segments are available only to feature-pipeline and plan-pipeline.",
      );
    }
    if (run.stage !== "final-audit") {
      throw new Error(
        "The pipeline must enter final-audit before starting its audit segment.",
      );
    }
    if (run.auditSegmentStarting || run.auditSegment) {
      throw new Error(
        "This pipeline run already started its final audit segment.",
      );
    }
    const starting = this.startAuditSegment(run, {
      ...context,
      standalone: false,
    });
    run.auditSegmentStarting = starting;
    try {
      return await starting;
    } catch (error) {
      this.failRun(
        run,
        error instanceof Error ? error.message : String(error),
        true,
      );
      throw error;
    }
  }

  private async auditCorrection(
    run: MutableRun,
    sessionId: string,
    error: unknown,
  ) {
    const count = (this.auditCorrections.get(sessionId) ?? 0) + 1;
    this.auditCorrections.set(sessionId, count);
    if (count >= 4) {
      this.failRun(
        run,
        error instanceof Error ? error.message : String(error),
        true,
      );
      return;
    }
    const detail = error instanceof Error ? error.message : String(error);
    await this.tree.send(
      sessionId,
      `Your audit submission was rejected (correction ${count}/3): ${detail} Use pipeline_audit_submit with the complete strict report object, correcting the reported fields, then stop. Do not rerun other tracks.`,
    );
  }

  private async pumpAuditSegment(run: MutableRun) {
    const segment = run.auditSegment;
    if (
      !segment ||
      this.auditPumps.has(run.id) ||
      (run.status !== "starting" && run.status !== "running")
    ) {
      return;
    }
    this.auditPumps.add(run.id);
    try {
      for (const [role, id] of segment.tracks) {
        const child = this.tree.view.get(id);
        if (
          !child ||
          child.status === "starting" ||
          child.status === "running"
        ) {
          continue;
        }
        if (child.status === "error" || child.status === "cancelled") {
          throw new Error(`Audit track ${role} failed before a valid report.`);
        }
        try {
          const submitted = segment.takeSubmission(id);
          if (submitted !== undefined)
            segment.acceptSubmitted(role, submitted, child.attempt);
          else segment.accept(role, child.finalText, child.attempt);
          if (role === EXECUTOR_AUDIT_ROLE) {
            segment.captureExecutorHostObservation(this.auditGitIdentity(run));
          }
        } catch (error) {
          await this.auditCorrection(run, id, error);
          if (run.status !== "running" && run.status !== "starting") return;
        }
      }

      const synthesisId = segment.synthesizerId;
      if (!synthesisId) return;
      let synthesizer = this.tree.view.get(synthesisId);
      if (!synthesizer)
        throw new Error("Audit synthesis session is unavailable.");

      if (
        segment.progress().reducerStatus === "busy" &&
        synthesizer.status === "idle"
      ) {
        try {
          const submitted = segment.takeSubmission(synthesisId);
          if (submitted !== undefined) segment.settleSubmitted(submitted);
          else segment.settle(synthesizer.finalText);
        } catch (error) {
          await this.auditCorrection(run, synthesisId, error);
          if (run.status !== "running" && run.status !== "starting") return;
        }
      } else if (
        segment.progress().reducerStatus === "busy" &&
        (synthesizer.status === "error" || synthesizer.status === "cancelled")
      ) {
        throw new Error(
          "Audit synthesis failed before returning a valid report.",
        );
      }

      const finalReport = segment.finalReport;
      if (finalReport) {
        if (run.definition === AUDIT_PIPELINE_ID) {
          this.completeStandaloneAudit(run, finalReport);
        } else if (run.stage === "final-audit") {
          run.stage = "final-resolve";
          this.notify();
        }
        return;
      }

      synthesizer = this.tree.view.get(synthesisId)!;
      if (synthesizer.status !== "idle") return;
      const next = segment.nextPrompt();
      if (!next) return;
      if (synthesizer.finalText || synthesizer.transcript.length > 0) {
        await this.tree.send(synthesisId, next.prompt);
      } else {
        await this.tree.startDeferred(synthesisId, next.prompt);
      }
    } catch (error) {
      this.failRun(
        run,
        error instanceof Error ? error.message : String(error),
        true,
      );
    } finally {
      this.auditPumps.delete(run.id);
      this.notify();
      const synthesisId = segment.synthesizerId;
      const synthesizer = synthesisId
        ? this.tree.view.get(synthesisId)
        : undefined;
      if (
        (run.status === "starting" || run.status === "running") &&
        segment.progress().reducerStatus === "busy" &&
        synthesizer?.status === "idle"
      ) {
        void this.pumpAuditSegment(run);
      }
    }
  }

  private completeStandaloneAudit(
    run: MutableRun,
    report: NonNullable<PipelineCompletionFacts["auditReport"]>,
  ) {
    if (run.status !== "running") return;
    const progress = run.auditSegment?.progress();
    run.stage = "complete";
    run.status = "completed";
    run.finishedAt = Date.now();
    run.completion = {
      outcome: report.summary,
      changedPaths: report.workspaceChangesObserved.map((item) => item.path),
      checks: [
        `${progress?.integratedReportCount ?? 0} validated Luna audit reports integrated exactly once.`,
        `${progress?.revision ?? 0} serialized synthesis revision(s) completed.`,
        `Captured review identity: ${report.baseSha}..${report.headSha} (WORKTREE).`,
        ...report.executedChecks.map(
          (item) =>
            `${item.command}: ${item.status}${item.exitCode === null ? "" : ` (exit ${item.exitCode})`} — ${item.evidence}`,
        ),
      ],
      assumptions: [],
      git: [
        `Review base ${report.baseSha}`,
        `Review head ${report.headSha} with WORKTREE evidence`,
        report.hostWorkspaceObservation.summary,
      ],
      reports: [
        `Validated ${report.mode} audit synthesis: ${report.findings.length} finding(s), ${report.unresolvedConflicts.length} unresolved conflict(s), ${report.unprovenChecks.length} unproven check(s), ${report.executedChecks.length} executor check record(s), ${report.workspaceChangesObserved.length} executor-observed workspace change(s).`,
      ],
      unresolvedItems: [
        ...report.unresolvedConflicts.map((item) => item.description),
        ...report.unprovenChecks.map((item) => item.claim),
      ],
      workingDir: run.request.workingDir,
      auditReport: report,
    };
    this.notify();
    this.deliver(run);
  }

  private cleanupFeatureLifecycle(run: MutableRun) {
    const failures = run.featureLifecycle?.cleanup() ?? [];
    if (failures.length === 0) return;
    run.error = [run.error, ...failures]
      .filter(Boolean)
      .join(" ")
      .slice(0, 16 * 1024);
    this.notify();
  }

  private onTreeChange() {
    if (this.shuttingDown) return;
    for (const run of this.runs.values()) {
      if (run.status !== "starting" && run.status !== "running") continue;
      const root = run.rootId ? this.tree.view.get(run.rootId) : undefined;
      if (!root) continue;
      if (root.status === "cancelled") {
        run.status = "cancelled";
        run.finishedAt = Date.now();
        run.error = root.error;
        void this.cancelActiveChildren(run).finally(() => {
          this.cleanupFeatureLifecycle(run);
          this.deliver(run);
        });
      } else if (root.status === "error") {
        this.failRun(run, root.error ?? "Pipeline root failed.");
      }
      if (run.status === "starting" || run.status === "running") {
        void this.pumpAuditSegment(run);
      }
    }
    this.notify();
  }

  private failRun(run: MutableRun, error: string, cancelRoot = false) {
    if (run.status !== "starting" && run.status !== "running") return;
    run.status = "failed";
    run.finishedAt = Date.now();
    run.error = error.slice(0, 16 * 1024);
    const cleanup = this.cancelActiveChildren(run).finally(() =>
      this.cleanupFeatureLifecycle(run),
    );
    if (cancelRoot && run.rootId) {
      void this.tree.cancel(run.rootId).catch(() => {});
    }
    this.notify();
    if (run.featureLifecycle) void cleanup.finally(() => this.deliver(run));
    else this.deliver(run);
  }

  private factsForFailure(run: MutableRun): PipelineCompletionFacts {
    return {
      outcome: "The pipeline did not produce a structured completion.",
      changedPaths: [],
      checks: [],
      assumptions: [],
      git: [],
      reports: [],
      unresolvedItems: [run.error ?? "Pipeline ended before completion."],
      workingDir: run.request.workingDir,
    };
  }

  private deliver(run: MutableRun) {
    if (this.shuttingDown || this.handoffs.has(run.id)) return;
    if (run.status === "starting" || run.status === "running") return;
    this.handoffs.add(run.id);
    const handoff: PipelineHandoff = {
      runId: run.id,
      definition: run.definition,
      status: run.status,
      facts: run.completion ?? this.factsForFailure(run),
      ...(run.error ? { error: run.error } : {}),
    };
    void Promise.resolve(this.onHandoff(handoff)).catch(() => {});
  }

  private roleHasValidReport(run: MutableRun, role: PipelineChildRole) {
    if (
      run.definition === FEATURE_PIPELINE_ID &&
      isFeatureDiscoveryRole(role)
    ) {
      return run.featureDiscoveryReports.has(role);
    }
    return this.agentsFor(run.id).some(
      (agent) =>
        agent.role === role &&
        (agent.status === "done" || agent.status === "idle") &&
        validatePipelineReport(run.definition, agent.role, agent.finalText)
          .length === 0,
    );
  }

  private requireValidReports(
    run: MutableRun,
    roles: ReadonlyArray<PipelineChildRole>,
    transition: PipelineStage,
  ) {
    const missing = roles.filter((role) => !this.roleHasValidReport(run, role));
    if (missing.length > 0) {
      throw new Error(
        `Cannot enter ${transition}; missing valid reports: ${missing.join(", ")}.`,
      );
    }
  }

  private advanceStageAfterFanIn(
    run: MutableRun,
    waitedChildren: ReadonlyArray<AgentNodeSnapshot>,
  ) {
    if (run.definition === SMALL_FEATURE_PIPELINE_ID) {
      const boundary =
        run.stage === "build"
          ? {
              roles: [SMALL_FEATURE_IMPLEMENTER_ROLE] as const,
              nextStage: "final-audit" as const,
            }
          : run.stage === "final-audit"
            ? {
                roles: STATIC_LUNA_AUDIT_ROLES,
                nextStage: "final-resolve" as const,
              }
            : run.stage === "final-resolve"
              ? {
                  roles: [SMALL_FEATURE_IMPLEMENTER_ROLE] as const,
                  nextStage: "complete" as const,
                }
              : undefined;
      const waitedAtBoundary = boundary?.roles.some((role) =>
        waitedChildren.some((child) => child.role === role),
      );
      const implementer = waitedChildren.find(
        (child) => child.role === SMALL_FEATURE_IMPLEMENTER_ROLE,
      );
      const remediationComplete =
        run.stage !== "final-resolve" ||
        (implementer !== undefined &&
          this.childContinuations.get(implementer.id) === 1);
      if (
        boundary &&
        waitedAtBoundary &&
        remediationComplete &&
        boundary.roles.every((role) => this.roleHasValidReport(run, role))
      ) {
        run.stage = boundary.nextStage;
        this.notify();
      }
      return;
    }
    const roles =
      run.stage === "discover"
        ? run.definition === FEATURE_PIPELINE_ID
          ? FEATURE_PIPELINE_DISCOVERY_ROLES
          : PLAN_PIPELINE_DISCOVERY_ROLES
        : run.stage === "audit"
          ? run.definition === FEATURE_PIPELINE_ID
            ? STATIC_LUNA_AUDIT_ROLES
            : run.definition === PLAN_PIPELINE_ID
              ? PLAN_PIPELINE_AUDIT_ROLES
              : []
          : [];
    const nextStage =
      run.stage === "discover"
        ? "build"
        : run.stage === "audit"
          ? "audit-resolve"
          : undefined;
    if (
      !nextStage ||
      !waitedChildren.some((child) =>
        roles.some((role) => role === child.role),
      ) ||
      roles.some((role) => !this.roleHasValidReport(run, role))
    ) {
      return;
    }
    run.stage = nextStage;
    this.notify();
  }

  setStage(runId: string, stage: PipelineStage) {
    const run = this.requireActiveRun(runId);
    if (run.definition === SMALL_FEATURE_PIPELINE_ID) {
      const stages = stagesForDefinition(run.definition);
      const currentIndex = stages.indexOf(run.stage);
      const nextIndex = stages.indexOf(stage);
      if (
        nextIndex < 0 ||
        nextIndex < currentIndex ||
        nextIndex > currentIndex + 1
      ) {
        throw new Error(
          `Invalid small-feature-pipeline stage transition: ${run.stage} to ${stage}.`,
        );
      }
      if (stage === "final-audit") {
        this.requireValidReports(run, [SMALL_FEATURE_IMPLEMENTER_ROLE], stage);
      } else if (stage === "final-resolve") {
        this.requireValidReports(run, STATIC_LUNA_AUDIT_ROLES, stage);
      } else if (stage === "complete") {
        if (
          this.childContinuations.get(
            this.agentsFor(runId).find(
              (agent) => agent.role === SMALL_FEATURE_IMPLEMENTER_ROLE,
            )?.id ?? "",
          ) !== 1
        ) {
          throw new Error(
            "small-feature-pipeline completion requires one same-session Luna remediation pass.",
          );
        }
        this.requireValidReports(
          run,
          SMALL_FEATURE_PIPELINE_CHILD_ROLES,
          stage,
        );
      }
    } else if (run.definition === AUDIT_PIPELINE_ID) {
      throw new Error("audit-pipeline stages are controller-owned.");
    } else if (
      run.definition === FEATURE_PIPELINE_ID &&
      stage === "discover" &&
      run.featureDiscoveryBootstrapped
    ) {
      throw new Error(
        "feature-pipeline cannot return to controller-owned discovery after bootstrap.",
      );
    } else if (
      run.definition === FEATURE_PIPELINE_ID &&
      stage === "final-resolve" &&
      !run.auditSegment?.finalReport
    ) {
      throw new Error(
        "feature-pipeline final-resolve requires a validated Luna audit synthesis.",
      );
    } else if (run.definition === PLAN_PIPELINE_ID) {
      const currentIndex = PIPELINE_STAGES.indexOf(run.stage);
      const nextIndex = PIPELINE_STAGES.indexOf(stage);
      if (nextIndex < currentIndex || nextIndex > currentIndex + 1) {
        throw new Error(
          `Invalid plan-pipeline stage transition: ${run.stage} to ${stage}.`,
        );
      }
      if (stage === "build") {
        this.requireValidReports(run, PLAN_PIPELINE_DISCOVERY_ROLES, stage);
      } else if (stage === "audit" && run.planArtifactsWritten.size === 0) {
        throw new Error("Cannot enter audit before writing a plan artifact.");
      } else if (stage === "audit-resolve") {
        this.requireValidReports(run, PLAN_PIPELINE_AUDIT_ROLES, stage);
      } else if (
        stage === "final-audit" &&
        run.planArtifactsWritten.size === 0
      ) {
        throw new Error(
          "Cannot enter final-audit before writing a plan artifact.",
        );
      } else if (stage === "final-resolve" && !run.auditSegment?.finalReport) {
        throw new Error(
          "plan-pipeline final-resolve requires a validated Luna audit synthesis.",
        );
      }
    }
    run.stage = stage;
    this.notify();
    return this.snapshot(run);
  }

  private featureAuditAdditionalContext(run: MutableRun) {
    const synthesis = run.featureDiscoverySynthesis;
    if (!synthesis) {
      throw new Error("Feature audit context is unavailable before promotion.");
    }
    return JSON.stringify({
      discoveryReports: this.featureDiscoveryReports(run),
      discoverySynthesis: synthesis,
      verificationChecks: run.featureSynthesisChecks,
      reviewedWorkspace: run.request.workingDir,
      reviewedState: "promoted final implementation plus any audit remediation",
    });
  }

  async spawnChild(
    runId: string,
    role: PipelineChildRole,
    additionalContext = "",
  ) {
    return this.spawnChildForRun(
      this.requireActiveRun(runId),
      role,
      additionalContext,
      false,
    );
  }

  private spawnChildForRun(
    run: MutableRun,
    role: PipelineChildRole,
    additionalContext: string,
    controllerOwnedDiscovery: boolean,
  ) {
    const runId = run.id;
    if (!roleBelongsToDefinition(run.definition, role)) {
      throw new Error(`Unsupported ${run.definition} child role "${role}".`);
    }
    if (
      run.definition === AUDIT_PIPELINE_ID ||
      role === AUDIT_SYNTHESIS_ROLE ||
      ((run.definition === FEATURE_PIPELINE_ID ||
        run.definition === PLAN_PIPELINE_ID) &&
        AUDIT_SEGMENT_LUNA_ROLES.some((auditRole) => auditRole === role) &&
        run.stage === "final-audit")
    ) {
      throw new Error(`${role} is controller-owned by the Luna audit segment.`);
    }
    if (!run.rootId)
      throw new Error(`Pipeline run "${runId}" has no root yet.`);
    const priorAttempts = this.agentsFor(runId).filter(
      (agent) => agent.role === role,
    );
    if (
      run.definition === FEATURE_PIPELINE_ID &&
      isFeatureDiscoveryRole(role)
    ) {
      if (!controllerOwnedDiscovery) {
        throw new Error(
          `${role} is controller-owned and unavailable to the selected feature-pipeline implementation root.`,
        );
      }
      if (run.stage !== "discover" || run.featureDiscoveryBootstrapped) {
        throw new Error(
          `${role} can only start during controller-owned feature discovery bootstrap.`,
        );
      }
    }
    if (
      run.definition === FEATURE_PIPELINE_ID &&
      AUDIT_SEGMENT_LUNA_ROLES.some((auditRole) => auditRole === role) &&
      run.stage !== "audit"
    ) {
      throw new Error(
        `${role} can only start during feature-pipeline stage audit.`,
      );
    }
    if (run.definition === SMALL_FEATURE_PIPELINE_ID) {
      const requiredStage =
        role === SMALL_FEATURE_IMPLEMENTER_ROLE ? "build" : "final-audit";
      if (run.stage !== requiredStage) {
        throw new Error(
          `${role} can only start during small-feature-pipeline stage ${requiredStage}.`,
        );
      }
      if (priorAttempts.length > 0) {
        throw new Error(
          `small-feature-pipeline role ${role} already has its allowed child session.`,
        );
      }
    } else if (run.definition === PLAN_PIPELINE_ID) {
      if (AUDIT_SEGMENT_LUNA_ROLES.some((auditRole) => auditRole === role)) {
        throw new Error(
          `${role} is controller-owned by the Luna audit segment.`,
        );
      }
      const requiredStage = role.startsWith("discover-") ? "discover" : "audit";
      if (run.stage !== requiredStage) {
        throw new Error(
          `${role} can only start during plan-pipeline stage ${requiredStage}.`,
        );
      }
      const latest = priorAttempts.at(-1);
      const replacementAllowed =
        priorAttempts.length === 1 &&
        latest?.status === "error" &&
        !latest.sessionFile;
      if (priorAttempts.length > 0 && !replacementAllowed) {
        throw new Error(
          `plan-pipeline role ${role} already has its allowed child session.`,
        );
      }
    }
    const attempt = priorAttempts.length + 1;
    const contextPolicy = childContextPolicyFor(run.definition, role);
    const priorReportRole = contextPolicy.priorReportRole;
    const priorReport = priorReportRole
      ? this.agentsFor(runId).find((agent) => agent.role === priorReportRole)
      : undefined;
    const hostContext =
      run.definition === FEATURE_PIPELINE_ID &&
      STATIC_LUNA_AUDIT_ROLES.some((auditRole) => auditRole === role)
        ? this.featureAuditAdditionalContext(run)
        : additionalContext;
    const promptContext = [
      ...(priorReport && priorReportRole
        ? [`${titleForRole(priorReportRole)} report:`, priorReport.finalText]
        : []),
      ...(contextPolicy.gitEvidence ? [this.gitEvidence(runId)] : []),
      hostContext,
    ]
      .filter((item) => item.trim())
      .join("\n");
    const spec = {
      scopeId: runId,
      parentId: run.rootId,
      role,
      attempt,
      title: titleForRole(role),
      model: modelForRole(role),
      cwd: run.request.workingDir,
      prompt: buildPipelineChildPrompt(
        run.definition,
        role,
        run.request,
        promptContext,
      ),
      persistent:
        run.definition === SMALL_FEATURE_PIPELINE_ID &&
        role === SMALL_FEATURE_IMPLEMENTER_ROLE,
      shouldStart: () => run.status === "starting" || run.status === "running",
    };
    return this.tree.spawn(spec);
  }

  listChildren(runId: string) {
    const run = this.requireRun(runId);
    return run.rootId ? this.tree.view.childrenOf(run.rootId) : [];
  }

  getAgent(runId: string, id: string) {
    this.requireRun(runId);
    const agent = this.tree.view.get(id);
    if (!agent || agent.scopeId !== runId) {
      throw new Error(`Unknown agent id "${id}" for pipeline run "${runId}".`);
    }
    return agent;
  }

  async waitForChildren(
    runId: string,
    ids: ReadonlyArray<string>,
    signal?: AbortSignal,
  ) {
    for (const id of ids) {
      const agent = this.getAgent(runId, id);
      if (!agent.parentId)
        throw new Error(`Agent "${id}" is the pipeline root.`);
    }
    const children = await this.tree.wait(ids, signal);
    const run = this.requireRun(runId);
    if (
      run.definition === SMALL_FEATURE_PIPELINE_ID &&
      (run.status === "starting" || run.status === "running")
    ) {
      const invalid = children.find((child) => {
        if (child.status === "error" || child.status === "cancelled") {
          return true;
        }
        return (
          validatePipelineReport(run.definition, child.role, child.finalText)
            .length > 0
        );
      });
      if (invalid) {
        this.failRun(
          run,
          `small-feature-pipeline child ${invalid.role} did not complete with a valid report.`,
          true,
        );
        return children;
      }
    }
    if (run.status === "starting" || run.status === "running") {
      this.advanceStageAfterFanIn(run, children);
    }
    return children;
  }

  async sendChild(runId: string, id: string, text: string) {
    const run = this.requireActiveRun(runId);
    const agent = this.getAgent(runId, id);
    if (!agent.parentId) throw new Error(`Agent "${id}" is the pipeline root.`);
    if (
      agent.role === AUDIT_SYNTHESIS_ROLE ||
      isFeatureInternalImplementationRole(agent.role) ||
      [...(run.auditSegment?.tracks.values() ?? [])].includes(id)
    ) {
      throw new Error(
        "Controller-owned synthesis and candidate sessions cannot be retried or continued.",
      );
    }
    if (
      run.definition === FEATURE_PIPELINE_ID &&
      isFeatureDiscoveryRole(agent.role)
    ) {
      throw new Error(
        "feature-pipeline discovery retries are controller-owned and unavailable to the selected implementation root.",
      );
    }
    if (run.definition === SMALL_FEATURE_PIPELINE_ID) {
      if (agent.role !== SMALL_FEATURE_IMPLEMENTER_ROLE) {
        throw new Error(
          "small-feature-pipeline audit children cannot be retried or continued.",
        );
      }
      if (run.stage !== "final-resolve") {
        throw new Error(
          "small-feature-pipeline Luna remediation can only run during final-resolve.",
        );
      }
      this.requireValidReports(run, STATIC_LUNA_AUDIT_ROLES, run.stage);
      if (agent.status !== "idle") {
        throw new Error(
          "small-feature-pipeline Luna must be idle before remediation.",
        );
      }
      if ((this.childContinuations.get(id) ?? 0) >= 1) {
        throw new Error(
          "small-feature-pipeline Luna already completed its remediation pass.",
        );
      }
    } else if (run.definition === PLAN_PIPELINE_ID) {
      if (agent.role === "final-audit") {
        throw new Error("plan-pipeline final-audit cannot be retried.");
      }
      if ((this.childContinuations.get(id) ?? 0) >= 1) {
        throw new Error(`plan-pipeline child "${id}" already used its retry.`);
      }
      const issues = validatePipelineReport(
        run.definition,
        agent.role,
        agent.finalText,
      );
      const retryable =
        agent.status === "error" ||
        ((agent.status === "done" || agent.status === "idle") &&
          issues.length > 0);
      if (!retryable) {
        throw new Error(
          `plan-pipeline child "${id}" has no failed or malformed report to retry.`,
        );
      }
    }
    const continuationText =
      run.definition === SMALL_FEATURE_PIPELINE_ID
        ? [
            "Independent Luna audit reports to resolve:",
            ...STATIC_LUNA_AUDIT_ROLES.flatMap((role) => [
              `${titleForRole(role)}:`,
              this.agentsFor(runId).find((candidate) => candidate.role === role)
                ?.finalText ?? "",
            ]),
            "Sol remediation instruction:",
            text,
          ].join("\n")
        : text;
    await this.tree.send(id, continuationText);
    if (
      run.definition === PLAN_PIPELINE_ID ||
      run.definition === SMALL_FEATURE_PIPELINE_ID
    ) {
      this.childContinuations.set(
        id,
        (this.childContinuations.get(id) ?? 0) + 1,
      );
    }
    return this.getAgent(runId, id);
  }

  async cancelChild(runId: string, id: string) {
    const run = this.requireRun(runId);
    const agent = this.getAgent(runId, id);
    if (!agent.parentId) throw new Error(`Agent "${id}" is the pipeline root.`);
    if (
      agent.role === AUDIT_SYNTHESIS_ROLE ||
      isFeatureInternalImplementationRole(agent.role) ||
      [...(run.auditSegment?.tracks.values() ?? [])].includes(id)
    ) {
      throw new Error(
        "Controller-owned synthesis and candidate sessions can only be cancelled with the whole pipeline run.",
      );
    }
    return this.tree.cancel(id);
  }

  writePlan(runId: string, planPath: string, content: string) {
    const run = this.requireActiveRun(runId);
    if (run.definition !== PLAN_PIPELINE_ID) {
      throw new Error("Plan artifacts can only be written by plan-pipeline.");
    }
    const artifact = writePlanArtifact(
      run.request.workingDir,
      planPath,
      content,
    );
    run.planArtifactsWritten.set(artifact.relativePath, {
      digest: artifact.digest,
      device: artifact.device,
      inode: artifact.inode,
    });
    return artifact;
  }

  validatePlan(runId: string, planPath: string) {
    const run = this.requireActiveRun(runId);
    if (run.definition !== PLAN_PIPELINE_ID) {
      throw new Error("Plan artifacts can only be validated by plan-pipeline.");
    }
    return resolvePlanArtifact(run.request.workingDir, planPath);
  }

  private commitFeatureWorktree(
    runId: string,
    role: string,
    workingDir: string,
  ) {
    const run = this.requireActiveRun(runId);
    if (run.definition !== FEATURE_PIPELINE_ID || !run.featureLifecycle) {
      throw new Error("Feature commit authority is unavailable for this run.");
    }
    if (!isFeatureInternalImplementationRole(role)) {
      throw new Error(
        "Only controller-owned feature candidates/synthesis may commit here.",
      );
    }
    return run.featureLifecycle.commitAssignedWorktree(role, workingDir);
  }

  gitStatus(runId: string) {
    const run = this.requireActiveRun(runId);
    try {
      return execFileSync("git", ["status", "--short", "--branch"], {
        cwd: run.request.workingDir,
        encoding: "utf8",
        maxBuffer: 64 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
    } catch (error) {
      return `Git status unavailable: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  private gitEvidence(runId: string) {
    return `Captured host-side Git evidence (read-only):\n${JSON.stringify(this.auditGitIdentity(this.requireActiveRun(runId)), null, 2)}`;
  }

  private finalGitFacts(run: MutableRun) {
    const evidence = this.auditGitIdentity(run);
    const compact = (value: string) => value.slice(0, 2_048);
    return [
      `Final captured Git base: ${evidence.baseSha}`,
      `Final Git HEAD: ${evidence.headSha}`,
      `Final Git branch: ${evidence.branch}`,
      `Final base ancestry: ${evidence.baseIsAncestor}`,
      `Final Git status (${evidence.status.state}): ${compact(evidence.status.value)}`,
      `Final base..HEAD commits (${evidence.commits.state}): ${compact(evidence.commits.value)}`,
      `Final committed diff (${evidence.committedDiff.state}): ${compact(evidence.committedDiff.value)}`,
      `Final dirty HEAD..WORKTREE diff (${evidence.dirtyDiff.state}): ${compact(evidence.dirtyDiff.value)}`,
      `Final combined base..WORKTREE diff (${evidence.combinedDiff.state}): ${compact(evidence.combinedDiff.value)}`,
    ];
  }

  complete(runId: string, facts: PipelineCompletionFacts) {
    const run = this.requireActiveRun(runId);
    const activeChildren = this.agentsFor(runId).filter(
      (agent) =>
        agent.parentId &&
        (agent.status === "starting" || agent.status === "running"),
    );
    if (activeChildren.length > 0) {
      throw new Error(
        `Cannot complete pipeline run "${runId}" while children are active: ${activeChildren.map((agent) => agent.id).join(", ")}.`,
      );
    }
    if (facts.workingDir !== run.request.workingDir) {
      throw new Error(
        `pipeline_complete working_dir must be ${run.request.workingDir}.`,
      );
    }
    let completion = facts;
    if (run.definition === AUDIT_PIPELINE_ID) {
      throw new Error(
        "audit-pipeline completion is controller-owned and requires a validated final synthesis report.",
      );
    }
    if (run.definition === SMALL_FEATURE_PIPELINE_ID) {
      if (run.stage !== "complete") {
        throw new Error(
          "small-feature-pipeline must finish same-session Luna remediation before completion.",
        );
      }
      this.requireValidReports(
        run,
        SMALL_FEATURE_PIPELINE_CHILD_ROLES,
        "complete",
      );
      completion = {
        ...facts,
        git: [...facts.git, ...this.finalGitFacts(run)],
      };
    } else if (run.definition === PLAN_PIPELINE_ID) {
      if (run.stage !== "complete") {
        throw new Error("plan-pipeline must enter complete before completion.");
      }
      this.requireValidReports(
        run,
        [...PLAN_PIPELINE_DISCOVERY_ROLES, ...PLAN_PIPELINE_AUDIT_ROLES],
        "complete",
      );
      if (!run.auditSegment?.finalReport) {
        throw new Error(
          "plan-pipeline completion requires a validated Luna audit synthesis.",
        );
      }
      if (!run.finalAuditReportDelivered) {
        throw new Error(
          "plan-pipeline completion requires delivering the validated final audit report to final-resolve.",
        );
      }
      requireFinalFindingResolutionEvidence(run, facts);
      if (!facts.planPath) {
        throw new Error("plan-pipeline completion requires plan_path.");
      }
      const artifact = resolvePlanArtifact(
        run.request.workingDir,
        facts.planPath,
      );
      const written = run.planArtifactsWritten.get(artifact.relativePath);
      if (!written) {
        throw new Error(
          "plan_path must identify an artifact written by this plan-pipeline run.",
        );
      }
      if (
        written.digest !== artifact.digest ||
        written.device !== artifact.device ||
        written.inode !== artifact.inode
      ) {
        throw new Error(
          "plan_path changed after this plan-pipeline run wrote it.",
        );
      }
      completion = {
        ...facts,
        planPath: artifact.relativePath,
        changedPaths: [
          ...new Set([...facts.changedPaths, artifact.relativePath]),
        ],
        auditReport: run.auditSegment.finalReport,
      };
    } else if (run.definition === FEATURE_PIPELINE_ID) {
      if (!run.auditSegment?.finalReport) {
        throw new Error(
          "feature-pipeline completion requires a validated Luna audit synthesis.",
        );
      }
      if (!run.finalAuditReportDelivered) {
        throw new Error(
          "feature-pipeline completion requires delivering the validated final audit report to final-resolve.",
        );
      }
      requireFinalFindingResolutionEvidence(run, facts);
      completion = {
        ...facts,
        git: [...facts.git, ...this.finalGitFacts(run)],
        auditReport: run.auditSegment.finalReport,
      };
    }
    run.stage = "complete";
    run.status = "completed";
    run.finishedAt = Date.now();
    run.completion = completion;
    this.notify();
    this.deliver(run);
    return this.snapshot(run);
  }

  private async cancelActiveChildren(run: MutableRun) {
    const active = this.agentsFor(run.id).filter(
      (agent) =>
        agent.parentId &&
        (agent.status === "starting" || agent.status === "running"),
    );
    await Promise.allSettled(active.map((agent) => this.tree.cancel(agent.id)));
  }

  async cancelRun(runId: string) {
    const run = this.requireRun(runId);
    if (run.status !== "starting" && run.status !== "running")
      return this.snapshot(run);
    run.status = "cancelled";
    run.finishedAt = Date.now();
    this.notify();
    await this.cancelActiveChildren(run);
    if (run.rootId) await this.tree.cancel(run.rootId);
    this.cleanupFeatureLifecycle(run);
    this.deliver(run);
    return this.snapshot(run);
  }

  private requireRun(runId: string) {
    const run = this.runs.get(runId);
    if (!run) throw new Error(`Unknown pipeline run id "${runId}".`);
    return run;
  }

  private requireActiveRun(runId: string) {
    const run = this.requireRun(runId);
    if (run.status !== "starting" && run.status !== "running") {
      throw new Error(`Pipeline run "${runId}" is ${run.status}.`);
    }
    return run;
  }

  createRootTools(runId: string): ToolDefinition[] {
    const controller = this;
    const run = this.requireRun(runId);
    const roles = rolesForDefinition(run.definition).filter(
      (role) =>
        role !== AUDIT_SYNTHESIS_ROLE &&
        role !== EXECUTOR_AUDIT_ROLE &&
        !(
          run.definition === PLAN_PIPELINE_ID &&
          AUDIT_SEGMENT_LUNA_ROLES.some((auditRole) => auditRole === role)
        ),
    );
    const tools: ToolDefinition[] = [
      defineTool({
        name: "pipeline_stage",
        label: "Pipeline Stage",
        description: `Record the current ${run.definition} stage.`,
        parameters: Type.Object({
          stage: StringEnum(stagesForDefinition(run.definition)),
        }),
        async execute(_id, params) {
          const run = controller.setStage(runId, params.stage);
          return {
            content: [{ type: "text", text: `Pipeline stage: ${run.stage}` }],
            details: { runId, stage: run.stage },
          };
        },
      }),
      defineTool({
        name: "pipeline_child_spawn",
        label: "Spawn Pipeline Child",
        description: `Start one allowed agent-driven ${run.definition} Luna role.`,
        parameters: Type.Object({
          role: StringEnum(roles),
          context: Type.Optional(Type.String({ maxLength: 64 * 1024 })),
        }),
        async execute(_id, params) {
          const child = await controller.spawnChild(
            runId,
            params.role,
            params.context,
          );
          return {
            content: [
              {
                type: "text",
                text: `Started ${child.id}: ${child.role} attempt ${child.attempt} (${child.model}).`,
              },
            ],
            details: {
              runId,
              id: child.id,
              role: child.role,
              attempt: child.attempt,
              model: child.model,
            },
          };
        },
      }),
      defineTool({
        name: "pipeline_child_list",
        label: "List Pipeline Children",
        description: "List children and attempts in this pipeline run.",
        parameters: Type.Object({}),
        async execute() {
          const children = controller.listChildren(runId);
          return {
            content: [
              {
                type: "text",
                text:
                  children.length === 0
                    ? "No pipeline children."
                    : children
                        .map(
                          (child) =>
                            `${child.id} [${child.status}] ${child.role} attempt ${child.attempt} (${child.model})`,
                        )
                        .join("\n"),
              },
            ],
            details: { runId, children },
          };
        },
      }),
      defineTool({
        name: "pipeline_child_check",
        label: "Check Pipeline Child",
        description: "Inspect one child status and latest report.",
        parameters: Type.Object({ id: Type.String() }),
        async execute(_toolId, params) {
          const child = controller.getAgent(runId, params.id);
          if (!child.parentId)
            throw new Error(`Agent "${params.id}" is the pipeline root.`);
          const issues =
            child.role === AUDIT_SYNTHESIS_ROLE ||
            isFeatureInternalImplementationRole(child.role)
              ? []
              : validatePipelineReport(
                  run.definition,
                  child.role,
                  child.finalText,
                );
          const warning = issues.length
            ? `\n\n[Report contract violation: ${issues.join(" ")}]`
            : "";
          const resolutionHandoff =
            child.role === AUDIT_SYNTHESIS_ROLE
              ? finalAuditResolutionHandoff(run)
              : undefined;
          if (resolutionHandoff) run.finalAuditReportDelivered = true;
          return {
            content: [
              {
                type: "text",
                text:
                  resolutionHandoff ??
                  `${child.id} [${child.status}] ${child.role} attempt ${child.attempt}\n\n${child.error ?? (child.finalText || "(no report yet)")}${warning}`.slice(
                    0,
                    24 * 1024,
                  ),
              },
            ],
            details: { runId, id: child.id, status: child.status },
          };
        },
      }),
      defineTool({
        name: "pipeline_child_wait",
        label: "Wait for Pipeline Children",
        description:
          "Wait for known children, return their reports in this Sol context, and atomically enter the next stage when the full current-stage fan-in is valid.",
        parameters: Type.Object({
          ids: Type.Array(Type.String(), { minItems: 1, maxItems: 32 }),
        }),
        async execute(_toolId, params, signal, onUpdate) {
          onUpdate?.({
            content: [
              { type: "text", text: `Waiting for ${params.ids.join(", ")}...` },
            ],
            details: { runId, pending: params.ids },
          });
          const children = await controller.waitForChildren(
            runId,
            params.ids,
            signal,
          );
          const resolutionHandoff = children.some(
            ({ role }) => role === AUDIT_SYNTHESIS_ROLE,
          )
            ? finalAuditResolutionHandoff(run)
            : undefined;
          const ordinaryReports = children
            .map((child) => {
              const issues =
                child.role === AUDIT_SYNTHESIS_ROLE ||
                isFeatureInternalImplementationRole(child.role)
                  ? []
                  : validatePipelineReport(
                      run.definition,
                      child.role,
                      child.finalText,
                    );
              const warning = issues.length
                ? `\n\n[Report contract violation: ${issues.join(" ")}]`
                : "";
              return `## ${child.id} · ${child.role} · attempt ${child.attempt} · ${child.status}\n\n${child.error ?? (child.finalText || "(no report)")}${warning}`;
            })
            .join("\n\n---\n\n")
            .slice(0, 48 * 1024);
          if (resolutionHandoff) run.finalAuditReportDelivered = true;
          const childStatuses = children
            .map(
              (child) =>
                `${child.id} · ${child.role} · attempt ${child.attempt} · ${child.status}`,
            )
            .join("\n");
          return {
            content: [
              {
                type: "text",
                text: resolutionHandoff
                  ? `${resolutionHandoff}\n\nSettled child statuses:\n${childStatuses}`
                  : ordinaryReports,
              },
            ],
            details: {
              runId,
              finalAuditReportDelivered: Boolean(resolutionHandoff),
              results: children.map((child) => ({
                id: child.id,
                role: child.role,
                attempt: child.attempt,
                status: child.status,
              })),
            },
          };
        },
      }),
      defineTool({
        name: "pipeline_child_send",
        label: "Send to Pipeline Child",
        description:
          "Continue or retry one known child in its existing session context.",
        parameters: Type.Object({
          id: Type.String(),
          message: Type.String({ minLength: 1, maxLength: 64 * 1024 }),
        }),
        async execute(_toolId, params) {
          const child = await controller.sendChild(
            runId,
            params.id,
            params.message,
          );
          return {
            content: [
              {
                type: "text",
                text: `Sent a continuation to ${child.id} (${child.role}).`,
              },
            ],
            details: { runId, id: child.id, status: child.status },
          };
        },
      }),
      defineTool({
        name: "pipeline_child_cancel",
        label: "Cancel Pipeline Child",
        description: "Cancel one known child in this pipeline run.",
        parameters: Type.Object({ id: Type.String() }),
        async execute(_toolId, params) {
          const child = await controller.cancelChild(runId, params.id);
          return {
            content: [{ type: "text", text: `Cancelled ${child.id}.` }],
            details: { runId, id: child.id, status: child.status },
          };
        },
      }),
      defineTool({
        name: "pipeline_complete",
        label: "Complete Pipeline",
        description:
          "Finish this run with factual handoff data and no readiness label.",
        parameters: completionSchema(),
        async execute(_toolId, params) {
          controller.complete(runId, {
            outcome: params.outcome,
            ...(params.plan_path ? { planPath: params.plan_path } : {}),
            changedPaths: params.changed_paths,
            checks: params.checks_evidence,
            assumptions: params.assumptions,
            git: params.git_commits,
            reports: params.report_summaries_references,
            unresolvedItems: params.unresolved_items,
            workingDir: params.working_dir,
          });
          return {
            content: [{ type: "text", text: `Pipeline ${runId} completed.` }],
            details: { runId },
            terminate: true,
          };
        },
      }),
    ];
    if (
      run.definition === FEATURE_PIPELINE_ID ||
      run.definition === PLAN_PIPELINE_ID
    ) {
      tools.splice(
        tools.length - 1,
        0,
        defineTool({
          name: "pipeline_audit_start",
          label: "Start Luna Audit Segment",
          description:
            "Start this hardcoded pipeline's controller-owned five-contributor Luna final audit and persistent incremental synthesizer.",
          parameters: Type.Object(
            {
              acceptance_contract: Type.String({
                minLength: 1,
                maxLength: 64 * 1024,
              }),
              assumptions: Type.Array(
                Type.String({ minLength: 1, maxLength: 8 * 1024 }),
                { maxItems: 128 },
              ),
              checks_evidence: Type.Array(
                Type.String({ minLength: 1, maxLength: 8 * 1024 }),
                { maxItems: 128 },
              ),
            },
            { additionalProperties: false },
          ),
          async execute(_toolId, params) {
            const agents = await controller.startFinalAudit(runId, {
              acceptanceContract: params.acceptance_contract,
              assumptions: params.assumptions,
              checks: params.checks_evidence,
            });
            return {
              content: [
                {
                  type: "text",
                  text: `Started controller-owned Luna audit segment: ${agents
                    .map((agent) => agent.id)
                    .join(", ")}.`,
                },
              ],
              details: {
                runId,
                agents: agents.map((agent) => ({
                  id: agent.id,
                  role: agent.role,
                  model: agent.model,
                })),
              },
            };
          },
        }),
      );
    }
    if (run.definition === PLAN_PIPELINE_ID) {
      tools.splice(
        1,
        0,
        defineTool({
          name: "pipeline_plan_write",
          label: "Write Pipeline Plan",
          description:
            "Write or replace this run's validated repository-local docs/plans Markdown artifact.",
          parameters: Type.Object({
            path: Type.String({ minLength: 1, maxLength: 16_384 }),
            content: Type.String({ minLength: 1, maxLength: 1024 * 1024 }),
          }),
          async execute(_toolId, params) {
            const artifact = controller.writePlan(
              runId,
              params.path,
              params.content,
            );
            return {
              content: [
                {
                  type: "text",
                  text: `Validated plan written: ${artifact.relativePath}`,
                },
              ],
              details: {
                runId,
                path: artifact.relativePath,
                bytes: Buffer.byteLength(artifact.content, "utf8"),
              },
            };
          },
        }),
        defineTool({
          name: "pipeline_plan_validate",
          label: "Validate Pipeline Plan",
          description:
            "Freshly validate one repository-local docs/plans Markdown artifact without modifying it.",
          parameters: Type.Object({
            path: Type.String({ minLength: 1, maxLength: 16_384 }),
          }),
          async execute(_toolId, params) {
            const artifact = controller.validatePlan(runId, params.path);
            return {
              content: [
                {
                  type: "text",
                  text: `Plan contract passed: ${artifact.relativePath} (${Buffer.byteLength(artifact.content, "utf8")} bytes).`,
                },
              ],
              details: { runId, path: artifact.relativePath },
            };
          },
        }),
        defineTool({
          name: "pipeline_git_status",
          label: "Pipeline Git Status",
          description:
            "Read the planning workspace Git branch and changed-path state without modifying it.",
          parameters: Type.Object({}),
          async execute() {
            const status = controller.gitStatus(runId);
            return {
              content: [
                { type: "text", text: status || "Working tree clean." },
              ],
              details: { runId },
            };
          },
        }),
      );
    }
    return tools;
  }

  async dispose() {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    await this.tree.dispose();
    for (const run of this.runs.values()) this.cleanupFeatureLifecycle(run);
    this.listeners.clear();
  }
}
