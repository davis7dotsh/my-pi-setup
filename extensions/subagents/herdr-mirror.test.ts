import assert from "node:assert/strict";
import { mkdtemp, stat } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { SubagentSnapshot } from "./src/domain.ts";
import { startMirrorBridge } from "./src/herdr/bridge.ts";
import {
  startHerdrMirrorCoordinator,
  type HerdrMirrorAdapter,
  type MirrorLaunch,
} from "./src/herdr/coordinator.ts";
import { renderMirrorFrame } from "./src/herdr/viewer-render.ts";
import type { SubagentReadModel } from "./src/manager.ts";

function snapshot(
  id: string,
  overrides: Partial<SubagentSnapshot> = {},
): SubagentSnapshot {
  return {
    id,
    origin: "model",
    backend: "claude",
    title: `Task ${id}`,
    prompt: `Prompt ${id}`,
    cwd: process.cwd(),
    status: "running",
    createdAt: 1,
    meta: {
      backend: "claude",
      modelLabel: "claude-fable-5",
      contextWindow: 200_000,
      nativeSessionId: `native-${id}`,
    },
    usage: { tokens: 10_000, contextWindow: 200_000 },
    transcript: [],
    liveTools: [],
    queued: [],
    finalText: "",
    turns: 0,
    ...overrides,
  };
}

function createView(initial: SubagentSnapshot[] = []) {
  const snapshots = new Map(initial.map((item) => [item.id, item]));
  const listeners = new Set<() => void>();
  const idListeners = new Map<string, Set<() => void>>();
  const sent: Array<{ id: string; text: string }> = [];
  const aborted: string[] = [];
  const view: SubagentReadModel = {
    list: () => [...snapshots.values()],
    get: (id) => snapshots.get(id),
    size: () => snapshots.size,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    subscribeTo(id, listener) {
      const current = idListeners.get(id) ?? new Set();
      current.add(listener);
      idListeners.set(id, current);
      return () => current.delete(listener);
    },
    requestSend(id, text) {
      sent.push({ id, text });
    },
    requestAbort(id) {
      aborted.push(id);
    },
    setOnSettled() {},
  };
  return {
    view,
    sent,
    aborted,
    put(item: SubagentSnapshot) {
      snapshots.set(item.id, item);
      for (const listener of [...listeners]) listener();
      for (const listener of [...(idListeners.get(item.id) ?? [])]) listener();
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fakeAdapter(options: { failIds?: Set<string> } = {}) {
  const launches: MirrorLaunch[] = [];
  const closed: string[] = [];
  const created = new Map<string, ReturnType<typeof deferred<void>>>();
  const adapter: HerdrMirrorAdapter = {
    parent: {
      paneId: "w2:p-parent",
      workspaceId: "w2",
      label: "Parent Pi",
    },
    async createMirror(launch) {
      launches.push(launch);
      if (options.failIds?.has(launch.subagentId)) {
        throw new Error("pane creation failed");
      }
      created.get(launch.subagentId)?.resolve();
      return {
        paneId: `pane-${launch.subagentId}`,
        tabId: `tab-${launch.subagentId}`,
      };
    },
    async closeMirror(handle) {
      closed.push(handle.tabId);
    },
    async focusParent() {},
  };
  return {
    adapter,
    launches,
    closed,
    waitForCreate(id: string) {
      const signal = deferred<void>();
      created.set(id, signal);
      if (launches.some((launch) => launch.subagentId === id)) signal.resolve();
      return signal.promise;
    },
  };
}

async function connectLines(socketPath: string) {
  const socket = net.createConnection(socketPath);
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  let buffer = "";
  const lines: unknown[] = [];
  const waiters: Array<(message: unknown) => void> = [];
  socket.setEncoding("utf8");
  socket.on("data", (chunk) => {
    buffer += chunk;
    while (true) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      const waiter = waiters.shift();
      if (waiter) waiter(message);
      else lines.push(message);
    }
  });
  return {
    socket,
    send(message: unknown) {
      socket.write(`${JSON.stringify(message)}\n`);
    },
    next() {
      const current = lines.shift();
      if (current) return Promise.resolve(current);
      return new Promise<unknown>((resolve) => waiters.push(resolve));
    },
  };
}

test("coordinator mirrors each model-originated Fable once in the parent workspace", async () => {
  const first = snapshot("sa-1");
  const second = snapshot("sa-2");
  const view = createView([
    first,
    snapshot("sa-pi", { backend: "pi", meta: { backend: "pi" } }),
    snapshot("btw-1", { origin: "btw" }),
  ]);
  const herdr = fakeAdapter();
  const coordinator = await startHerdrMirrorCoordinator({
    view: view.view,
    adapter: herdr.adapter,
    bridge: { socketPath: "/private/socket", token: "secret" },
    viewerPath: "/extension/viewer.ts",
  });

  assert.equal(herdr.launches.length, 1);
  assert.deepEqual(herdr.launches[0], {
    subagentId: first.id,
    title: first.title,
    model: "claude-fable-5",
    cwd: first.cwd,
    parentPaneId: "w2:p-parent",
    parentLabel: "Parent Pi",
    workspaceId: "w2",
    socketPath: "/private/socket",
    token: "secret",
    viewerPath: "/extension/viewer.ts",
  });

  const created = herdr.waitForCreate(second.id);
  view.put(second);
  await created;
  view.put({ ...second, usage: { tokens: 20_000, contextWindow: 200_000 } });
  assert.deepEqual(
    herdr.launches.map((launch) => launch.subagentId),
    ["sa-1", "sa-2"],
  );

  await coordinator.close();
  assert.deepEqual(herdr.closed.sort(), ["tab-sa-1", "tab-sa-2"]);
});

test("pane creation failures are non-fatal and are not retried on every snapshot", async () => {
  const view = createView([snapshot("sa-1")]);
  const herdr = fakeAdapter({ failIds: new Set(["sa-1"]) });
  const coordinator = await startHerdrMirrorCoordinator({
    view: view.view,
    adapter: herdr.adapter,
    bridge: { socketPath: "/private/socket", token: "secret" },
    viewerPath: "/extension/viewer.ts",
  });

  view.put({ ...snapshot("sa-1"), finalText: "still running" });
  assert.equal(herdr.launches.length, 1);
  await coordinator.close();
  assert.deepEqual(herdr.closed, []);
});

test("authenticated bridge clients receive only their attached subagent snapshots", async () => {
  const view = createView([snapshot("sa-1"), snapshot("sa-2")]);
  const baseDir = await mkdtemp(path.join(os.tmpdir(), "fable-bridge-test-"));
  const bridge = await startMirrorBridge(view.view, { baseDir });
  const mode = (await stat(path.dirname(bridge.socketPath))).mode & 0o777;
  assert.equal(mode, 0o700);

  const first = await connectLines(bridge.socketPath);
  const second = await connectLines(bridge.socketPath);
  first.send({
    version: 1,
    type: "attach",
    token: bridge.token,
    subagentId: "sa-1",
  });
  second.send({
    version: 1,
    type: "attach",
    token: bridge.token,
    subagentId: "sa-2",
  });

  assert.equal(
    ((await first.next()) as { snapshot: SubagentSnapshot }).snapshot.id,
    "sa-1",
  );
  assert.equal(
    ((await second.next()) as { snapshot: SubagentSnapshot }).snapshot.id,
    "sa-2",
  );

  view.put({
    ...snapshot("sa-2"),
    liveAssistant: { text: "only second", thinking: "" },
  });
  const update = (await second.next()) as { snapshot: SubagentSnapshot };
  assert.equal(update.snapshot.id, "sa-2");
  assert.equal(update.snapshot.liveAssistant?.text, "only second");

  first.socket.destroy();
  second.socket.destroy();
  await bridge.close();
  await assert.rejects(stat(bridge.socketPath));
});

test("standalone renderer shows normalized transcript, tools, queue, usage, and status", () => {
  const frame = renderMirrorFrame(
    snapshot("sa-1", {
      status: "error",
      errorText: "Run was aborted",
      transcript: [
        { kind: "user", text: "Inspect this" },
        { kind: "assistant", parts: [{ type: "text", text: "Checking" }] },
        {
          kind: "toolResult",
          toolId: "tool-1",
          name: "Read",
          isError: false,
          outputPreview: "ok",
        },
      ],
      liveTools: [{ toolId: "tool-2", name: "Bash", outputPreview: "running" }],
      queued: [{ kind: "steer", text: "Also test it" }],
    }),
    { columns: 100, rows: 30, input: "next instruction" },
  ).join("\n");

  assert.match(frame, /sa-1.*Task sa-1.*failed/i);
  assert.match(frame, /claude-fable-5.*5%/);
  assert.match(frame, /Inspect this/);
  assert.match(frame, /Checking/);
  assert.match(frame, /Read.*ok/);
  assert.match(frame, /Bash.*running/);
  assert.match(frame, /queued steer.*Also test it/i);
  assert.match(frame, /Run was aborted/);
  assert.match(frame, /next instruction/);
});
