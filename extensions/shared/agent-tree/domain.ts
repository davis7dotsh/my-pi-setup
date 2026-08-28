export type AgentNodeStatus =
  "starting" | "running" | "idle" | "done" | "error" | "cancelled";

export type AgentTranscriptItem =
  | { readonly kind: "user"; readonly text: string; readonly at: number }
  | {
      readonly kind: "assistant";
      readonly text: string;
      readonly thinking?: string;
      readonly at: number;
    }
  | {
      readonly kind: "tool";
      readonly phase: "call" | "result";
      readonly toolCallId: string;
      readonly name: string;
      readonly text: string;
      readonly isError: boolean;
      readonly at: number;
    };

export interface AgentNodeSnapshot {
  readonly id: string;
  readonly scopeId?: string;
  readonly parentId?: string;
  readonly role: string;
  readonly attempt: number;
  readonly title: string;
  readonly model: string;
  readonly thinkingLevel?:
    "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  readonly cwd: string;
  readonly persistent: boolean;
  readonly status: AgentNodeStatus;
  readonly createdAt: number;
  readonly settledAt?: number;
  readonly error?: string;
  readonly finalText: string;
  readonly transcript: ReadonlyArray<AgentTranscriptItem>;
  readonly liveAssistant?: {
    readonly text: string;
    readonly thinking: string;
  };
  readonly sessionFile?: string;
  readonly activeTools: ReadonlyArray<string>;
}

export type AgentTreeSessionEvent =
  | { readonly type: "run_started" }
  | { readonly type: "user"; readonly text: string }
  | {
      readonly type: "assistant_delta";
      readonly kind: "text" | "thinking";
      readonly delta: string;
    }
  | {
      readonly type: "assistant";
      readonly text: string;
      readonly thinking?: string;
    }
  | {
      readonly type: "tool";
      readonly phase: "call" | "result";
      readonly toolCallId: string;
      readonly name: string;
      readonly text: string;
      readonly isError: boolean;
    }
  | {
      readonly type: "settled";
      readonly outcome:
        | { readonly type: "completed"; readonly finalText: string }
        | {
            readonly type: "failed";
            readonly error: string;
            readonly finalText?: string;
          }
        | { readonly type: "cancelled"; readonly finalText?: string };
    };

export interface AgentTreeSession {
  readonly sessionFile?: string;
  readonly activeTools: ReadonlyArray<string>;
  readonly isStreaming: boolean;
  subscribe(listener: (event: AgentTreeSessionEvent) => void): () => void;
  prompt(text: string): Promise<void>;
  send(text: string): Promise<void>;
  /** Open the controller-validated mutation phase for a deferred two-phase agent. */
  enableMutation(): void;
  interrupt(): Promise<void>;
  dispose(): Promise<void> | void;
}

export interface AgentNodeSpec {
  readonly scopeId?: string;
  readonly parentId?: string;
  readonly role: string;
  readonly attempt: number;
  readonly title: string;
  readonly model: string;
  readonly thinkingLevel?: AgentNodeSnapshot["thinkingLevel"];
  readonly cwd: string;
  readonly prompt: string;
  readonly persistent?: boolean;
  /** Create and subscribe to the session without sending its first prompt yet. */
  readonly deferPrompt?: boolean;
  /** Recheck after asynchronous session creation, immediately before prompt. */
  readonly shouldStart?: () => boolean;
}

export interface AgentTreeSessionFactory {
  create(spec: AgentNodeSpec): Promise<AgentTreeSession>;
}

export interface AgentTreeReadModel {
  list(): ReadonlyArray<AgentNodeSnapshot>;
  get(id: string): AgentNodeSnapshot | undefined;
  childrenOf(parentId: string): ReadonlyArray<AgentNodeSnapshot>;
  subscribe(listener: () => void): () => void;
  subscribeTo(id: string, listener: () => void): () => void;
  requestSend(id: string, text: string): void;
  requestCancel(id: string): void;
}
