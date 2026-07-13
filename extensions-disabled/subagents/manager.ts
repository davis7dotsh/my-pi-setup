/**
 * SubagentManager - owns the lifecycle of in-process subagent sessions.
 *
 * Each subagent is a real AgentSession with its own session file (visible in
 * /resume), created via the pi SDK. Subagents are fire-and-forget: they run in
 * the background and settle to "done"/"error" whenever they go idle.
 */

import type { AssistantMessage, Message, Model } from "@earendil-works/pi-ai";
import type {
  AgentSession,
  ExtensionAPI,
  ModelRegistry,
} from "@earendil-works/pi-coding-agent";
import {
  createAgentSession,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import {
  bindChildSessionExtensions,
  childToolPolicy,
  createChildResources,
  shutdownAndDisposeChildSession,
} from "../shared/child-session.ts";
import type { ContextUtilization } from "../shared/context-utilization.ts";
import { createToolCallTimeoutGuard } from "../shared/tool-call-timeout.ts";
import {
  buildSubagentTaskPrompt,
  forwardSubagentTakeoverMessage,
} from "./prompt.ts";

export const MAX_RUNNING = 4;
export const MAX_TRACKED = 64;
const STOP_TIMEOUT_MS = 5_000;
const ERROR_TEXT_MAX_LENGTH = 4_096;

function boundedError(error: unknown) {
  return (error instanceof Error ? error.message : String(error)).slice(
    0,
    ERROR_TEXT_MAX_LENGTH,
  );
}

export const SUBAGENT_TOOL_NAMES = [
  "subagent_spawn",
  "subagent_wait",
  "subagent_cancel",
  "subagent_check",
  "subagent_list",
] as const;

export type ThinkingLevel = ReturnType<ExtensionAPI["getThinkingLevel"]>;

export type SubagentStatus = "running" | "done" | "error";

export interface Subagent {
  id: string;
  title: string;
  prompt: string;
  cwd: string;
  session: AgentSession;
  modelRegistry: ModelRegistry;
  status: SubagentStatus;
  createdAt: number;
  settledAt?: number;
  errorText?: string;
  /** Lightweight lifecycle listener used only for status accounting. */
  unsubscribeLifecycle?: () => void;
}

export interface SpawnOptions {
  prompt: string;
  title: string;
  cwd: string;
  model?: Model<any>;
  thinkingLevel?: ThinkingLevel;
  modelRegistry: ModelRegistry;
  projectTrusted: boolean;
}

/** Narrow an AgentMessage-ish value to a pi-ai Message role. */
export function messageRole(msg: unknown): Message["role"] | undefined {
  const role = (msg as { role?: string } | undefined)?.role;
  if (role === "user" || role === "assistant" || role === "toolResult")
    return role;
  return undefined;
}

function lastAssistantMessage(sub: Subagent): AssistantMessage | undefined {
  const messages = sub.session.messages;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (messageRole(msg) === "assistant") return msg as AssistantMessage;
  }
  return undefined;
}

/** Final assistant text output of a subagent (last assistant message with text). */
export function finalOutput(sub: Subagent): string {
  const messages = sub.session.messages;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (messageRole(msg) !== "assistant") continue;
    const assistant = msg as AssistantMessage;
    const text = assistant.content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n")
      .trim();
    if (text) return text;
  }
  return "";
}

/** Include the current partial assistant message while a child is streaming. */
export function latestOutput(sub: Subagent): string {
  const streaming = sub.session.agent.state.streamingMessage;
  if (streaming && messageRole(streaming) === "assistant") {
    const text = (streaming as AssistantMessage).content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n")
      .trim();
    if (text) return text;
  }
  return finalOutput(sub);
}

/** Active session model, refined by a registry-known gateway fallback. */
export function activeModel(sub: Subagent): Model<any> | undefined {
  const sessionModel = sub.session.model;
  const latest = lastAssistantMessage(sub);
  if (!latest) return sessionModel;
  if (
    sessionModel &&
    (latest.provider !== sessionModel.provider ||
      latest.model !== sessionModel.id)
  ) {
    // The session changed models after this assistant response.
    return sessionModel;
  }
  const reportedId = latest.responseModel ?? latest.model;
  return sub.modelRegistry.find(latest.provider, reportedId) ?? sessionModel;
}

/**
 * Current compaction-aware context occupancy and active model capacity.
 * AgentSession intentionally reports unknown tokens immediately after a
 * compaction until a new assistant response provides trustworthy usage.
 */
export function contextUsage(sub: Subagent): ContextUtilization {
  const usage = sub.session.getContextUsage();
  return {
    tokens: usage?.tokens,
    contextWindow: activeModel(sub)?.contextWindow ?? usage?.contextWindow,
  };
}

export function formatElapsed(sub: Subagent): string {
  const end = sub.settledAt ?? Date.now();
  const totalSeconds = Math.max(0, Math.round((end - sub.createdAt) / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0
    ? `${minutes}m${seconds.toString().padStart(2, "0")}s`
    : `${seconds}s`;
}

export class SubagentManager {
  private subagents = new Map<string, Subagent>();
  private counter = 0;
  private disposed = false;
  private reservedSpawns = 0;
  private disposing?: Promise<void>;
  private cancelling = new WeakSet<Subagent>();
  private cleanupTasks = new Set<Promise<void>>();
  private changeResolvers: Array<() => void> = [];
  private toolCallTimeout = createToolCallTimeoutGuard();
  /** Count of active subagent_wait calls interested in each id. */
  private waitInterest = new Map<string, number>();

  private changeListeners = new Set<() => void>();
  /** Fired when a subagent settles. `consumed` is true when a wait tool is collecting it. */
  onSettled?: (sub: Subagent, consumed: boolean) => void;

  list(): Subagent[] {
    return [...this.subagents.values()];
  }

  get(id: string): Subagent | undefined {
    return this.subagents.get(id);
  }

  size(): number {
    return this.subagents.size;
  }

  runningCount(): number {
    return this.list().filter((sub) => sub.status === "running").length;
  }

  /** Subscribe to any state change (status transitions, run start/end). */
  addChangeListener(listener: () => void): () => void {
    this.changeListeners.add(listener);
    return () => this.changeListeners.delete(listener);
  }

  private notifyChange() {
    const resolvers = this.changeResolvers;
    this.changeResolvers = [];
    for (const resolve of resolvers) resolve();
    for (const listener of this.changeListeners) {
      try {
        listener();
      } catch {
        // A failed renderer/status listener must not corrupt lifecycle state.
      }
    }
  }

  /** Resolves on the next state change, or immediately when the signal aborts. */
  nextChange(signal?: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      if (signal?.aborted) {
        resolve();
        return;
      }
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        const index = this.changeResolvers.indexOf(finish);
        if (index >= 0) this.changeResolvers.splice(index, 1);
        signal?.removeEventListener("abort", finish);
        resolve();
      };
      this.changeResolvers.push(finish);
      signal?.addEventListener("abort", finish, { once: true });
    });
  }

  async spawn(options: SpawnOptions): Promise<Subagent> {
    if (this.disposed) throw new Error("Subagent manager is shutting down.");
    if (this.runningCount() + this.reservedSpawns >= MAX_RUNNING) {
      throw new Error(
        `Max ${MAX_RUNNING} subagents can run concurrently. Wait for one to finish (subagent_wait) before spawning another.`,
      );
    }

    // Reserve before the first await so parallel tool calls cannot race past
    // the global spawn limit.
    this.reservedSpawns++;
    let session: AgentSession | undefined;
    try {
      const { loader: resourceLoader, settingsManager } =
        await createChildResources({
          cwd: options.cwd,
          projectTrusted: options.projectTrusted,
        });
      ({ session } = await createAgentSession({
        cwd: options.cwd,
        sessionManager: SessionManager.create(options.cwd),
        settingsManager,
        resourceLoader,
        modelRegistry: options.modelRegistry,
        model: options.model,
        thinkingLevel: options.thinkingLevel,
        ...childToolPolicy(),
      }));
      await bindChildSessionExtensions(session);
      this.toolCallTimeout.apply(session);

      if (this.disposed) {
        throw new Error("Subagent manager shut down while spawning.");
      }

      const id = `sa-${++this.counter}`;
      const sub: Subagent = {
        id,
        title: options.title,
        prompt: options.prompt,
        cwd: options.cwd,
        session,
        modelRegistry: options.modelRegistry,
        status: "running",
        createdAt: Date.now(),
      };
      this.subagents.set(id, sub);
      sub.unsubscribeLifecycle = session.subscribe((event) => {
        if (this.disposed) return;
        if (event.type === "agent_start") {
          // Extensions may register tools between runs, so pick up any new
          // definitions before this run can execute one.
          this.toolCallTimeout.apply(sub.session);
          sub.status = "running";
          sub.settledAt = undefined;
          sub.errorText = undefined;
          this.notifyChange();
        } else if (event.type === "agent_settled") {
          this.settle(sub);
        }
      });

      try {
        session.sessionManager.appendSessionInfo(`subagent: ${options.title}`);
      } catch {
        // Session naming is best-effort.
      }

      void this.run(sub, buildSubagentTaskPrompt(options.prompt));
      return sub;
    } catch (error) {
      if (session && !this.list().some((sub) => sub.session === session)) {
        await this.stopSession(session);
      }
      throw error;
    } finally {
      this.reservedSpawns--;
      this.notifyChange();
    }
  }

  /**
   * Send a message from the takeover view. While the agent is active, use the
   * SDK's steering queue rather than starting a second concurrent prompt().
   * If it is idle, the message starts a fresh run.
   */
  send(sub: Subagent, text: string) {
    if (
      this.disposed ||
      this.cancelling.has(sub) ||
      !this.subagents.has(sub.id)
    ) {
      return;
    }
    const message = forwardSubagentTakeoverMessage(text);
    if (sub.session.isStreaming) {
      sub.status = "running";
      sub.settledAt = undefined;
      this.notifyChange();
      void sub.session.steer(message).catch((error) => {
        sub.errorText = boundedError(error);
        this.notifyChange();
      });
      return;
    }
    void this.run(sub, message);
  }

  private async run(sub: Subagent, text: string) {
    if (
      this.disposed ||
      this.cancelling.has(sub) ||
      !this.subagents.has(sub.id)
    ) {
      return;
    }
    sub.status = "running";
    sub.settledAt = undefined;
    sub.errorText = undefined;
    this.notifyChange();
    try {
      await sub.session.prompt(text);
    } catch (error) {
      sub.errorText = boundedError(error);
      // Preflight failures may not start an agent lifecycle, so no
      // agent_settled event will arrive for them.
      if (!sub.session.isStreaming) this.settle(sub);
    }
  }

  private settle(sub: Subagent) {
    if (sub.status !== "running") return;
    sub.settledAt = Date.now();
    const last = lastAssistantMessage(sub);
    const failed =
      sub.errorText !== undefined ||
      last?.stopReason === "error" ||
      last?.stopReason === "aborted";
    sub.status = failed ? "error" : "done";
    if (!sub.errorText && last?.errorMessage) {
      sub.errorText = boundedError(last.errorMessage);
    }
    if (!sub.errorText && last?.stopReason === "aborted")
      sub.errorText = "Run was aborted";
    const consumed = (this.waitInterest.get(sub.id) ?? 0) > 0;
    this.notifyChange();
    // During teardown, don't queue results into a session that is shutting down.
    try {
      if (!this.disposed) this.onSettled?.(sub, consumed);
    } catch {
      // The parent session may already be unavailable; child settlement still
      // must remain final and cleanup must continue.
    }
    this.pruneSettled();
  }

  /**
   * Wait until all listed subagents are settled (not running).
   * While waiting, settles for these ids are marked "consumed" so results are
   * not additionally queued as follow-up messages.
   */
  async waitFor(
    ids: string[],
    signal?: AbortSignal,
    onPending?: (pendingIds: string[]) => void,
  ): Promise<void> {
    ids = [...new Set(ids)];
    for (const id of ids) {
      this.waitInterest.set(id, (this.waitInterest.get(id) ?? 0) + 1);
    }
    try {
      while (!signal?.aborted) {
        const pending = ids.filter((id) => this.get(id)?.status === "running");
        if (pending.length === 0) return;
        onPending?.(pending);
        await this.nextChange(signal);
      }
    } finally {
      for (const id of ids) {
        const count = (this.waitInterest.get(id) ?? 1) - 1;
        if (count <= 0) this.waitInterest.delete(id);
        else this.waitInterest.set(id, count);
      }
      this.pruneSettled();
    }
  }

  async abort(sub: Subagent) {
    if (sub.status !== "running" || this.cancelling.has(sub)) return;
    this.cancelling.add(sub);
    try {
      sub.session.clearQueue();
      sub.errorText = "Run was aborted";
      const stopped = await this.withTimeout(sub.session.abort());
      if (!stopped) {
        await shutdownAndDisposeChildSession(sub.session);
        sub.errorText = "Abort deadline exceeded; session was force-disposed";
      }
      if (sub.status === "running") {
        sub.errorText = sub.errorText ?? "Run was aborted";
        this.settle(sub);
      }
    } finally {
      this.cancelling.delete(sub);
    }
  }

  async disposeAll() {
    if (this.disposing) return this.disposing;
    this.disposed = true;
    this.disposing = (async () => {
      const subs = this.list();
      this.subagents.clear();
      await Promise.all(
        subs.map(async (sub) => {
          sub.unsubscribeLifecycle?.();
          sub.unsubscribeLifecycle = undefined;
          await this.stopSession(sub.session);
        }),
      );
      const spawnDeadline = Date.now() + STOP_TIMEOUT_MS;
      while (this.reservedSpawns > 0 && Date.now() < spawnDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      await Promise.allSettled([...this.cleanupTasks]);
      this.notifyChange();
    })();
    return this.disposing;
  }

  private async withTimeout(operation: Promise<unknown>) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), STOP_TIMEOUT_MS);
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

  private async stopSession(session: AgentSession) {
    try {
      session.clearQueue();
    } catch {
      // Continue with abort/dispose.
    }
    await this.withTimeout(session.abort());
    await shutdownAndDisposeChildSession(session);
  }

  private trackCleanup(task: Promise<void>) {
    this.cleanupTasks.add(task);
    void task.finally(() => this.cleanupTasks.delete(task));
  }

  private pruneSettled() {
    if (this.subagents.size <= MAX_TRACKED) return;
    const candidates = this.list()
      .filter(
        (sub) => sub.status !== "running" && !this.waitInterest.has(sub.id),
      )
      .sort(
        (left, right) =>
          (left.settledAt ?? left.createdAt) -
          (right.settledAt ?? right.createdAt),
      );
    for (const sub of candidates) {
      if (this.subagents.size <= MAX_TRACKED) break;
      this.subagents.delete(sub.id);
      sub.unsubscribeLifecycle?.();
      sub.unsubscribeLifecycle = undefined;
      try {
        sub.session.clearQueue();
      } catch {
        // Settled session cleanup is best-effort.
      }
      this.trackCleanup(shutdownAndDisposeChildSession(sub.session));
    }
  }
}
