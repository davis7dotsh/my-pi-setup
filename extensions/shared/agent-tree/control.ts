import type {
  AgentNodeSnapshot,
  AgentNodeSpec,
  AgentTreeReadModel,
  AgentTreeSession,
  AgentTreeSessionEvent,
  AgentTreeSessionFactory,
} from "./domain.ts";
import { appendTranscriptEvent } from "./transcript.ts";

const ERROR_LIMIT = 16 * 1024;
const FINAL_TEXT_LIMIT = 1024 * 1024;
const MAX_LIVE_TEXT = 128 * 1024;

interface MutableNode {
  id: string;
  scopeId?: string;
  parentId?: string;
  role: string;
  attempt: number;
  title: string;
  model: string;
  thinkingLevel?: AgentNodeSnapshot["thinkingLevel"];
  cwd: string;
  persistent: boolean;
  deferredPrompt: boolean;
  status: AgentNodeSnapshot["status"];
  createdAt: number;
  settledAt?: number;
  error?: string;
  finalText: string;
  transcript: AgentNodeSnapshot["transcript"] extends ReadonlyArray<infer T>
    ? T[]
    : never;
  liveAssistant?: { text: string; thinking: string };
  sessionFile?: string;
  activeTools: string[];
}

interface Entry {
  node: MutableNode;
  session?: AgentTreeSession;
  unsubscribe?: () => void;
}

export interface AgentTreeControllerOptions {
  readonly factory: AgentTreeSessionFactory;
  /** Capacity is a direct-subagent concern; pipeline controllers must omit it. */
  readonly capacity?: Readonly<Record<string, number>>;
  readonly makeId?: () => string;
}

export class AgentTreeController {
  private readonly entries = new Map<string, Entry>();
  private readonly listeners = new Set<() => void>();
  private readonly idListeners = new Map<string, Set<() => void>>();
  private readonly reservations = new Map<string, number>();
  private readonly factory: AgentTreeSessionFactory;
  private readonly capacity: Readonly<Record<string, number>>;
  private readonly makeId: () => string;
  private sequence = 0;
  private disposed = false;

  readonly view: AgentTreeReadModel;

  constructor(options: AgentTreeControllerOptions) {
    this.factory = options.factory;
    this.capacity = options.capacity ?? {};
    this.makeId = options.makeId ?? (() => `agent-${++this.sequence}`);
    this.view = {
      list: () => [...this.entries.values()].map((entry) => entry.node),
      get: (id) => this.entries.get(id)?.node,
      childrenOf: (parentId) =>
        [...this.entries.values()]
          .map((entry) => entry.node)
          .filter((node) => node.parentId === parentId),
      subscribe: (listener) => {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
      },
      subscribeTo: (id, listener) => {
        const listeners = this.idListeners.get(id) ?? new Set<() => void>();
        listeners.add(listener);
        this.idListeners.set(id, listeners);
        return () => {
          listeners.delete(listener);
          if (listeners.size === 0) this.idListeners.delete(id);
        };
      },
      requestSend: (id, text) => {
        void this.send(id, text).catch(() => {});
      },
      requestCancel: (id) => {
        void this.cancel(id).catch(() => {});
      },
    };
  }

  private notify(id?: string) {
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch {
        // Render/status listeners cannot affect lifecycle state.
      }
    }
    if (!id) return;
    for (const listener of [...(this.idListeners.get(id) ?? [])]) {
      try {
        listener();
      } catch {
        // Same.
      }
    }
  }

  private activeFor(model: string) {
    return [...this.entries.values()].filter(
      (entry) => entry.node.model === model && entry.node.status === "running",
    ).length;
  }

  private reserve(model: string) {
    const limit = this.capacity[model];
    if (limit === undefined) return;
    const reserved = this.reservations.get(model) ?? 0;
    if (this.activeFor(model) + reserved >= limit) {
      throw new Error(`Capacity for ${model} is full (max ${limit}).`);
    }
    this.reservations.set(model, reserved + 1);
  }

  private release(model: string) {
    const reserved = this.reservations.get(model) ?? 0;
    if (reserved <= 1) this.reservations.delete(model);
    else this.reservations.set(model, reserved - 1);
  }

  private settle(
    entry: Entry,
    event: Extract<AgentTreeSessionEvent, { type: "settled" }>,
  ) {
    const { node } = entry;
    node.settledAt = Date.now();
    node.liveAssistant = undefined;
    if (event.outcome.type === "completed") {
      node.status = node.persistent ? "idle" : "done";
      node.error = undefined;
      node.finalText = event.outcome.finalText.slice(0, FINAL_TEXT_LIMIT);
    } else if (event.outcome.type === "cancelled") {
      node.status = "cancelled";
      node.error = "Run was cancelled";
      node.finalText = (event.outcome.finalText ?? "").slice(
        0,
        FINAL_TEXT_LIMIT,
      );
    } else {
      node.status = "error";
      node.error = event.outcome.error.slice(0, ERROR_LIMIT);
      node.finalText = (event.outcome.finalText ?? "").slice(
        0,
        FINAL_TEXT_LIMIT,
      );
    }
    this.notify(node.id);
  }

  private onEvent(entry: Entry, event: AgentTreeSessionEvent) {
    if (event.type === "run_started") {
      entry.node.status = "running";
      entry.node.settledAt = undefined;
      entry.node.error = undefined;
    } else if (event.type === "settled") {
      this.settle(entry, event);
      return;
    } else if (event.type === "assistant_delta") {
      const live = entry.node.liveAssistant ?? { text: "", thinking: "" };
      entry.node.liveAssistant =
        event.kind === "text"
          ? {
              ...live,
              text: (live.text + event.delta).slice(-MAX_LIVE_TEXT),
            }
          : {
              ...live,
              thinking: (live.thinking + event.delta).slice(-MAX_LIVE_TEXT),
            };
    } else {
      if (event.type === "assistant") entry.node.liveAssistant = undefined;
      appendTranscriptEvent(entry.node.transcript, event);
    }
    this.notify(entry.node.id);
  }

  async spawn(spec: AgentNodeSpec) {
    if (this.disposed) throw new Error("Agent tree is disposed.");
    if (spec.parentId && !this.entries.has(spec.parentId)) {
      throw new Error(`Unknown parent agent id "${spec.parentId}".`);
    }
    this.reserve(spec.model);
    const id = this.makeId();
    const node: MutableNode = {
      id,
      ...(spec.scopeId ? { scopeId: spec.scopeId } : {}),
      ...(spec.parentId ? { parentId: spec.parentId } : {}),
      role: spec.role,
      attempt: spec.attempt,
      title: spec.title,
      model: spec.model,
      ...(spec.thinkingLevel ? { thinkingLevel: spec.thinkingLevel } : {}),
      cwd: spec.cwd,
      persistent: spec.persistent ?? false,
      deferredPrompt: spec.deferPrompt ?? false,
      status: "starting",
      createdAt: Date.now(),
      finalText: "",
      transcript: [],
      activeTools: [],
    };
    const entry: Entry = { node };
    this.entries.set(id, entry);
    this.notify(id);

    try {
      const session = await this.factory.create(spec);
      if (this.disposed) {
        await session.dispose();
        throw new Error("Agent tree was disposed while creating a session.");
      }
      entry.session = session;
      node.sessionFile = session.sessionFile;
      node.activeTools = [...session.activeTools];
      if (spec.shouldStart && !spec.shouldStart()) {
        node.status = "cancelled";
        node.settledAt = Date.now();
        node.error = "Run was cancelled before the agent started";
        await session.dispose();
        this.notify(id);
        return node as AgentNodeSnapshot;
      }
      entry.unsubscribe = session.subscribe((event) =>
        this.onEvent(entry, event),
      );
      node.status = spec.deferPrompt ? "idle" : "running";
      this.notify(id);
      if (!spec.deferPrompt) {
        void session.prompt(spec.prompt).catch((error) => {
          if (node.status !== "starting" && node.status !== "running") return;
          this.settle(entry, {
            type: "settled",
            outcome: {
              type: "failed",
              error: error instanceof Error ? error.message : String(error),
            },
          });
        });
      }
      return node as AgentNodeSnapshot;
    } catch (error) {
      node.status = "error";
      node.settledAt = Date.now();
      node.error = (
        error instanceof Error ? error.message : String(error)
      ).slice(0, ERROR_LIMIT);
      this.notify(id);
      throw error;
    } finally {
      this.release(spec.model);
    }
  }

  reparent(id: string, parentId: string) {
    const entry = this.entries.get(id);
    const parent = this.entries.get(parentId);
    if (!entry) throw new Error(`Unknown agent id "${id}".`);
    if (!parent) throw new Error(`Unknown parent agent id "${parentId}".`);
    if (id === parentId) throw new Error("An agent cannot parent itself.");
    if (entry.node.scopeId !== parent.node.scopeId) {
      throw new Error("Agents cannot be reparented across scopes.");
    }
    if (entry.node.status === "starting" || entry.node.status === "running") {
      throw new Error("An active agent cannot be reparented.");
    }
    let ancestor: Entry | undefined = parent;
    while (ancestor) {
      if (ancestor.node.id === id) {
        throw new Error("Reparenting would create an agent-tree cycle.");
      }
      ancestor = ancestor.node.parentId
        ? this.entries.get(ancestor.node.parentId)
        : undefined;
    }
    entry.node.parentId = parentId;
    this.notify(id);
  }

  async startDeferred(id: string, text: string) {
    const entry = this.entries.get(id);
    if (!entry?.session) throw new Error(`Unknown agent id "${id}".`);
    if (!entry.node.deferredPrompt) {
      throw new Error(`Agent "${id}" has no deferred prompt.`);
    }
    entry.node.deferredPrompt = false;
    try {
      await this.send(id, text);
    } catch (error) {
      entry.node.deferredPrompt = true;
      throw error;
    }
  }

  enableMutation(id: string) {
    const entry = this.entries.get(id);
    if (!entry?.session) throw new Error(`Unknown agent id "${id}".`);
    if (entry.node.status !== "idle" && entry.node.status !== "done") {
      throw new Error(
        `Agent "${id}" must be settled before mutation is enabled.`,
      );
    }
    entry.session.enableMutation();
    entry.node.activeTools = [...entry.session.activeTools];
    this.notify(id);
  }

  async send(id: string, text: string) {
    if (!text.trim()) throw new Error("Steering text must not be empty.");
    const entry = this.entries.get(id);
    if (!entry?.session) throw new Error(`Unknown agent id "${id}".`);
    if (entry.node.deferredPrompt) {
      throw new Error(`Agent "${id}" is waiting for controller bootstrap.`);
    }
    if (entry.node.status === "cancelled") {
      throw new Error(`Agent "${id}" was cancelled.`);
    }
    const restarting = entry.node.status !== "running";
    if (restarting) this.reserve(entry.node.model);
    const previousStatus = entry.node.status;
    entry.node.status = "running";
    entry.node.settledAt = undefined;
    entry.node.error = undefined;
    if (restarting) this.release(entry.node.model);
    this.notify(id);
    try {
      await entry.session.send(text);
    } catch (error) {
      entry.node.status = previousStatus;
      this.notify(id);
      throw error;
    }
  }

  async wait(ids: ReadonlyArray<string>, signal?: AbortSignal) {
    const unique = [...new Set(ids)];
    if (unique.length === 0) throw new Error("Provide at least one agent id.");
    const unknown = unique.filter((id) => !this.entries.has(id));
    if (unknown.length > 0) {
      throw new Error(`Unknown agent id(s): ${unknown.join(", ")}.`);
    }
    const isPending = () =>
      unique.some((id) => {
        const status = this.entries.get(id)?.node.status;
        return status === "starting" || status === "running";
      });
    if (!isPending()) return unique.map((id) => this.entries.get(id)!.node);

    await new Promise<void>((resolve, reject) => {
      const unsubscribe = this.view.subscribe(() => {
        if (!isPending()) finish(resolve);
      });
      const onAbort = () => finish(() => reject(new Error("Wait aborted.")));
      const finish = (complete: () => void) => {
        unsubscribe();
        signal?.removeEventListener("abort", onAbort);
        complete();
      };
      if (signal?.aborted) onAbort();
      else signal?.addEventListener("abort", onAbort, { once: true });
    });
    return unique.map((id) => this.entries.get(id)!.node);
  }

  async cancel(id: string) {
    const entry = this.entries.get(id);
    if (!entry?.session) throw new Error(`Unknown agent id "${id}".`);
    if (entry.node.status === "idle") {
      this.settle(entry, {
        type: "settled",
        outcome: { type: "cancelled", finalText: entry.node.finalText },
      });
      return entry.node as AgentNodeSnapshot;
    }
    if (entry.node.status !== "starting" && entry.node.status !== "running") {
      return entry.node as AgentNodeSnapshot;
    }
    await entry.session.interrupt();
    if (entry.node.status === "starting" || entry.node.status === "running") {
      this.settle(entry, {
        type: "settled",
        outcome: { type: "cancelled", finalText: entry.node.finalText },
      });
    }
    return entry.node as AgentNodeSnapshot;
  }

  async dispose() {
    if (this.disposed) return;
    this.disposed = true;
    const entries = [...this.entries.values()];
    await Promise.allSettled(
      entries.map(async (entry) => {
        entry.unsubscribe?.();
        if (
          entry.session &&
          (entry.node.status === "starting" || entry.node.status === "running")
        ) {
          await entry.session.interrupt().catch(() => {});
        }
        await entry.session?.dispose();
      }),
    );
    this.notify();
  }
}
