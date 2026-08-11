import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, stat } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { SubagentSnapshot } from "./src/domain.ts";
import { startMirrorBridge } from "./src/herdr/bridge.ts";
import { createHerdrMirrorAdapterFromEnvironment } from "./src/herdr/client.ts";
import {
  startHerdrMirrorCoordinator,
  type HerdrMirrorAdapter,
  type MirrorLaunch,
} from "./src/herdr/coordinator.ts";
import { parseBridgeMessage } from "./src/herdr/protocol.ts";
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
      sessionId: "parent-session",
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

test("outside Herdr the mirror adapter stays disabled", async () => {
  assert.equal(await createHerdrMirrorAdapterFromEnvironment({}), undefined);
});

test("adapter derives workspace and parent session when Herdr omits workspace env", async () => {
  const commands: string[][] = [];
  const adapter = await createHerdrMirrorAdapterFromEnvironment(
    {
      HERDR_ENV: "1",
      HERDR_PANE_ID: "w9:p-parent",
      HERDR_SOCKET_PATH: "/private/herdr.sock",
    },
    async (args) => {
      commands.push(args);
      if (args[0] === "pane" && args[1] === "get") {
        return JSON.stringify({
          result: {
            pane: {
              workspace_id: "w9",
              terminal_title_stripped: "Parent Pi",
              agent_session: { value: "parent-session-123" },
            },
          },
        });
      }
      if (args[0] === "tab" && args[1] === "create") {
        return JSON.stringify({
          result: {
            root_pane: { pane_id: "w9:p-child" },
            tab: { tab_id: "w9:t-child" },
          },
        });
      }
      return JSON.stringify({ result: { type: "ok" } });
    },
  );
  assert.ok(adapter);
  assert.deepEqual(adapter.parent, {
    paneId: "w9:p-parent",
    workspaceId: "w9",
    label: "Parent Pi",
    sessionId: "parent-session-123",
  });

  await adapter.createMirror({
    subagentId: "sa-1",
    title: "Inspect",
    model: "claude-fable-5",
    cwd: "/private/work",
    parent: adapter.parent,
    socketPath: "/private/bridge.sock",
    token: "capability",
    viewerPath: "/extension/viewer.ts",
  });
  const create = commands.find(
    (args) => args[0] === "tab" && args[1] === "create",
  );
  assert.ok(create);
  assert.ok(create.includes("w9"));
  assert.ok(create.includes("--no-focus"));
  assert.ok(
    create.includes("FABLE_MIRROR_PARENT_SESSION_ID=parent-session-123"),
  );
  assert.ok(
    commands.some(
      (args) =>
        args[0] === "pane" && args[1] === "run" && !args.includes("claude"),
    ),
  );
});

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
    bridge: {
      socketPath: "/private/socket",
      credentialFor: () => "secret",
    },
    viewerPath: "/extension/viewer.ts",
  });

  assert.equal(herdr.launches.length, 1);
  assert.deepEqual(herdr.launches[0], {
    subagentId: first.id,
    title: first.title,
    model: "claude-fable-5",
    cwd: first.cwd,
    parent: {
      paneId: "w2:p-parent",
      workspaceId: "w2",
      label: "Parent Pi",
      sessionId: "parent-session",
    },
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
    bridge: {
      socketPath: "/private/socket",
      credentialFor: () => "secret",
    },
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
  const socketMode = (await stat(bridge.socketPath)).mode & 0o777;
  assert.equal(mode, 0o700);
  assert.equal(socketMode, 0o600);

  const first = await connectLines(bridge.socketPath);
  const second = await connectLines(bridge.socketPath);
  first.send({
    version: 1,
    type: "attach",
    token: bridge.credentialFor("sa-1"),
    subagentId: "sa-1",
  });
  second.send({
    version: 1,
    type: "attach",
    token: bridge.credentialFor("sa-2"),
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
    liveAssistant: { text: "superseded token", thinking: "" },
  });
  view.put({
    ...snapshot("sa-2"),
    liveAssistant: { text: "only second", thinking: "" },
  });
  const update = (await second.next()) as { snapshot: SubagentSnapshot };
  assert.equal(update.snapshot.id, "sa-2");
  assert.equal(update.snapshot.liveAssistant?.text, "only second");

  first.socket.destroy();
  second.socket.destroy();
  assert.deepEqual(view.sent, []);
  assert.deepEqual(view.aborted, []);
  await bridge.close();
  await assert.rejects(stat(bridge.socketPath));
});

test("authenticated viewer actions stay bound to the attached subagent", async () => {
  const view = createView([snapshot("sa-1"), snapshot("sa-2")]);
  const baseDir = await mkdtemp(path.join(os.tmpdir(), "fable-actions-test-"));
  const actions: Array<{ action: string; id?: string; text?: string }> = [];
  const bridge = await startMirrorBridge(view.view, {
    baseDir,
    actions: {
      async send(id, text) {
        actions.push({ action: "send", id, text });
      },
      async abort(id) {
        actions.push({ action: "abort", id });
      },
      async focusParent() {
        actions.push({ action: "focus-parent" });
      },
    },
  });
  const client = await connectLines(bridge.socketPath);
  client.send({
    version: 1,
    type: "attach",
    token: bridge.credentialFor("sa-1"),
    subagentId: "sa-1",
  });
  await client.next();

  client.send({
    version: 1,
    type: "action",
    requestId: "send-1",
    action: "send",
    text: "steer the same session",
    subagentId: "sa-2",
  });
  assert.deepEqual(await client.next(), {
    version: 1,
    type: "actionResult",
    requestId: "send-1",
    ok: true,
  });
  client.send({
    version: 1,
    type: "action",
    requestId: "abort-1",
    action: "abort",
  });
  await client.next();
  client.send({
    version: 1,
    type: "action",
    requestId: "focus-1",
    action: "focus-parent",
  });
  await client.next();

  assert.deepEqual(actions, [
    { action: "send", id: "sa-1", text: "steer the same session" },
    { action: "abort", id: "sa-1" },
    { action: "focus-parent" },
  ]);
  client.socket.destroy();
  await bridge.close();
});

test("bridge bounds queued actions and unauthenticated idle clients", async () => {
  const view = createView([snapshot("sa-1")]);
  const baseDir = await mkdtemp(path.join(os.tmpdir(), "fable-bounds-test-"));
  let releaseSend!: () => void;
  const sendBlocked = new Promise<void>((resolve) => {
    releaseSend = resolve;
  });
  const bridge = await startMirrorBridge(view.view, {
    baseDir,
    authTimeoutMs: 25,
    maxPendingActions: 1,
    actions: {
      async send() {
        await sendBlocked;
      },
      async abort() {},
      async focusParent() {},
    },
  });

  const idle = await connectLines(bridge.socketPath);
  const idleError = (await idle.next()) as { code: string };
  assert.equal(idleError.code, "unauthorized");

  const client = await connectLines(bridge.socketPath);
  client.send({
    version: 1,
    type: "attach",
    token: bridge.credentialFor("sa-1"),
    subagentId: "sa-1",
  });
  await client.next();
  client.send({
    version: 1,
    type: "action",
    requestId: "blocked",
    action: "send",
    text: "first",
  });
  client.send({
    version: 1,
    type: "action",
    requestId: "overflow",
    action: "send",
    text: "second",
  });
  const overflow = (await client.next()) as { code: string };
  assert.equal(overflow.code, "unsupported");

  releaseSend();
  idle.socket.destroy();
  client.socket.destroy();
  await bridge.close();
});

test("malformed, unauthorized, oversized, and disconnected viewers cannot act", async () => {
  const view = createView([snapshot("sa-1")]);
  const baseDir = await mkdtemp(path.join(os.tmpdir(), "fable-security-test-"));
  const actions: string[] = [];
  const bridge = await startMirrorBridge(view.view, {
    baseDir,
    actions: {
      async send(_id, text) {
        actions.push(text);
      },
      async abort() {
        actions.push("abort");
      },
      async focusParent() {
        actions.push("focus-parent");
      },
    },
  });

  const unauthorized = await connectLines(bridge.socketPath);
  unauthorized.send({
    version: 1,
    type: "attach",
    token: "wrong",
    subagentId: "sa-1",
  });
  assert.equal(
    ((await unauthorized.next()) as { code: string }).code,
    "unauthorized",
  );

  const crossWired = await connectLines(bridge.socketPath);
  crossWired.send({
    version: 1,
    type: "attach",
    token: bridge.credentialFor("sa-other"),
    subagentId: "sa-1",
  });
  assert.equal(
    ((await crossWired.next()) as { code: string }).code,
    "unauthorized",
  );

  const malformed = await connectLines(bridge.socketPath);
  malformed.socket.write("{not json}\n");
  assert.equal(
    ((await malformed.next()) as { code: string }).code,
    "malformed",
  );

  const oversized = await connectLines(bridge.socketPath);
  oversized.socket.write(`${"x".repeat(64 * 1024 + 1)}\n`);
  assert.equal(
    ((await oversized.next()) as { code: string }).code,
    "oversized",
  );

  const disconnected = await connectLines(bridge.socketPath);
  disconnected.send({
    version: 1,
    type: "attach",
    token: bridge.credentialFor("sa-1"),
    subagentId: "sa-1",
  });
  await disconnected.next();
  disconnected.socket.destroy();

  const healthy = await connectLines(bridge.socketPath);
  healthy.send({
    version: 1,
    type: "attach",
    token: bridge.credentialFor("sa-1"),
    subagentId: "sa-1",
  });
  await healthy.next();
  healthy.send({
    version: 1,
    type: "action",
    requestId: "valid-after-attacks",
    action: "send",
    text: "still healthy",
  });
  assert.equal(((await healthy.next()) as { ok: boolean }).ok, true);
  assert.deepEqual(actions, ["still healthy"]);

  unauthorized.socket.destroy();
  crossWired.socket.destroy();
  malformed.socket.destroy();
  oversized.socket.destroy();
  healthy.socket.destroy();
  await bridge.close();
});

test("standalone viewer reconnects after a transient bridge disconnect", async () => {
  const baseDir = await mkdtemp(
    path.join(os.tmpdir(), "fable-reconnect-test-"),
  );
  const socketPath = path.join(baseDir, "viewer.sock");
  let connections = 0;
  const server = net.createServer((socket) => {
    connections++;
    let attached = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      attached += chunk;
      if (!attached.includes("\n")) return;
      if (connections === 1) {
        socket.destroy();
        return;
      }
      socket.write(
        `${JSON.stringify({
          version: 1,
          type: "snapshot",
          snapshot: snapshot("sa-1"),
        })}\n`,
      );
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });

  const viewer = spawn(
    process.execPath,
    [
      "--experimental-strip-types",
      path.join(import.meta.dirname, "src/herdr/viewer.ts"),
    ],
    {
      env: {
        ...process.env,
        FABLE_MIRROR_SOCKET: socketPath,
        FABLE_MIRROR_TOKEN: "test-token",
        FABLE_MIRROR_SUBAGENT_ID: "sa-1",
        FABLE_MIRROR_PARENT_PANE_ID: "parent-pane",
        FABLE_MIRROR_PARENT_LABEL: "Parent Pi",
        FABLE_MIRROR_MODEL: "claude-fable-5",
        HERDR_PANE_ID: "viewer-pane",
        HERDR_BIN: "/usr/bin/true",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let output = "";
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`Viewer did not reconnect. Output: ${output}`));
    }, 5_000);
    viewer.stdout.setEncoding("utf8");
    viewer.stdout.on("data", (chunk) => {
      output += chunk;
      if (!output.includes("Connected · Enter send")) return;
      clearTimeout(timeout);
      resolve();
    });
    viewer.once("error", reject);
    viewer.once("exit", (code) => {
      if (!output.includes("Connected · Enter send")) {
        reject(new Error(`Viewer exited early with ${code}: ${output}`));
      }
    });
  });

  assert.ok(connections >= 2);
  viewer.kill();
  await new Promise<void>((resolve) => viewer.once("exit", () => resolve()));
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

test("viewer rejects malformed bridge snapshots before rendering", () => {
  assert.equal(
    parseBridgeMessage({
      version: 1,
      type: "snapshot",
      snapshot: { ...snapshot("sa-1"), transcript: [{ kind: "assistant" }] },
    }),
    undefined,
  );
  assert.deepEqual(
    parseBridgeMessage({
      version: 1,
      type: "actionResult",
      requestId: "request-1",
      ok: false,
      error: "rejected",
    }),
    {
      version: 1,
      type: "actionResult",
      requestId: "request-1",
      ok: false,
      error: "rejected",
    },
  );
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
  assert.match(frame, /Ctrl-P parent/);
});

test("renderer keeps terminal errors visible above a long transcript", () => {
  const frame = renderMirrorFrame(
    snapshot("sa-1", {
      status: "error",
      errorText: "Run was aborted",
      transcript: Array.from({ length: 40 }, (_, index) => ({
        kind: "assistant" as const,
        parts: [
          { type: "text" as const, text: `old transcript line ${index}` },
        ],
      })),
    }),
    { columns: 80, rows: 10, input: "" },
  ).join("\n");

  assert.match(frame, /error: Run was aborted/);
});
