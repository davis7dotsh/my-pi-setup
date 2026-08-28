import { randomUUID } from "node:crypto";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  SessionManager,
  type AgentSession,
  type AgentSessionEvent,
  type ModelRegistry,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  AUDIT_SYNTHESIS_REPORT_SCHEMA,
  auditTrackReportSchema,
} from "./audit-segment.ts";
import {
  bindChildSessionExtensions,
  childToolPolicy,
  createChildResources,
  executorAuditToolPolicy,
  featureIsolatedImplementerToolPolicy,
  githubDiscoveryToolPolicy,
  pipelineRootToolPolicy,
  planPipelineChildToolPolicy,
  planPipelineRootToolPolicy,
  readOnlyPipelineChildToolPolicy,
  readOnlyPipelineRootToolPolicy,
  resolveStandaloneChildProjectTrust,
  shutdownAndDisposeChildSession,
  smallFeatureImplementerToolPolicy,
} from "../shared/child-session.ts";
import { createToolCallTimeoutGuard } from "../shared/tool-call-timeout.ts";
import {
  AUDIT_PIPELINE_ID,
  AUDIT_SEGMENT_LUNA_ROLES,
  AUDIT_SYNTHESIS_ROLE,
  EXECUTOR_AUDIT_ROLE,
  FEATURE_PIPELINE_DISCOVERY_ROLES,
  FEATURE_PIPELINE_ID,
  LUNA_MODEL,
  PLAN_PIPELINE_ID,
  SMALL_FEATURE_IMPLEMENTER_ROLE,
  SMALL_FEATURE_PIPELINE_ID,
  type FeaturePipelineDiscoveryRole,
  type PipelineDefinitionId,
  type PipelineLunaAuditRole,
} from "./domain.ts";
import { featureDiscoveryReportSchema } from "./discovery-report.ts";
import {
  FEATURE_CANDIDATE_ROLES,
  FEATURE_DISCOVERY_SYNTHESIS_ROLE,
  FEATURE_IMPLEMENTATION_SYNTHESIS_ROLE,
} from "./feature-best-of-three.ts";
import { createFeatureToolBoundary } from "./feature-sandbox.ts";
import type {
  AgentNodeSpec,
  AgentTreeSessionEvent,
  AgentTreeSessionFactory,
} from "../shared/agent-tree/domain.ts";

const INTERRUPT_TIMEOUT_MS = 5_000;

interface PipelineSessionFactoryOptions {
  readonly modelRegistry: Pick<ModelRegistry, "find">;
  readonly parentCwd: string;
  readonly parentTrusted: boolean;
  readonly rootTools: (runId: string) => ReadonlyArray<ToolDefinition>;
  readonly definitionForRun: (runId: string) => PipelineDefinitionId;
  readonly auditSubmit?: (
    runId: string,
    role: string,
    sessionToken: string,
    value: unknown,
  ) => void;
  readonly auditSessionCreated?: (
    runId: string,
    role: string,
    token: string,
  ) => void;
  readonly auditToolAllowed?: (runId: string, role: string) => boolean;
  readonly discoverySubmit?: (
    runId: string,
    role: string,
    sessionToken: string,
    value: unknown,
  ) => void;
  readonly discoverySessionCreated?: (
    runId: string,
    role: string,
    token: string,
  ) => void;
  readonly discoveryToolAllowed?: (runId: string, role: string) => boolean;
  readonly featureCommit?: (
    runId: string,
    role: string,
    workingDir: string,
  ) => string;
}

function textContent(message: Message) {
  if (typeof message.content === "string") return message.content;
  return message.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

function assistantContent(message: AssistantMessage) {
  return {
    text: message.content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n"),
    thinking: message.content
      .flatMap((part) =>
        part.type === "thinking" && !part.redacted ? [part.thinking] : [],
      )
      .join("\n"),
  };
}

async function waitForInterrupt(operation: Promise<unknown>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), INTERRUPT_TIMEOUT_MS);
    timer.unref?.();
  });
  const completed = operation.then(
    () => true as const,
    () => true as const,
  );
  const result = await Promise.race([completed, timeout]);
  if (timer) clearTimeout(timer);
  return result;
}

function safeJson(value: unknown) {
  try {
    return JSON.stringify(value).slice(0, 64 * 1024);
  } catch {
    return "[unserializable tool arguments]";
  }
}

function resultPreview(result: unknown) {
  if (!result || typeof result !== "object") return "";
  const content = Reflect.get(result, "content");
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (part): part is { type: "text"; text: string } =>
        !!part &&
        typeof part === "object" &&
        Reflect.get(part, "type") === "text" &&
        typeof Reflect.get(part, "text") === "string",
    )
    .map((part) => part.text)
    .join("\n");
}

function lastAssistant(session: AgentSession) {
  for (let index = session.messages.length - 1; index >= 0; index--) {
    const message = session.messages[index];
    if (message.role === "assistant") return message;
  }
  return undefined;
}

export function pipelineThinkingLevel(
  model: string,
  requested?: AgentNodeSpec["thinkingLevel"],
) {
  return requested ?? (model === LUNA_MODEL ? "medium" : "high");
}

function auditSubmissionRole(role: string) {
  if (role === AUDIT_SYNTHESIS_ROLE) return role;
  return AUDIT_SEGMENT_LUNA_ROLES.find((candidate) => candidate === role);
}

export function createPipelineDiscoverySubmitTool(
  role: FeaturePipelineDiscoveryRole,
  submit: (value: unknown) => void,
) {
  return defineTool({
    name: "pipeline_discovery_submit",
    label: "Submit Discovery Report",
    description:
      "Submit this role's complete feature discovery V2 report to the host and stop this turn.",
    parameters: featureDiscoveryReportSchema(role),
    async execute(_toolCallId, params) {
      submit(params);
      return {
        content: [
          {
            type: "text",
            text: "Discovery report recorded. Stop this turn.",
          },
        ],
        details: params,
        terminate: true,
      };
    },
  });
}

export function createPipelineAuditSubmitTool(
  role: typeof AUDIT_SYNTHESIS_ROLE | PipelineLunaAuditRole,
  submit: (value: unknown) => void,
) {
  return defineTool({
    name: "pipeline_audit_submit",
    label: "Submit Audit Report",
    description:
      "Submit the complete validated audit report to the host and stop this turn.",
    parameters:
      role === AUDIT_SYNTHESIS_ROLE
        ? AUDIT_SYNTHESIS_REPORT_SCHEMA
        : auditTrackReportSchema(role),
    async execute(_toolCallId, params) {
      submit(params);
      return {
        content: [
          {
            type: "text",
            text: "Audit report recorded. Stop this turn.",
          },
        ],
        details: params,
        terminate: true,
      };
    },
  });
}

export function pipelineSessionToolPolicy(
  definition: PipelineDefinitionId,
  isRoot: boolean,
  role: string,
) {
  if (role === FEATURE_DISCOVERY_SYNTHESIS_ROLE) {
    return readOnlyPipelineChildToolPolicy();
  }
  if (
    FEATURE_CANDIDATE_ROLES.some(
      (candidateRole) => `candidate-${candidateRole.toLowerCase()}` === role,
    ) ||
    role === FEATURE_IMPLEMENTATION_SYNTHESIS_ROLE
  ) {
    return featureIsolatedImplementerToolPolicy();
  }
  if (isRoot) {
    if (definition === AUDIT_PIPELINE_ID)
      return readOnlyPipelineChildToolPolicy();
    if (definition === PLAN_PIPELINE_ID) return planPipelineRootToolPolicy();
    if (definition === SMALL_FEATURE_PIPELINE_ID) {
      return readOnlyPipelineRootToolPolicy();
    }
    return pipelineRootToolPolicy();
  }
  if (role === EXECUTOR_AUDIT_ROLE) return executorAuditToolPolicy();
  if (
    role === AUDIT_SYNTHESIS_ROLE ||
    AUDIT_SEGMENT_LUNA_ROLES.some((auditRole) => auditRole === role)
  ) {
    return readOnlyPipelineChildToolPolicy();
  }
  if (definition === FEATURE_PIPELINE_ID && role === "discover-problem") {
    return githubDiscoveryToolPolicy();
  }
  if (definition === PLAN_PIPELINE_ID && role === "discover-goal-outcomes") {
    return githubDiscoveryToolPolicy();
  }
  if (
    definition === FEATURE_PIPELINE_ID &&
    FEATURE_PIPELINE_DISCOVERY_ROLES.some(
      (discoveryRole) => discoveryRole === role,
    )
  ) {
    return readOnlyPipelineChildToolPolicy();
  }
  if (definition === PLAN_PIPELINE_ID) return planPipelineChildToolPolicy();
  if (definition === SMALL_FEATURE_PIPELINE_ID) {
    return role === SMALL_FEATURE_IMPLEMENTER_ROLE
      ? smallFeatureImplementerToolPolicy()
      : readOnlyPipelineChildToolPolicy();
  }
  return childToolPolicy();
}

function finalText(session: AgentSession) {
  const message = lastAssistant(session);
  return message ? assistantContent(message).text.trim() : "";
}

function normalizeEvent(
  session: AgentSession,
  event: AgentSessionEvent,
): AgentTreeSessionEvent | undefined {
  if (event.type === "agent_start") return { type: "run_started" };
  if (event.type === "message_update") {
    if (event.assistantMessageEvent.type === "text_delta") {
      return {
        type: "assistant_delta",
        kind: "text",
        delta: event.assistantMessageEvent.delta,
      };
    }
    if (event.assistantMessageEvent.type === "thinking_delta") {
      return {
        type: "assistant_delta",
        kind: "thinking",
        delta: event.assistantMessageEvent.delta,
      };
    }
    return undefined;
  }
  if (event.type === "message_end") {
    if (event.message.role === "user") {
      return { type: "user", text: textContent(event.message) };
    }
    if (event.message.role === "assistant") {
      return { type: "assistant", ...assistantContent(event.message) };
    }
    return undefined;
  }
  if (event.type === "tool_execution_start") {
    return {
      type: "tool",
      phase: "call",
      toolCallId: event.toolCallId,
      name: event.toolName,
      text: safeJson(event.args),
      isError: false,
    };
  }
  if (event.type === "tool_execution_end") {
    return {
      type: "tool",
      phase: "result",
      toolCallId: event.toolCallId,
      name: event.toolName,
      text: resultPreview(event.result),
      isError: event.isError,
    };
  }
  if (event.type !== "agent_settled") return undefined;
  const last = lastAssistant(session);
  const output = finalText(session);
  if (last?.stopReason === "aborted") {
    return {
      type: "settled",
      outcome: { type: "cancelled", finalText: output },
    };
  }
  if (last?.stopReason === "error") {
    return {
      type: "settled",
      outcome: {
        type: "failed",
        error: last.errorMessage ?? "Pipeline agent run failed.",
        finalText: output,
      },
    };
  }
  return {
    type: "settled",
    outcome: { type: "completed", finalText: output },
  };
}

export function createPipelineSessionFactory(
  options: PipelineSessionFactoryOptions,
): AgentTreeSessionFactory {
  return {
    async create(spec: AgentNodeSpec) {
      const [provider, ...idParts] = spec.model.split("/");
      const model = options.modelRegistry.find(provider, idParts.join("/"));
      if (!model)
        throw new Error(
          `Required pipeline model is unavailable: ${spec.model}`,
        );
      const resources = await createChildResources({
        cwd: spec.cwd,
        projectTrusted: resolveStandaloneChildProjectTrust({
          parentCwd: options.parentCwd,
          childCwd: spec.cwd,
          parentTrusted: options.parentTrusted,
        }),
      });
      const isRoot = !spec.parentId;
      const definition = options.definitionForRun(spec.scopeId ?? "");
      const candidateRole = FEATURE_CANDIDATE_ROLES.find(
        (role) => `candidate-${role.toLowerCase()}` === spec.role,
      );
      const featureBoundary =
        definition === FEATURE_PIPELINE_ID &&
        (candidateRole || spec.role === FEATURE_IMPLEMENTATION_SYNTHESIS_ROLE)
          ? createFeatureToolBoundary({
              cwd: spec.cwd,
              mode: candidateRole ? "candidate" : "selection",
            })
          : undefined;
      const submissionRole = auditSubmissionRole(spec.role);
      const discoveryRole = FEATURE_PIPELINE_DISCOVERY_ROLES.find(
        (candidate) => candidate === spec.role,
      );
      const discoveryToolAllowed =
        !isRoot &&
        definition === FEATURE_PIPELINE_ID &&
        discoveryRole &&
        options.discoverySubmit &&
        options.discoveryToolAllowed?.(spec.scopeId ?? "", spec.role);
      const discoverySessionToken = discoveryToolAllowed
        ? randomUUID()
        : undefined;
      if (discoverySessionToken)
        options.discoverySessionCreated?.(
          spec.scopeId ?? "",
          spec.role,
          discoverySessionToken,
        );
      const discoveryTool =
        discoveryToolAllowed && discoverySessionToken && discoveryRole
          ? createPipelineDiscoverySubmitTool(discoveryRole, (value) =>
              options.discoverySubmit!(
                spec.scopeId ?? "",
                spec.role,
                discoverySessionToken,
                value,
              ),
            )
          : undefined;
      const auditToolAllowed =
        submissionRole &&
        options.auditSubmit &&
        options.auditToolAllowed?.(spec.scopeId ?? "", spec.role);
      const auditSessionToken = auditToolAllowed ? randomUUID() : undefined;
      if (auditSessionToken)
        options.auditSessionCreated?.(
          spec.scopeId ?? "",
          spec.role,
          auditSessionToken,
        );
      const auditTool =
        auditToolAllowed && auditSessionToken && submissionRole
          ? createPipelineAuditSubmitTool(submissionRole, (value) =>
              options.auditSubmit!(
                spec.scopeId ?? "",
                spec.role,
                auditSessionToken,
                value,
              ),
            )
          : undefined;
      const customTools =
        isRoot &&
        spec.role === "pipeline-root" &&
        definition !== AUDIT_PIPELINE_ID
          ? options.rootTools(spec.scopeId ?? "")
          : undefined;
      const featureCommitTool = featureBoundary
        ? defineTool({
            name: "pipeline_feature_commit",
            label: "Commit Feature Candidate State",
            description:
              "Ask the feature-pipeline controller to create an ordinary commit from all current changes in this assigned worktree. The controller validates ownership; agents cannot perform branch/worktree/history operations directly.",
            parameters: Type.Object({}, { additionalProperties: false }),
            async execute() {
              const head = options.featureCommit?.(
                spec.scopeId ?? "",
                spec.role,
                spec.cwd,
              );
              if (!head) {
                throw new Error(
                  "Controller feature commit authority is unavailable.",
                );
              }
              return {
                content: [
                  {
                    type: "text",
                    text: `Controller committed assigned worktree state at ${head}.`,
                  },
                ],
                details: { head },
              };
            },
          })
        : undefined;
      const sessionTools = [
        ...(customTools ?? []),
        ...(featureBoundary?.tools ?? []),
        ...(featureCommitTool ? [featureCommitTool] : []),
        ...(discoveryTool ? [discoveryTool] : []),
        ...(auditTool ? [auditTool] : []),
      ];
      const { session } = await createAgentSession({
        cwd: spec.cwd,
        model,
        thinkingLevel: pipelineThinkingLevel(spec.model, spec.thinkingLevel),
        sessionManager: SessionManager.create(spec.cwd),
        settingsManager: resources.settingsManager,
        resourceLoader: resources.loader,
        ...(sessionTools.length > 0 ? { customTools: sessionTools } : {}),
        ...(featureBoundary
          ? { tools: [...featureBoundary.initialActiveTools] }
          : {}),
        ...pipelineSessionToolPolicy(definition, isRoot, spec.role),
      });
      try {
        await bindChildSessionExtensions(session);
      } catch (error) {
        await shutdownAndDisposeChildSession(session);
        throw error;
      }

      const guard = createToolCallTimeoutGuard();
      guard.apply(session);
      const guardSubscription = session.subscribe((event) => {
        if (event.type === "agent_start") guard.apply(session);
      });
      let disposed = false;

      return {
        get sessionFile() {
          return session.sessionFile;
        },
        get activeTools() {
          return session.getActiveToolNames();
        },
        get isStreaming() {
          return session.isStreaming;
        },
        subscribe(listener) {
          return session.subscribe((event) => {
            const normalized = normalizeEvent(session, event);
            if (normalized) listener(normalized);
          });
        },
        prompt(text) {
          return session.prompt(text);
        },
        send(text) {
          return session.isStreaming
            ? session.steer(text)
            : session.prompt(text);
        },
        enableMutation() {
          if (!featureBoundary) return;
          featureBoundary.enableAugmentation();
          session.setActiveToolsByName([
            "read",
            "bash",
            "edit",
            "write",
            "pipeline_feature_commit",
          ]);
        },
        async interrupt() {
          if (disposed) return;
          try {
            session.clearQueue();
          } catch {
            // Abort remains authoritative.
          }
          const stopped = await waitForInterrupt(session.abort());
          if (!stopped) {
            disposed = true;
            guardSubscription();
            await shutdownAndDisposeChildSession(session);
          }
        },
        async dispose() {
          if (disposed) return;
          disposed = true;
          guardSubscription();
          await shutdownAndDisposeChildSession(session);
        },
      };
    },
  };
}
