import * as path from "node:path";
import {
  DefaultResourceLoader,
  getAgentDir,
  ProjectTrustStore,
  SettingsManager,
  type AgentSession,
  type SessionShutdownEvent,
} from "@earendil-works/pi-coding-agent";

const CHILD_SHUTDOWN_TIMEOUT_MS = 5_000;

/** Tools that headless children must not receive. Everything else stays enabled. */
export const PIPELINE_ROOT_EXCLUDED_TOOL_NAMES = [
  "subagent_spawn",
  "subagent_wait",
  "subagent_cancel",
  "subagent_check",
  "subagent_list",
  "workflow",
  "ask_user",
  "pipeline_run",
  "pipeline_check",
  "pipeline_list",
] as const;

export const PIPELINE_ORCHESTRATION_TOOL_NAMES = [
  "pipeline_stage",
  "pipeline_child_spawn",
  "pipeline_child_list",
  "pipeline_child_check",
  "pipeline_child_wait",
  "pipeline_child_send",
  "pipeline_child_cancel",
  "pipeline_complete",
  "pipeline_plan_write",
  "pipeline_plan_validate",
  "pipeline_git_status",
  "pipeline_audit_start",
] as const;

export const CHILD_EXCLUDED_TOOL_NAMES = [
  ...PIPELINE_ROOT_EXCLUDED_TOOL_NAMES,
  ...PIPELINE_ORCHESTRATION_TOOL_NAMES,
] as const;

export const SMALL_FEATURE_IMPLEMENTER_EXCLUDED_TOOL_NAMES = [
  "apply_patch_codex",
  "bg_start",
  "bg_kill",
  "codex_task",
  "mcp",
] as const;

export const PLAN_PIPELINE_MUTATING_TOOL_NAMES = [
  "bash",
  "edit",
  "write",
  "apply_patch_codex",
  "codex_task",
  "bg_start",
  "bg_kill",
  "mcp",
] as const;

/** F1/P1 discovery keeps ordinary bash so installed `gh` can read GitHub context. */
export function githubDiscoveryToolPolicy() {
  return {
    excludeTools: [
      ...CHILD_EXCLUDED_TOOL_NAMES,
      ...PLAN_PIPELINE_MUTATING_TOOL_NAMES.filter((tool) => tool !== "bash"),
    ],
  };
}

/** Executor audit keeps ordinary bash but no explicit mutation or delegation tools. */
export const EXECUTOR_AUDIT_EXCLUDED_TOOL_NAMES = [
  "edit",
  "write",
  "apply_patch_codex",
  "codex_task",
  "bg_start",
  "bg_kill",
  "mcp",
] as const;

/** Fresh SDK options avoid turning the denylist into an accidental allowlist. */
export function childToolPolicy() {
  return { excludeTools: [...CHILD_EXCLUDED_TOOL_NAMES] };
}

/** Pipeline roots keep only their run-scoped orchestration tools. */
export function pipelineRootToolPolicy() {
  return { excludeTools: [...PIPELINE_ROOT_EXCLUDED_TOOL_NAMES] };
}

export function smallFeatureImplementerToolPolicy() {
  return {
    excludeTools: [
      ...CHILD_EXCLUDED_TOOL_NAMES,
      ...SMALL_FEATURE_IMPLEMENTER_EXCLUDED_TOOL_NAMES,
    ],
  };
}

/** Feature candidates use this denylist plus a session-local scoped-tool allowlist. */
export function featureIsolatedImplementerToolPolicy() {
  return smallFeatureImplementerToolPolicy();
}

export function readOnlyPipelineRootToolPolicy() {
  return {
    excludeTools: [
      ...PIPELINE_ROOT_EXCLUDED_TOOL_NAMES,
      ...PLAN_PIPELINE_MUTATING_TOOL_NAMES,
    ],
  };
}

export function readOnlyPipelineChildToolPolicy() {
  return {
    excludeTools: [
      ...CHILD_EXCLUDED_TOOL_NAMES,
      ...PLAN_PIPELINE_MUTATING_TOOL_NAMES,
    ],
  };
}

export function executorAuditToolPolicy() {
  return {
    excludeTools: [
      ...CHILD_EXCLUDED_TOOL_NAMES,
      ...EXECUTOR_AUDIT_EXCLUDED_TOOL_NAMES,
    ],
  };
}

export function planPipelineRootToolPolicy() {
  return readOnlyPipelineRootToolPolicy();
}

export function planPipelineChildToolPolicy() {
  return readOnlyPipelineChildToolPolicy();
}

export interface ChildResourceOptions {
  cwd: string;
  projectTrusted: boolean;
  appendSystemPrompt?: string[];
  agentDir?: string;
}

/** Load normal global/package resources and trust-gated project resources. */
export async function createChildResources(options: ChildResourceOptions) {
  const agentDir = options.agentDir ?? getAgentDir();
  const settingsManager = SettingsManager.create(options.cwd, agentDir, {
    projectTrusted: options.projectTrusted,
  });
  const loader = new DefaultResourceLoader({
    cwd: options.cwd,
    agentDir,
    settingsManager,
    ...(options.appendSystemPrompt
      ? { appendSystemPrompt: options.appendSystemPrompt }
      : {}),
  });
  await loader.reload();
  return { loader, settingsManager };
}

/**
 * Same-directory children inherit the live parent decision. An alternate cwd
 * is trusted only when Pi's persisted trust store explicitly trusts it (or a
 * containing directory); unreadable/invalid trust data fails closed.
 */
export function resolveStandaloneChildProjectTrust(options: {
  parentCwd: string;
  childCwd: string;
  parentTrusted: boolean;
  agentDir?: string;
}) {
  if (path.resolve(options.childCwd) === path.resolve(options.parentCwd)) {
    return options.parentTrusted;
  }
  try {
    const trustStore = new ProjectTrustStore(options.agentDir ?? getAgentDir());
    return trustStore.get(options.childCwd) === true;
  } catch {
    return false;
  }
}

/** Start child extension session hooks/resources in headless print mode. */
export async function bindChildSessionExtensions(
  session: Pick<AgentSession, "bindExtensions">,
) {
  await session.bindExtensions({ mode: "print" });
}

interface ChildExtensionRunner {
  hasHandlers(eventType: string): boolean;
  emit(event: SessionShutdownEvent): Promise<unknown>;
}

export interface DisposableChildSession {
  readonly extensionRunner: ChildExtensionRunner;
  dispose(): void;
}

const childShutdowns = new WeakMap<object, Promise<void>>();

function waitBounded(operation: Promise<unknown>, timeoutMs: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
  });
  return Promise.race([
    operation.then(
      () => undefined,
      () => undefined,
    ),
    timeout,
  ])
    .catch(() => {})
    .finally(() => {
      if (timer) clearTimeout(timer);
    });
}

/**
 * Emit child session_shutdown once, then dispose once. Hook failures and a
 * bounded hook deadline never prevent disposal.
 */
export function shutdownAndDisposeChildSession(
  session: DisposableChildSession,
  options: { timeoutMs?: number } = {},
) {
  const existing = childShutdowns.get(session);
  if (existing) return existing;

  const shutdown = (async () => {
    try {
      if (session.extensionRunner.hasHandlers("session_shutdown")) {
        await waitBounded(
          session.extensionRunner.emit({
            type: "session_shutdown",
            reason: "quit",
          }),
          options.timeoutMs ?? CHILD_SHUTDOWN_TIMEOUT_MS,
        );
      }
    } catch {
      // Extension runner inspection/emission is best-effort during teardown.
    } finally {
      try {
        session.dispose();
      } catch {
        // Disposal is terminal and must remain idempotent for callers.
      }
    }
  })();

  childShutdowns.set(session, shutdown);
  return shutdown;
}
