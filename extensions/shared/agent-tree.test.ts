import assert from "node:assert/strict";
import test from "node:test";
import { AgentTreeController } from "./agent-tree/control.ts";
import type {
  AgentNodeSpec,
  AgentTreeSession,
  AgentTreeSessionEvent,
} from "./agent-tree/domain.ts";
import { MAX_TRANSCRIPT_ITEMS } from "./agent-tree/transcript.ts";

class FakeSession implements AgentTreeSession {
  readonly activeTools = ["read", "bash"];
  readonly sessionFile = "/tmp/fake-session.jsonl";
  readonly listeners = new Set<(event: AgentTreeSessionEvent) => void>();
  readonly prompts: string[] = [];
  readonly sends: string[] = [];
  isStreaming = false;
  interrupted = 0;
  disposed = 0;

  subscribe(listener: (event: AgentTreeSessionEvent) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event: AgentTreeSessionEvent) {
    if (event.type === "run_started") this.isStreaming = true;
    if (event.type === "settled") this.isStreaming = false;
    for (const listener of this.listeners) listener(event);
  }

  async prompt(text: string) {
    this.prompts.push(text);
    this.isStreaming = true;
  }

  async send(text: string) {
    this.sends.push(text);
    this.emit({ type: "run_started" });
    this.emit({ type: "user", text });
  }

  enableMutation() {}

  async interrupt() {
    this.interrupted++;
    this.emit({ type: "settled", outcome: { type: "cancelled" } });
  }

  dispose() {
    this.disposed++;
  }
}

function fakeFactory() {
  const created: Array<{ spec: AgentNodeSpec; session: FakeSession }> = [];
  return {
    created,
    factory: {
      async create(spec: AgentNodeSpec) {
        const session = new FakeSession();
        created.push({ spec, session });
        return session;
      },
    },
  };
}

test("agent tree preserves parent, role, attempt, controls, and bounded transcripts", async () => {
  const fake = fakeFactory();
  let sequence = 0;
  const tree = new AgentTreeController({
    factory: fake.factory,
    makeId: () => `node-${++sequence}`,
  });
  const root = await tree.spawn({
    scopeId: "run-1",
    role: "root",
    attempt: 1,
    title: "root",
    model: "sol",
    cwd: "/tmp",
    prompt: "start",
    persistent: true,
  });
  const child = await tree.spawn({
    scopeId: "run-1",
    parentId: root.id,
    role: "audit",
    attempt: 2,
    title: "audit",
    model: "luna",
    cwd: "/tmp",
    prompt: "inspect",
  });

  assert.equal(child.parentId, root.id);
  assert.equal(child.role, "audit");
  assert.equal(child.attempt, 2);
  assert.deepEqual(
    tree.view.childrenOf(root.id).map((node) => node.id),
    [child.id],
  );

  const childSession = fake.created[1]!.session;
  childSession.emit({
    type: "assistant_delta",
    kind: "text",
    delta: "streaming",
  });
  assert.equal(tree.view.get(child.id)?.liveAssistant?.text, "streaming");
  childSession.emit({ type: "assistant", text: "finalized" });
  assert.equal(tree.view.get(child.id)?.liveAssistant, undefined);
  for (let index = 0; index < MAX_TRANSCRIPT_ITEMS + 20; index++) {
    childSession.emit({ type: "assistant", text: `message-${index}` });
  }
  assert.equal(
    tree.view.get(child.id)?.transcript.length,
    MAX_TRANSCRIPT_ITEMS,
  );
  assert.equal(tree.view.get(child.id)?.transcript[0]?.kind, "assistant");

  await tree.send(root.id, "remediate");
  assert.deepEqual(fake.created[0]!.session.sends, ["remediate"]);
  assert.equal(tree.view.get(root.id)?.status, "running");

  await tree.cancel(child.id);
  assert.equal(tree.view.get(child.id)?.status, "cancelled");
  assert.equal(childSession.interrupted, 1);
  await assert.rejects(tree.send("missing", "x"), /Unknown agent id/);
  await assert.rejects(tree.wait(["missing"]), /Unknown agent id/);

  await tree.dispose();
  assert.equal(fake.created[0]!.session.disposed, 1);
  assert.equal(fake.created[1]!.session.disposed, 1);
});

test("deferred roots stay idle until their first programmatic send", async () => {
  const fake = fakeFactory();
  const tree = new AgentTreeController({ factory: fake.factory });
  const root = await tree.spawn({
    role: "root",
    attempt: 1,
    title: "root",
    model: "sol",
    cwd: "/tmp",
    prompt: "unused initial prompt",
    persistent: true,
    deferPrompt: true,
  });
  const session = fake.created[0]!.session;

  assert.equal(tree.view.get(root.id)?.status, "idle");
  assert.deepEqual(session.prompts, []);
  assert.deepEqual(session.sends, []);

  await assert.rejects(
    tree.send(root.id, "start too early"),
    /waiting for controller bootstrap/,
  );
  await tree.startDeferred(root.id, "start after bootstrap");
  assert.equal(tree.view.get(root.id)?.status, "running");
  assert.deepEqual(session.prompts, []);
  assert.deepEqual(session.sends, ["start after bootstrap"]);

  await tree.dispose();
});

test("persistent roots become idle and accept additional remediation turns", async () => {
  const fake = fakeFactory();
  const tree = new AgentTreeController({ factory: fake.factory });
  const root = await tree.spawn({
    role: "root",
    attempt: 1,
    title: "root",
    model: "sol",
    cwd: "/tmp",
    prompt: "initial",
    persistent: true,
  });
  const session = fake.created[0]!.session;

  session.emit({
    type: "settled",
    outcome: { type: "completed", finalText: "first turn" },
  });
  assert.equal(tree.view.get(root.id)?.status, "idle");
  await tree.send(root.id, "resolve audit findings");
  assert.equal(tree.view.get(root.id)?.status, "running");
  session.emit({
    type: "settled",
    outcome: { type: "completed", finalText: "remediated" },
  });
  assert.equal(tree.view.get(root.id)?.status, "idle");
  assert.equal(tree.view.get(root.id)?.finalText, "remediated");

  await tree.cancel(root.id);
  assert.equal(tree.view.get(root.id)?.status, "cancelled");
  assert.equal(session.interrupted, 0);

  await tree.dispose();
});
