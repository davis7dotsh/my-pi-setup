import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import openaiFast from "../extensions/openai-fast.ts";

function setup(t, agentDir) {
  if (!agentDir) {
    agentDir = mkdtempSync(join(tmpdir(), "pi-openai-fast-"));
    t.after(() => rmSync(agentDir, { recursive: true, force: true }));
  }
  const statePath = join(agentDir, "openai-fast.json");
  const handlers = new Map();
  const commands = new Map();
  const entries = [];
  const statuses = new Map();
  const notifications = [];
  const ctx = {
    model: { provider: "openai", api: "openai-responses" },
    sessionManager: { getBranch: () => entries },
    ui: {
      setStatus: (key, value) => statuses.set(key, value),
      notify: (message, level) => notifications.push({ message, level }),
    },
  };
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    openaiFast({
      on: (name, handler) => handlers.set(name, handler),
      registerCommand: (name, command) => commands.set(name, command),
    });
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  }
  const emit = (name, event = {}) => handlers.get(name)(event, ctx);
  const command = (args = "") => commands.get("fast").handler(args, ctx);
  return {
    ctx,
    entries,
    statuses,
    notifications,
    emit,
    command,
    agentDir,
    statePath,
  };
}

test("fast toggles priority/default without changing other request fields", async (t) => {
  const { emit, command, statuses, statePath, notifications } = setup(t);
  emit("session_start");
  const payload = { model: "gpt-5.5", reasoning: { effort: "high" } };
  const request = () => emit("before_provider_request", { payload });
  assert.equal(request().service_tier, "default");
  await command();
  assert.deepEqual(request(), { ...payload, service_tier: "priority" });
  assert.equal(payload.service_tier, undefined);
  assert.equal(statuses.get("openai-fast"), "fast");
  assert.match(notifications.at(-1).message, /cost more/);
  const savedState = readFileSync(statePath, "utf8");
  await command("status");
  assert.equal(readFileSync(statePath, "utf8"), savedState);
  await command("off");
  assert.equal(request().service_tier, "default");
  await command("on");
  assert.equal(request().service_tier, "priority");
  await command("invalid");
  assert.equal(request().service_tier, "priority");
  assert.equal(notifications.at(-1).level, "warning");
});

test("fast only affects the openai provider's Responses and Completions APIs", async (t) => {
  const { ctx, emit, command, statuses } = setup(t);
  await command("on");
  for (const model of [
    { provider: "openai-codex", api: "openai-codex-responses" },
    { provider: "openrouter", api: "openai-completions" },
    { provider: "anthropic", api: "anthropic-messages" },
    { provider: "openai", api: "custom-api" },
    undefined,
  ]) {
    ctx.model = model;
    assert.equal(emit("before_provider_request", { payload: {} }), undefined);
    emit("model_select");
    assert.equal(statuses.get("openai-fast"), undefined);
  }
  ctx.model = { provider: "openai", api: "openai-completions" };
  assert.equal(
    emit("before_provider_request", { payload: {} }).service_tier,
    "priority",
  );
  for (const payload of [null, [], "text", undefined]) {
    assert.equal(emit("before_provider_request", { payload }), undefined);
  }
  await command("off");
  assert.equal(
    emit("before_provider_request", { payload: { service_tier: "priority" } })
      .service_tier,
    "default",
  );
});

test("fast persists on and off across new threads and extension instances", async (t) => {
  const first = setup(t);
  await first.command("on");
  assert.deepEqual(JSON.parse(readFileSync(first.statePath, "utf8")), {
    enabled: true,
  });
  first.emit("session_start");
  assert.equal(first.statuses.get("openai-fast"), "fast");

  const second = setup(t, first.agentDir);
  second.emit("session_start");
  assert.equal(second.statuses.get("openai-fast"), "fast");
  await second.command("off");
  assert.deepEqual(JSON.parse(readFileSync(first.statePath, "utf8")), {
    enabled: false,
  });

  const third = setup(t, first.agentDir);
  third.emit("session_start");
  assert.equal(third.statuses.get("openai-fast"), undefined);
  first.entries.push({
    type: "custom",
    customType: "openai-fast",
    data: { enabled: true },
  });
  first.emit("session_tree");
  assert.equal(first.statuses.get("openai-fast"), undefined);
});

test("running instances pick up global toggles before requests and commands", async (t) => {
  const first = setup(t);
  const second = setup(t, first.agentDir);
  const request = () => second.emit("before_provider_request", { payload: {} });
  await first.command("on");
  assert.equal(request().service_tier, "priority");
  await second.command();
  assert.equal(request().service_tier, "default");
  await first.command("status");
  assert.match(first.notifications.at(-1).message, /off globally/);
});

test("invalid saved state defaults off and can be replaced by a toggle", async (t) => {
  const { statePath, emit, command, statuses, notifications } = setup(t);
  for (const contents of ["broken json", "null", '{"enabled":"true"}']) {
    writeFileSync(statePath, contents);
    emit("session_start");
    assert.equal(statuses.get("openai-fast"), undefined);
    assert.equal(notifications.at(-1).level, "warning");
  }
  await command("on");
  assert.equal(statuses.get("openai-fast"), "fast");
});

test("save failures are reported without announcing a successful toggle", async (t) => {
  const { statePath, command, statuses, notifications } = setup(t);
  mkdirSync(statePath);
  await command("on");
  assert.equal(statuses.get("openai-fast"), undefined);
  assert.equal(notifications.at(-1).level, "error");
  assert.match(notifications.at(-1).message, /Could not save/);
});
