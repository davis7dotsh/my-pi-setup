/**
 * Fail-closed private backend: two persistent local MLX workers.
 *
 * - Each model gets its own worker process (switching models in one MLX-VLM
 *   server evicts the previous model).
 * - Workers bind to 127.0.0.1 on randomly allocated ports and require a
 *   per-worker bearer token passed through the environment.
 * - Hugging Face offline flags are forced so a worker can never download
 *   weights or call out; missing weights are a hard, descriptive error.
 * - One inference request is active at a time; cancellation kills both
 *   process groups (MLX inference cannot be interrupted over HTTP).
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

export const DEEPSEEK_OCR_MODEL = "mlx-community/DeepSeek-OCR-2-4bit";
export const QWEN_FUSION_MODEL = "mlx-community/Qwen3.5-4B-MLX-4bit";
export const MODELS_DIR = join(homedir(), ".cache", "custom-ocr", "models");

/** Repetition penalty benchmarked for DeepSeek-OCR transcription. */
export const OCR_REPETITION_PENALTY = 1.2;
export const OCR_MAX_TOKENS = 4096;
export const FUSION_MAX_TOKENS = 4096;

const PORT_TIMEOUT_MS = 60_000;
const LOAD_TIMEOUT_MS = 600_000;
const GENERATE_TIMEOUT_MS = 300_000;
const KILL_ESCALATION_MS = 3_000;

export type WorkerName = "ocr" | "fusion";

export const WORKER_MODELS: Record<WorkerName, string> = {
  ocr: DEEPSEEK_OCR_MODEL,
  fusion: QWEN_FUSION_MODEL,
};

export class PrivateModeError extends Error {
  override readonly name = "PrivateModeError";
}

/** Durable local snapshot path for a model id. */
export function modelInstallPath(modelId: string) {
  const name = modelId.split("/").at(-1);
  if (!name) throw new PrivateModeError(`Invalid model id: ${modelId}`);
  return join(MODELS_DIR, name);
}

export function isModelInstalled(modelId: string) {
  return existsSync(join(modelInstallPath(modelId), "config.json"));
}

export function missingModels() {
  return Object.values(WORKER_MODELS).filter(
    (modelId) => !isModelInstalled(modelId),
  );
}

export function installInstructions(models: readonly string[]) {
  const commands = models
    .map(
      (modelId) =>
        `  uv tool run --from huggingface_hub hf download ${modelId} --local-dir ${modelInstallPath(modelId)}`,
    )
    .join("\n");
  return `Private mode needs local model weights (downloaded once, ahead of time — private parsing itself never touches the network):\n${commands}`;
}

/**
 * Environment for a worker process: bearer token plus hard offline flags so
 * the worker can never reach Hugging Face or download weights.
 */
export function buildWorkerEnv(token: string) {
  return {
    CUSTOM_OCR_TOKEN: token,
    HF_HUB_OFFLINE: "1",
    HF_DATASETS_OFFLINE: "1",
    TRANSFORMERS_OFFLINE: "1",
    HF_HUB_DISABLE_TELEMETRY: "1",
    DO_NOT_TRACK: "1",
  };
}

export type WorkerEvent =
  | { readonly event: "listening"; readonly port: number }
  | { readonly event: "loaded" }
  | { readonly event: "error"; readonly message: string };

/** Parse a single stdout line from python/worker.py. */
export function parseWorkerEvent(line: string): WorkerEvent | undefined {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null) return undefined;
  const event = value as { event?: unknown; port?: unknown; message?: unknown };
  if (event.event === "listening" && typeof event.port === "number") {
    return { event: "listening", port: event.port };
  }
  if (event.event === "loaded") return { event: "loaded" };
  if (event.event === "error") {
    return {
      event: "error",
      message:
        typeof event.message === "string" ? event.message : "unknown error",
    };
  }
  return undefined;
}

export type WorkerStatus = "starting" | "loading" | "ready" | "failed";

interface WorkerHandle {
  readonly name: WorkerName;
  readonly modelId: string;
  readonly child: ChildProcess;
  readonly token: string;
  port?: number;
  status: WorkerStatus;
  error?: string;
  loaded: Promise<void>;
}

export interface WorkerStatusReport {
  readonly name: WorkerName;
  readonly modelId: string;
  readonly installed: boolean;
  readonly status: WorkerStatus | "stopped";
  readonly pid?: number;
  readonly port?: number;
  readonly error?: string;
}

function raceAbort<T>(promise: Promise<T>, signal?: AbortSignal) {
  if (!signal) return promise;
  return new Promise<T>((resolvePromise, rejectPromise) => {
    const onAbort = () =>
      rejectPromise(
        new PrivateModeError("Private worker request was cancelled."),
      );
    if (signal.aborted) return onAbort();
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolvePromise(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        rejectPromise(error);
      },
    );
  });
}

export class PrivateWorkerManager {
  private readonly pythonDir: string;
  private workers = new Map<WorkerName, WorkerHandle>();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(pythonDir: string) {
    this.pythonDir = pythonDir;
  }

  status() {
    return (Object.keys(WORKER_MODELS) as WorkerName[]).map((name) => {
      const modelId = WORKER_MODELS[name];
      const worker = this.workers.get(name);
      return {
        name,
        modelId,
        installed: isModelInstalled(modelId),
        status: worker?.status ?? "stopped",
        pid: worker?.child.pid,
        port: worker?.port,
        error: worker?.error,
      };
    });
  }

  isRunning() {
    return this.workers.size > 0;
  }

  /** Start both workers (if needed) and wait until both models are loaded. */
  async prewarm(signal?: AbortSignal) {
    const missing = missingModels();
    if (missing.length > 0) {
      throw new PrivateModeError(installInstructions(missing));
    }
    try {
      await Promise.all(
        (Object.keys(WORKER_MODELS) as WorkerName[]).map((name) =>
          raceAbort(this.ensureWorker(name).loaded, signal),
        ),
      );
    } catch (error) {
      if (signal?.aborted) this.stopAll();
      throw error;
    }
  }

  private ensureWorker(name: WorkerName) {
    const existing = this.workers.get(name);
    if (existing && existing.status !== "failed") return existing;
    if (existing) this.stopWorker(existing);

    const modelId = WORKER_MODELS[name];
    const modelPath = modelInstallPath(modelId);
    if (!isModelInstalled(modelId)) {
      throw new PrivateModeError(installInstructions([modelId]));
    }

    const token = randomBytes(24).toString("hex");
    const child = spawn(
      "uv",
      [
        "run",
        "--quiet",
        "--project",
        this.pythonDir,
        "--extra",
        "private",
        "python",
        join(this.pythonDir, "worker.py"),
        "--model",
        modelPath,
      ],
      {
        cwd: this.pythonDir,
        detached: true,
        env: { ...process.env, ...buildWorkerEnv(token) },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    const handle: WorkerHandle = {
      name,
      modelId,
      child,
      token,
      status: "starting",
      loaded: Promise.resolve(),
    };

    handle.loaded = new Promise<void>((resolvePromise, rejectPromise) => {
      let stderrTail = "";
      const portTimer = setTimeout(() => {
        fail(`worker did not report a port within ${PORT_TIMEOUT_MS / 1000}s`);
      }, PORT_TIMEOUT_MS);
      const loadTimer = setTimeout(() => {
        fail(`model did not load within ${LOAD_TIMEOUT_MS / 1000}s`);
      }, LOAD_TIMEOUT_MS);

      const settle = () => {
        clearTimeout(portTimer);
        clearTimeout(loadTimer);
      };
      const fail = (message: string) => {
        settle();
        handle.status = "failed";
        handle.error = message;
        this.stopWorker(handle);
        if (this.workers.get(name) === handle) this.workers.delete(name);
        rejectPromise(
          new PrivateModeError(
            `${name} worker (${modelId}) failed: ${message}`,
          ),
        );
      };

      if (child.stderr) {
        child.stderr.on("data", (chunk: Buffer) => {
          stderrTail = (stderrTail + chunk.toString()).slice(-2000);
        });
      }
      if (child.stdout) {
        const lines = createInterface({ input: child.stdout });
        lines.on("line", (line) => {
          const event = parseWorkerEvent(line);
          if (!event) return;
          if (event.event === "listening") {
            clearTimeout(portTimer);
            handle.port = event.port;
            handle.status = "loading";
          } else if (event.event === "loaded") {
            settle();
            handle.status = "ready";
            resolvePromise();
          } else {
            fail(event.message);
          }
        });
      }
      child.on("error", (error) => fail(error.message));
      child.on("exit", (code) => {
        if (handle.status !== "ready") {
          fail(
            `exited with code ${code}${stderrTail ? `\n${stderrTail.trim()}` : ""}`,
          );
        } else {
          handle.status = "failed";
          handle.error = `worker exited with code ${code}`;
          if (this.workers.get(name) === handle) this.workers.delete(name);
        }
      });
    });
    // Failures surface through generate()/prewarm(); avoid unhandled rejections.
    handle.loaded.catch(() => {});

    this.workers.set(name, handle);
    return handle;
  }

  /**
   * Run one generation request. Requests are serialized so only one inference
   * is active at a time across both workers.
   */
  generate(
    name: WorkerName,
    request: {
      readonly imagePath: string;
      readonly prompt: string;
      readonly maxTokens: number;
      readonly repetitionPenalty?: number;
    },
    signal?: AbortSignal,
  ) {
    const task = async () => {
      const worker = this.ensureWorker(name);
      try {
        await raceAbort(worker.loaded, signal);
      } catch (error) {
        if (signal?.aborted) this.stopAll();
        throw error;
      }
      if (worker.port === undefined) {
        throw new PrivateModeError(`${name} worker has no port.`);
      }

      const timeout = AbortSignal.timeout(GENERATE_TIMEOUT_MS);
      const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
      let response: Response;
      try {
        response = await fetch(`http://127.0.0.1:${worker.port}/generate`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${worker.token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            image: request.imagePath,
            prompt: request.prompt,
            max_tokens: request.maxTokens,
            repetition_penalty: request.repetitionPenalty,
          }),
          signal: combined,
        });
      } catch (cause) {
        if (signal?.aborted || timeout.aborted) {
          // MLX inference cannot be interrupted over HTTP; kill the process
          // groups so the machine is released immediately.
          this.stopAll();
          throw new PrivateModeError(
            "Private inference was cancelled; workers were unloaded.",
          );
        }
        throw new PrivateModeError(
          `Could not reach the ${name} worker: ${cause instanceof Error ? cause.message : String(cause)}`,
        );
      }

      const payload = (await response.json().catch(() => undefined)) as
        { text?: unknown; error?: unknown } | undefined;
      if (!response.ok || typeof payload?.text !== "string") {
        const detail =
          typeof payload?.error === "string"
            ? payload.error
            : `HTTP ${response.status}`;
        throw new PrivateModeError(`${name} worker request failed: ${detail}`);
      }
      return payload.text;
    };

    const run = this.queue.then(task, task);
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private stopWorker(worker: WorkerHandle) {
    const { pid } = worker.child;
    if (pid === undefined) return;
    try {
      // Negative pid kills the whole detached process group.
      process.kill(-pid, "SIGTERM");
    } catch {
      // Already gone.
    }
    const escalation = setTimeout(() => {
      if (worker.child.exitCode !== null || worker.child.signalCode !== null) {
        return;
      }
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }, KILL_ESCALATION_MS);
    escalation.unref();
  }

  /** Kill both process groups immediately. Idempotent. */
  stopAll() {
    for (const worker of this.workers.values()) {
      this.stopWorker(worker);
    }
    this.workers.clear();
  }
}
