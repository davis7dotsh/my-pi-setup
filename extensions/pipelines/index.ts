import * as fs from "node:fs";
import * as path from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import {
  getMarkdownTheme,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Markdown, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { PipelineController } from "./controller.ts";
import { showPipelineDashboard } from "./dashboard.ts";
import {
  AUDIT_PIPELINE_ID,
  FEATURE_PIPELINE_ID,
  PIPELINE_DEFINITION_IDS,
  assertPipelineGitCommitSupported,
  type PipelineDefinitionId,
  type PipelineHandoff,
} from "./domain.ts";
import { createPipelineSessionFactory } from "./session.ts";
import {
  createPipelineInspectionTools,
  PIPELINE_CHECK_PARAMETERS,
  PIPELINE_LIST_PARAMETERS,
} from "./inspection.ts";

export { PIPELINE_CHECK_PARAMETERS, PIPELINE_LIST_PARAMETERS };

const AUDIT_INITIAL_PARAMETERS = Type.Object(
  {
    mode: Type.Literal("initial"),
    acceptance_criteria: Type.Optional(
      Type.Array(Type.String({ minLength: 1, maxLength: 8 * 1024 }), {
        maxItems: 128,
      }),
    ),
  },
  { additionalProperties: false },
);

const AUDIT_CLOSURE_PARAMETERS = Type.Object(
  {
    mode: Type.Literal("closure"),
    acceptance_criteria: Type.Optional(
      Type.Array(Type.String({ minLength: 1, maxLength: 8 * 1024 }), {
        maxItems: 128,
      }),
    ),
    prior_blockers: Type.Array(
      Type.Object(
        {
          id: Type.String({ minLength: 1, maxLength: 256 }),
          closure_condition: Type.String({ minLength: 1, maxLength: 8 * 1024 }),
        },
        { additionalProperties: false },
      ),
      { minItems: 1, maxItems: 128 },
    ),
    remediation_diff: Type.String({ minLength: 1, maxLength: 64 * 1024 }),
    touched_invariants: Type.Array(
      Type.String({ minLength: 1, maxLength: 8 * 1024 }),
      { minItems: 1, maxItems: 128 },
    ),
  },
  { additionalProperties: false },
);

export const PIPELINE_RUN_PARAMETERS = Type.Object(
  {
    pipeline: Type.Optional(
      StringEnum(PIPELINE_DEFINITION_IDS, {
        description:
          "Known hardcoded pipeline definition; defaults to feature-pipeline when omitted.",
      }),
    ),
    task: Type.String({
      description:
        "Self-contained feature task, planning goal, or audit scope; include known constraints or acceptance criteria when available. Closure-specific scope belongs in audit.",
      minLength: 1,
      maxLength: 64 * 1024,
    }),
    working_dir: Type.Optional(
      Type.String({
        description:
          "Existing working directory in which the pipeline operates. feature-pipeline requires Linux bubblewrap plus the root of a dedicated clean attached linked Git worktree and rejects the primary checkout; other definitions default to the current directory.",
        minLength: 1,
        maxLength: 16 * 1024,
      }),
    ),
    git_commit: Type.Optional(
      Type.Boolean({
        description:
          "feature-pipeline hard-requires explicit true, Linux bubblewrap, and a dedicated clean attached linked worktree; controller-owned candidates/synthesis and the post-promotion remediation root may make scoped ordinary commits. small-feature remains optional for its persistent implementer. Plan/audit reject true. Never permits push, delivery merge, history rewrite, deployment, or arbitrary branch/worktree operations.",
      }),
    ),
    audit: Type.Optional(
      Type.Union([AUDIT_INITIAL_PARAMETERS, AUDIT_CLOSURE_PARAMETERS], {
        description:
          "Typed initial or closure audit scope for audit-pipeline. No commands or refs are accepted.",
      }),
    ),
  },
  { additionalProperties: false },
);

export function resolvePipelineDefinition(requested?: string) {
  if (!requested) return FEATURE_PIPELINE_ID;
  const definition = PIPELINE_DEFINITION_IDS.find((id) => id === requested);
  if (!definition)
    throw new Error(`Unsupported pipeline definition: ${requested}`);
  return definition;
}

export function resolvePipelineWorkingDir(
  currentDirectory: string,
  requestedDirectory?: string,
) {
  return path.resolve(currentDirectory, requestedDirectory ?? currentDirectory);
}

export function handoffText(handoff: PipelineHandoff) {
  const facts = handoff.facts;
  const sections = [
    `Pipeline ${handoff.runId} ${handoff.status}.`,
    `Selected pipeline: ${handoff.definition}`,
    `Working directory: ${facts.workingDir}`,
    ...(facts.planPath ? [`Plan path: ${facts.planPath}`] : []),
    `Outcome:\n${facts.outcome}`,
    ...(facts.auditReport
      ? [
          `Structured audit report:\n${JSON.stringify(facts.auditReport, null, 2)}`,
        ]
      : []),
    `Changed paths:\n${facts.changedPaths.map((item) => `- ${item}`).join("\n") || "- none reported"}`,
    `Checks and evidence:\n${facts.checks.map((item) => `- ${item}`).join("\n") || "- none reported"}`,
    `Assumptions:\n${facts.assumptions.map((item) => `- ${item}`).join("\n") || "- none reported"}`,
    `Git and commits:\n${facts.git.map((item) => `- ${item}`).join("\n") || "- none reported"}`,
    `Reports:\n${facts.reports.map((item) => `- ${item}`).join("\n") || "- none reported"}`,
    `Unresolved items:\n${facts.unresolvedItems.map((item) => `- ${item}`).join("\n") || "- none reported"}`,
  ];
  if (handoff.error) sections.push(`Pipeline error:\n${handoff.error}`);
  return sections.join("\n\n");
}

export default function pipelines(pi: ExtensionAPI) {
  let controller: PipelineController | undefined;
  let sessionContext: ExtensionContext | undefined;
  let unsubscribeStatus: (() => void) | undefined;

  const updateStatus = () => {
    const ui = sessionContext?.hasUI ? sessionContext.ui : undefined;
    if (!ui || !controller) return;
    const runs = controller.list();
    if (runs.length === 0) {
      ui.setStatus("pipelines", undefined);
      return;
    }
    const running = runs.filter(
      (run) => run.status === "starting" || run.status === "running",
    ).length;
    const failed = runs.filter(
      (run) => run.status === "failed" || run.status === "cancelled",
    ).length;
    const done = runs.length - running - failed;
    const parts = [
      running ? ui.theme.fg("warning", `■ ${running} running`) : "",
      done ? ui.theme.fg("success", `■ ${done} done`) : "",
      failed ? ui.theme.fg("error", `■ ${failed} failed`) : "",
      ui.theme.fg("accent", "/pipelines") + ui.theme.fg("dim", " to view"),
    ].filter(Boolean);
    ui.setStatus(
      "pipelines",
      `${ui.theme.fg("muted", "pipelines:")} ${parts.join(ui.theme.fg("dim", " · "))}`,
    );
  };

  const deliver = (handoff: PipelineHandoff) => {
    if (!sessionContext) return;
    pi.sendMessage(
      {
        customType: "pipeline-handoff",
        content: handoffText(handoff),
        display: true,
        details: {
          runId: handoff.runId,
          status: handoff.status,
          definition: handoff.definition,
          workingDir: handoff.facts.workingDir,
        },
      },
      { deliverAs: "followUp", triggerTurn: true },
    );
  };

  const getController = (ctx: ExtensionContext) => {
    if (controller) return controller;
    let created: PipelineController;
    created = new PipelineController({
      createSessionFactory: (
        rootTools,
        definitionForRun,
        auditSubmit,
        auditSessionCreated,
        auditToolAllowed,
        discoverySubmit,
        discoverySessionCreated,
        discoveryToolAllowed,
        featureCommit,
      ) =>
        createPipelineSessionFactory({
          modelRegistry: ctx.modelRegistry,
          parentCwd: ctx.cwd,
          parentTrusted: ctx.isProjectTrusted(),
          rootTools,
          definitionForRun,
          auditSubmit,
          auditSessionCreated,
          auditToolAllowed,
          discoverySubmit,
          discoverySessionCreated,
          discoveryToolAllowed,
          featureCommit,
        }),
      onHandoff: deliver,
    });
    controller = created;
    unsubscribeStatus = created.subscribe(updateStatus);
    updateStatus();
    return created;
  };

  pi.on("session_start", (_event, ctx) => {
    sessionContext = ctx;
    updateStatus();
  });

  pi.on("session_shutdown", async () => {
    sessionContext = undefined;
    unsubscribeStatus?.();
    unsubscribeStatus = undefined;
    const closing = controller;
    controller = undefined;
    await closing?.dispose();
  });

  pi.registerTool({
    name: "pipeline_run",
    label: "Run Pipeline",
    description:
      "Start one of four known hardcoded pipelines in a caller-provided working directory and return its run id immediately: feature-pipeline, small-feature-pipeline, plan-pipeline, or audit-pipeline. Omit pipeline for feature-pipeline. Feature discovery and synthesis feed three parallel isolated Luna/xHIGH implementation candidates; one Luna/xHIGH synthesis agent selects a primary before writing, performs bounded primary-based augmentation, verifies/commits, promotes the exact result, cleans temporary worktrees, then starts independent audit/remediation. feature-pipeline requires git_commit=true, Linux bubblewrap, and a dedicated clean attached linked worktree; small-feature commit permission remains optional and plan/audit reject true.",
    promptSnippet:
      "Start a background implementation, planning, or Luna audit pipeline",
    promptGuidelines: [
      "Select a pipeline by requested outcome. Honor an explicit feature-pipeline, small-feature-pipeline, plan-pipeline, or audit-pipeline request. Use audit-pipeline for routine repository initial or closure audits that require four independent static Luna tracks, one executor-audit contributor, and incremental Luna synthesis without remediation. Use small-feature-pipeline for a bounded, well-specified implementation that fits one Luna implementation, four parallel independent Luna audit tracks, and one same-session Luna remediation pass. Use feature-pipeline for nontrivial new-feature implementation that needs discovery and multi-concern audit. Use plan-pipeline only when the requested deliverable is planning rather than implementation. Omission remains feature-pipeline.",
      "Automatically use plan-pipeline for a durable audited implementation plan, task breakdown, dependency waves, or test/release plan when at least one complexity signal applies: the goal spans two or more of frontend, backend, data, DevOps, or runtime; it includes migration, rollout, rollback, operational readiness, or cross-team sequencing; or acceptance criteria, scope, and dependencies require repository discovery. An explicit plan-pipeline request does not require a complexity signal.",
      "Do not choose plan-pipeline merely because an implementation request is cross-layer. Do not use implementation or planning pipelines for bugs, refactors, research-only work, or trivial edits; use audit-pipeline only when the requested outcome is a bounded repository audit rather than implementation. A small feature is bounded implementation work that still benefits from independent audit; it is not a synonym for a trivial edit. If the user has not made the desired deliverable—plan versus implementation—clear, ask before launching. git_commit is authoritative and never inferred from task prose. feature-pipeline rejects omission/false and requires Linux bubblewrap plus a dedicated clean attached linked worktree; its controller alone owns temporary candidate/synthesis branches, worktrees, exact promotion, and cleanup. No pipeline receives push, delivery-merge, history-rewrite, deployment, or external-state authority. After launch, do not duplicate work in the same workspace; use pipeline_check occasionally or /pipelines for live inspection while continuing only unrelated work. Do not poll; completion arrives automatically as a follow-up handoff.",
    ],
    parameters: PIPELINE_RUN_PARAMETERS,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const workingDir = resolvePipelineWorkingDir(ctx.cwd, params.working_dir);
      if (
        !fs.existsSync(workingDir) ||
        !fs.statSync(workingDir).isDirectory()
      ) {
        throw new Error(`working_dir is not a directory: ${workingDir}`);
      }
      const definition = resolvePipelineDefinition(params.pipeline);
      assertPipelineGitCommitSupported(definition, params.git_commit === true);
      if (params.audit && definition !== AUDIT_PIPELINE_ID) {
        throw new Error(
          "The audit input contract is only valid for audit-pipeline.",
        );
      }
      const audit = params.audit
        ? {
            mode: params.audit.mode,
            acceptanceCriteria: params.audit.acceptance_criteria ?? [],
            ...(params.audit.mode === "closure"
              ? {
                  priorBlockers: params.audit.prior_blockers.map((blocker) => ({
                    id: blocker.id,
                    closureCondition: blocker.closure_condition,
                  })),
                  remediationDiff: params.audit.remediation_diff,
                  touchedInvariants: params.audit.touched_invariants,
                }
              : {}),
          }
        : undefined;
      const runId = getController(ctx).start({
        task: params.task,
        workingDir,
        pipeline: definition,
        ...(params.git_commit !== undefined
          ? { gitCommit: params.git_commit }
          : {}),
        ...(audit ? { audit } : {}),
      });
      return {
        content: [
          {
            type: "text",
            text: `Started ${definition} ${runId} in ${workingDir}. It is running in the background; completion will arrive as a follow-up handoff.`,
          },
        ],
        details: { runId, definition, workingDir },
      };
    },
  });

  for (const tool of createPipelineInspectionTools(getController)) {
    pi.registerTool(tool);
  }

  pi.registerMessageRenderer(
    "pipeline-handoff",
    (message, { expanded }, theme) => {
      const details = (message.details ?? {}) as {
        runId?: string;
        status?: string;
        definition?: PipelineDefinitionId;
        workingDir?: string;
      };
      const failed = details.status !== "completed";
      const header =
        theme.fg(failed ? "error" : "success", "■") +
        " " +
        theme.fg(
          "accent",
          theme.bold(
            `${details.definition ?? FEATURE_PIPELINE_ID} ${details.runId ?? "?"}`,
          ),
        ) +
        theme.fg("muted", ` · ${details.status ?? "unknown"}`);
      const content =
        typeof message.content === "string" ? message.content : "";
      if (expanded) {
        const markdown = new Markdown(content, 0, 0, getMarkdownTheme());
        return {
          render: (width: number) => [
            ...new Text(header, 0, 0).render(width),
            ...markdown.render(width),
          ],
          invalidate: () => markdown.invalidate(),
        };
      }
      const preview = content.split("\n").slice(0, 8).join("\n");
      return new Text(`${header}\n${theme.fg("toolOutput", preview)}`, 0, 0);
    },
  );

  pi.registerCommand("pipelines", {
    description: "Inspect and take over pipeline runs and agents",
    handler: async (_args, ctx) => {
      const current = getController(ctx);
      if (ctx.mode !== "tui") {
        const runs = current.list();
        ctx.ui.notify(
          PIPELINE_DEFINITION_IDS.flatMap((definition) => [
            definition,
            ...runs
              .filter((run) => run.definition === definition)
              .map(
                (run) =>
                  `  ${run.id} [${run.status}] ${run.stage} ${run.workingDir}`,
              ),
          ]).join("\n"),
          "info",
        );
        return;
      }
      await showPipelineDashboard(ctx, current);
    },
  });
}
