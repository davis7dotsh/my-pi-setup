import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { Check } from "typebox/value";
import type {
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type {
  AgentNodeSpec,
  AgentTreeSession,
  AgentTreeSessionEvent,
} from "../shared/agent-tree/domain.ts";
import {
  AUDIT_SYNTHESIS_REPORT_SCHEMA,
  AuditSegment,
  auditTrackReportSchema,
  buildAuditHostWorkspaceObservation,
  buildAuditTrackPrompt,
} from "./audit-segment.ts";
import {
  PipelineController,
  pipelineAuditSubmissionAllowed,
} from "./controller.ts";
import {
  createPipelineAuditSubmitTool,
  pipelineSessionToolPolicy,
} from "./session.ts";
import {
  AUDIT_SEGMENT_LUNA_ROLES,
  EXECUTOR_AUDIT_ROLE,
  LUNA_MODEL,
  SOL_MODEL,
  STATIC_LUNA_AUDIT_ROLES,
  TERRA_MODEL,
  type PipelineHandoff,
} from "./domain.ts";

class FakeSession implements AgentTreeSession {
  readonly listeners = new Set<(event: AgentTreeSessionEvent) => void>();
  readonly prompts: string[] = [];
  readonly sends: string[] = [];
  readonly activeTools: ReadonlyArray<string>;
  readonly sessionFile: string;
  isStreaming = false;
  interrupted = 0;
  disposed = 0;
  readonly spec: AgentNodeSpec;

  constructor(spec: AgentNodeSpec, tools: ReadonlyArray<ToolDefinition> = []) {
    this.spec = spec;
    this.activeTools = ["read", ...tools.map((tool) => tool.name)];
    this.sessionFile = `/private/${spec.scopeId}-${spec.role}.jsonl`;
  }

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

function harness() {
  const sessions: FakeSession[] = [];
  const handoffs: PipelineHandoff[] = [];
  const auditTools = new Map<string, ToolDefinition>();
  let submitAuditCallback:
    | ((runId: string, role: string, token: string, value: unknown) => void)
    | undefined;
  let agent = 0;
  const controller = new PipelineController({
    makeRunId: () => "audit-run",
    makeAgentId: () => `audit-agent-${++agent}`,
    createSessionFactory: (
      _rootTools: (runId: string) => ReadonlyArray<ToolDefinition>,
      _definitionForRun,
      submit,
      created,
      allowed,
    ) => ({
      async create(spec) {
        submitAuditCallback = submit;
        const tools: ToolDefinition[] = [];
        if (allowed?.(spec.scopeId ?? "", spec.role)) {
          const submissionRole =
            spec.role === "audit-synthesis"
              ? spec.role
              : AUDIT_SEGMENT_LUNA_ROLES.find(
                  (candidate) => candidate === spec.role,
                );
          assert.ok(submissionRole);
          const token = `${spec.scopeId}-${spec.role}-${spec.attempt}`;
          created?.(spec.scopeId ?? "", spec.role, token);
          const tool = createPipelineAuditSubmitTool(submissionRole, (value) =>
            submit?.(spec.scopeId ?? "", spec.role, token, value),
          );
          tools.push(tool);
          auditTools.set(spec.role, tool);
        }
        const session = new FakeSession(spec, tools);
        sessions.push(session);
        return session;
      },
    }),
    onHandoff: (handoff) => {
      handoffs.push(handoff);
    },
  });
  return {
    controller,
    sessions,
    handoffs,
    async submitAudit(role: string, value: unknown) {
      const tool = auditTools.get(role);
      assert.ok(tool);
      return tool.execute(
        `submit-${role}`,
        value,
        undefined,
        undefined,
        {} as ExtensionContext,
      );
    },
    submitUnauthorized(role: string, value: unknown) {
      assert.ok(submitAuditCallback);
      submitAuditCallback("audit-run", role, "unauthorized-token", value);
    },
  };
}

async function flush() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

function trackReportValue(role: string) {
  return {
    track: role,
    ...(role === EXECUTOR_AUDIT_ROLE
      ? {
          executedChecks: [
            {
              command: "npm run check",
              status: "passed",
              exitCode: 0,
              evidence: "Type check passed.",
            },
          ],
          workspaceChangesObserved: [],
        }
      : {}),
    findings: [],
    unprovenChecks: [],
  };
}

function hostWorkspaceObservation() {
  const empty = { state: "available", value: "" };
  return {
    capturedAfterExecutor: true,
    workspaceChanged: false,
    statusBefore: empty,
    statusAfter: empty,
    dirtyDiffAfter: empty,
    combinedDiffAfter: empty,
    summary: "Fresh host observation completed.",
  };
}

function trackReport(role: string) {
  return JSON.stringify(trackReportValue(role));
}

function malformedIntermediateImpact(roles: ReadonlyArray<string>) {
  return JSON.stringify({
    reportType: "audit-synthesis-intermediate",
    integratedRoles: roles,
    rootCauseCandidates: [
      {
        title: "candidate",
        sourceRoles: roles,
        evidence: "evidence",
        impact: "serious regression",
      },
    ],
    unresolvedConflicts: [],
    unprovenChecks: [],
    executedChecks: [],
    workspaceChangesObserved: [],
    hostWorkspaceObservation: null,
    summary: "Malformed impact",
  });
}

function intermediate(roles: ReadonlyArray<string>) {
  return JSON.stringify({
    reportType: "audit-synthesis-intermediate",
    integratedRoles: roles,
    rootCauseCandidates: [],
    unresolvedConflicts: [],
    unprovenChecks: [],
    executedChecks: [],
    workspaceChangesObserved: [],
    hostWorkspaceObservation: null,
    summary: "Integrated the current validated batch",
  });
}

function finalReport(
  roles: ReadonlyArray<string>,
  closureResults: ReadonlyArray<Record<string, string>> = [],
  mode: "initial" | "closure" = "initial",
  git: { baseSha: string; headSha: string } = {
    baseSha: "UNAVAILABLE",
    headSha: "UNAVAILABLE",
  },
) {
  return JSON.stringify({
    reportType: "audit-synthesis-final",
    mode,
    baseSha: git.baseSha,
    headSha: git.headSha,
    integratedRoles: roles,
    findings: [],
    closureResults,
    unresolvedConflicts: [],
    unprovenChecks: [],
    executedChecks: [],
    workspaceChangesObserved: [],
    hostWorkspaceObservation: hostWorkspaceObservation(),
    summary: "Bounded factual audit synthesis",
  });
}

function synthesisSegment(
  mode: "initial" | "closure" = "initial",
  priorBlockers: ReadonlyArray<{ id: string; closureCondition: string }> = [],
) {
  return new AuditSegment({
    task: "Audit synthesis contract",
    acceptanceContract: "The synthesis contract is strict",
    assumptions: [],
    checks: [],
    purpose: "standalone",
    input: {
      mode,
      acceptanceCriteria: [],
      ...(priorBlockers.length > 0 ? { priorBlockers } : {}),
    },
    git: {
      baseSha: "UNAVAILABLE",
      headSha: "UNAVAILABLE",
      worktreeLabel: "WORKTREE",
      workingDir: "/tmp/work",
      branch: "main",
      status: { state: "available", value: "" },
      baseIsAncestor: "yes",
      commits: { state: "available", value: "" },
      committedDiff: { state: "available", value: "" },
      dirtyDiff: { state: "available", value: "" },
      combinedDiff: { state: "available", value: "" },
    },
  });
}

function settle(session: FakeSession, finalText: string) {
  session.emit({
    type: "settled",
    outcome: { type: "completed", finalText },
  });
}

function sessionFor(harnessValue: ReturnType<typeof harness>, role: string) {
  const session = harnessValue.sessions.find(
    (candidate) => candidate.spec.role === role,
  );
  assert.ok(session);
  return session;
}

test("audit schemas reject observed scalar impact and string unproven checks", () => {
  const role = AUDIT_SEGMENT_LUNA_ROLES[0];
  assert.equal(
    Check(auditTrackReportSchema(role), {
      track: role,
      findings: [
        {
          title: "x",
          scenario: "x",
          expected: "x",
          actual: "x",
          affectedPaths: ["x"],
          relationship: "introduced",
          evidenceType: "static",
          evidence: "x",
          impact: "4",
          confidence: 80,
          minimalNextAction: "x",
        },
      ],
      unprovenChecks: [],
    }),
    false,
  );
  assert.equal(
    Check(auditTrackReportSchema(role), {
      track: role,
      findings: [],
      unprovenChecks: ["unproven"],
    }),
    false,
  );
  assert.equal(
    Check(AUDIT_SYNTHESIS_REPORT_SCHEMA, {
      reportType: "audit-synthesis-intermediate",
      integratedRoles: [],
      rootCauseCandidates: [],
      unresolvedConflicts: [],
      unprovenChecks: ["unproven"],
      summary: "x",
    }),
    false,
  );
  assert.equal(
    Check(AUDIT_SYNTHESIS_REPORT_SCHEMA, {
      reportType: "audit-synthesis-intermediate",
      integratedRoles: [role],
      rootCauseCandidates: [
        {
          title: "candidate",
          sourceRoles: [role],
          evidence: "evidence",
          impact: "serious regression",
        },
      ],
      unresolvedConflicts: [],
      unprovenChecks: [],
      summary: "x",
    }),
    false,
  );
});

test("shared audit segment has five contributors while small-feature stays four static tracks", () => {
  assert.equal(STATIC_LUNA_AUDIT_ROLES.length, 4);
  assert.equal(AUDIT_SEGMENT_LUNA_ROLES.length, 5);
  assert.deepEqual(AUDIT_SEGMENT_LUNA_ROLES, [
    ...STATIC_LUNA_AUDIT_ROLES,
    EXECUTOR_AUDIT_ROLE,
  ]);
});

test("executor schema preserves complete bounded execution outcomes", () => {
  assert.equal(
    Check(auditTrackReportSchema(EXECUTOR_AUDIT_ROLE), {
      track: EXECUTOR_AUDIT_ROLE,
      executedChecks: [
        {
          command: "npm run check",
          status: "passed",
          exitCode: 0,
          evidence: "passed",
        },
        {
          command: "npm run test",
          status: "failed",
          exitCode: 1,
          evidence: "one test failed",
        },
        {
          command: "npm run integration",
          status: "timed_out",
          exitCode: null,
          evidence: "bounded timeout elapsed",
        },
        {
          command: "npm run format -- --write",
          status: "skipped",
          exitCode: null,
          evidence: "write mode violates the executor contract",
        },
      ],
      workspaceChangesObserved: [
        {
          path: ".cache/checks",
          change: "untracked",
          evidence: "Observed after test execution.",
        },
      ],
      findings: [],
      unprovenChecks: [],
    }),
    true,
  );
  assert.equal(
    Check(auditTrackReportSchema(EXECUTOR_AUDIT_ROLE), {
      track: EXECUTOR_AUDIT_ROLE,
      executedChecks: [
        {
          command: "npm test",
          status: "unknown",
          exitCode: "1",
          evidence: "bad enum and code",
        },
      ],
      workspaceChangesObserved: [],
      findings: [],
      unprovenChecks: [],
    }),
    false,
  );
});

test("audit submission tool policy is limited to reusable audit-segment sessions", () => {
  assert.equal(
    pipelineAuditSubmissionAllowed("audit-pipeline", "audit-synthesis", false),
    true,
  );
  assert.equal(
    pipelineAuditSubmissionAllowed(
      "feature-pipeline",
      AUDIT_SEGMENT_LUNA_ROLES[0],
      true,
    ),
    true,
  );
  assert.equal(
    pipelineAuditSubmissionAllowed(
      "feature-pipeline",
      AUDIT_SEGMENT_LUNA_ROLES[0],
      false,
    ),
    false,
  );
  assert.equal(
    pipelineAuditSubmissionAllowed(
      "small-feature-pipeline",
      AUDIT_SEGMENT_LUNA_ROLES[0],
      true,
    ),
    false,
  );
  assert.equal(
    pipelineAuditSubmissionAllowed("plan-pipeline", "pipeline-root", true),
    false,
  );
});

test("audit submissions reject unregistered session tokens", async () => {
  const run = harness();
  run.controller.start({
    pipeline: "audit-pipeline",
    task: "Audit submission authorization",
    workingDir: "/tmp/work",
  });
  await flush();
  assert.throws(
    () =>
      run.submitUnauthorized(
        AUDIT_SEGMENT_LUNA_ROLES[0],
        trackReportValue(AUDIT_SEGMENT_LUNA_ROLES[0]),
      ),
    /session is not registered/,
  );
  await run.controller.dispose();
});

test("only executor audit keeps bash while all audit sessions deny mutation and orchestration", () => {
  const rootDenied = new Set<string>(
    pipelineSessionToolPolicy("audit-pipeline", true, "audit-synthesis")
      .excludeTools,
  );
  const childDenied = new Set<string>(
    pipelineSessionToolPolicy("audit-pipeline", false, "audit-feature-outcome")
      .excludeTools,
  );
  const executorDenied = new Set<string>(
    pipelineSessionToolPolicy("audit-pipeline", false, EXECUTOR_AUDIT_ROLE)
      .excludeTools,
  );
  assert.equal(executorDenied.has("bash"), false);
  assert.equal(rootDenied.has("bash"), true);
  assert.equal(childDenied.has("bash"), true);
  for (const tool of [
    "edit",
    "write",
    "apply_patch_codex",
    "codex_task",
    "mcp",
    "bg_start",
    "bg_kill",
    "ask_user",
    "workflow",
    "pipeline_run",
    "pipeline_stage",
    "pipeline_child_spawn",
    "pipeline_audit_start",
    "pipeline_complete",
  ]) {
    assert.equal(rootDenied.has(tool), true);
    assert.equal(childDenied.has(tool), true);
    assert.equal(executorDenied.has(tool), true);
  }
});

test("executor prompt requires script inspection, safe execution, workspace reporting, and plan-only scope", () => {
  const normal = buildAuditTrackPrompt(
    EXECUTOR_AUDIT_ROLE,
    synthesisSegment().context,
  );
  for (const phrase of [
    "inspect applicable manifests and the full script definition before running it",
    "cheap checks first",
    "repository-declared noninteractive repository-wide full test suite(s)",
    "Targeted, package-level, or affected-scope tests do not substitute for the full suite",
    "no safe full-suite command exists",
    "exact skipped/failed/timed-out evidence",
    "add an unprovenChecks entry",
    "do not invent a command",
    "never intentionally edit or create source/config files",
    "--fix",
    "snapshot updates",
    "never install, update, or remove dependencies",
    "never run mutating Git operations",
    "never mutate network or external state",
    "interactive, watch, server, daemon, background",
    "never prompt the user",
    "Test/build/cache artifacts may occur",
    "report observed workspace changes",
    "does not automatically prove a behavior finding",
  ]) {
    assert.match(
      normal,
      new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"),
    );
  }
  const feature = buildAuditTrackPrompt(EXECUTOR_AUDIT_ROLE, {
    ...synthesisSegment().context,
    purpose: "feature-final",
  });
  assert.match(
    feature,
    /repository-declared noninteractive repository-wide full test suite\(s\)/i,
  );
  const plan = buildAuditTrackPrompt(EXECUTOR_AUDIT_ROLE, {
    ...synthesisSegment().context,
    purpose: "plan-final",
  });
  assert.match(
    plan,
    /only commands demonstrably relevant to validating the plan artifact/i,
  );
  assert.match(
    plan,
    /Do not run product implementation tests, builds, linters, or typechecks/i,
  );
  assert.match(plan, /unsupported product checks as skipped and\/or unproven/i);
  assert.doesNotMatch(
    plan,
    /repository-declared noninteractive repository-wide full test suite\(s\)/i,
  );
  const staticPrompt = buildAuditTrackPrompt(
    STATIC_LUNA_AUDIT_ROLES[0],
    synthesisSegment().context,
  );
  assert.match(staticPrompt, /Do not run shell commands/);
});

test("standalone audit graph is Luna-only and activates synthesis on the first valid report", async () => {
  const run = harness();
  const runId = run.controller.start({
    pipeline: "audit-pipeline",
    task: "Audit the bounded change",
    workingDir: "/tmp/work",
    audit: { mode: "initial", acceptanceCriteria: ["The contract holds"] },
  });
  await flush();

  const snapshot = run.controller.get(runId);
  assert.equal(snapshot?.definition, "audit-pipeline");
  assert.equal(snapshot?.stage, "audit");
  assert.equal(snapshot?.agents.length, 6);
  assert.equal(
    snapshot?.agents.every((item) => item.model === LUNA_MODEL),
    true,
  );
  assert.equal(
    snapshot?.agents.some((item) => item.model === SOL_MODEL),
    false,
  );
  assert.equal(
    snapshot?.agents.some((item) => item.model === TERRA_MODEL),
    false,
  );
  assert.equal(
    run.sessions.every((session) =>
      session.activeTools.includes("pipeline_audit_submit"),
    ),
    true,
  );
  const synthesizer = sessionFor(run, "audit-synthesis");
  assert.equal(synthesizer.sends.length, 0);

  const trackSubmission = await run.submitAudit(AUDIT_SEGMENT_LUNA_ROLES[0], {
    track: AUDIT_SEGMENT_LUNA_ROLES[0],
    findings: [],
    unprovenChecks: [],
  });
  assert.equal(trackSubmission.terminate, true);
  settle(sessionFor(run, AUDIT_SEGMENT_LUNA_ROLES[0]), "");
  await flush();
  assert.equal(synthesizer.sends.length, 1);
  assert.match(synthesizer.sends[0] ?? "", /audit-feature-outcome/);
  assert.equal(run.controller.get(runId)?.auditSegment?.reducerStatus, "busy");
  assert.equal(run.handoffs.length, 0);

  for (const role of AUDIT_SEGMENT_LUNA_ROLES.slice(1)) {
    settle(sessionFor(run, role), trackReport(role));
  }
  await flush();
  assert.equal(synthesizer.sends.length, 1);
  assert.equal(synthesizer.interrupted, 0);
  assert.equal(run.controller.get(runId)?.auditSegment?.pendingReportCount, 4);

  await run.submitAudit(
    "audit-synthesis",
    JSON.parse(intermediate([AUDIT_SEGMENT_LUNA_ROLES[0]])),
  );
  settle(synthesizer, "");
  await flush();
  assert.equal(synthesizer.sends.length, 2);
  for (const role of AUDIT_SEGMENT_LUNA_ROLES.slice(1)) {
    assert.match(synthesizer.sends[1] ?? "", new RegExp(role));
  }
  assert.equal(run.handoffs.length, 0);

  await run.submitAudit(
    "audit-synthesis",
    JSON.parse(finalReport(AUDIT_SEGMENT_LUNA_ROLES)),
  );
  settle(synthesizer, "");
  await flush();
  const completed = run.controller.get(runId);
  assert.equal(completed?.status, "completed");
  assert.equal(completed?.stage, "complete");
  assert.equal(completed?.auditSegment?.integratedReportCount, 5);
  assert.equal(completed?.auditSegment?.revision, 2);
  assert.equal(completed?.auditSegment?.finalReportValidated, true);
  assert.equal(run.handoffs.length, 1);
  assert.equal(
    run.handoffs[0]?.facts.auditReport?.reportType,
    "audit-synthesis-final",
  );
  await run.controller.dispose();
});

test("controller captures fresh Git status and diff evidence after executor settlement", async () => {
  const workspace = fs.mkdtempSync(
    path.join(os.tmpdir(), "pipi-executor-audit-"),
  );
  execFileSync("git", ["init", "-q"], { cwd: workspace });
  execFileSync("git", ["config", "user.name", "Pipi Test"], {
    cwd: workspace,
  });
  execFileSync("git", ["config", "user.email", "pipi@example.invalid"], {
    cwd: workspace,
  });
  fs.writeFileSync(path.join(workspace, "tracked.txt"), "baseline\n");
  execFileSync("git", ["add", "tracked.txt"], { cwd: workspace });
  execFileSync("git", ["commit", "-qm", "baseline"], { cwd: workspace });
  const sha = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: workspace,
    encoding: "utf8",
  }).trim();

  const run = harness();
  try {
    const runId = run.controller.start({
      pipeline: "audit-pipeline",
      task: "Observe executor artifacts",
      workingDir: workspace,
    });
    await flush();
    const firstRole = STATIC_LUNA_AUDIT_ROLES[0];
    settle(sessionFor(run, firstRole), trackReport(firstRole));
    await flush();
    const synthesizer = sessionFor(run, "audit-synthesis");

    fs.writeFileSync(path.join(workspace, ".executor-cache"), "artifact\n");
    settle(
      sessionFor(run, EXECUTOR_AUDIT_ROLE),
      trackReport(EXECUTOR_AUDIT_ROLE),
    );
    for (const role of STATIC_LUNA_AUDIT_ROLES.slice(1)) {
      settle(sessionFor(run, role), trackReport(role));
    }
    await flush();
    settle(synthesizer, intermediate([firstRole]));
    await flush();
    settle(
      synthesizer,
      finalReport(AUDIT_SEGMENT_LUNA_ROLES, [], "initial", {
        baseSha: sha,
        headSha: sha,
      }),
    );
    await flush();

    const report = run.handoffs[0]?.facts.auditReport;
    assert.equal(run.controller.get(runId)?.status, "completed");
    assert.equal(report?.hostWorkspaceObservation.workspaceChanged, true);
    assert.match(
      report?.hostWorkspaceObservation.statusAfter.value ?? "",
      /\.executor-cache/,
    );
    assert.match(
      report?.hostWorkspaceObservation.summary ?? "",
      /not rolled back/,
    );
  } finally {
    await run.controller.dispose();
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("track schema corrections are independent per session and preserve the run", async () => {
  const run = harness();
  const runId = run.controller.start({
    pipeline: "audit-pipeline",
    task: "Audit retry isolation",
    workingDir: "/tmp/work",
  });
  await flush();
  const firstRole = AUDIT_SEGMENT_LUNA_ROLES[0];
  const secondRole = AUDIT_SEGMENT_LUNA_ROLES[1];
  const first = sessionFor(run, firstRole);
  const second = sessionFor(run, secondRole);

  for (let error = 1; error <= 3; error++) {
    settle(first, JSON.stringify({ track: "wrong" }));
    await flush();
    assert.equal(run.controller.get(runId)?.status, "running");
    assert.equal(first.sends.length, error);
    assert.equal(second.interrupted, 0);
  }

  settle(second, JSON.stringify({ track: "wrong" }));
  await flush();
  assert.equal(second.sends.length, 1);
  assert.equal(first.sends.length, 3);

  await run.submitAudit(firstRole, trackReportValue(firstRole));
  settle(first, "tool submission recorded");
  await flush();
  assert.equal(run.controller.get(runId)?.status, "running");
  assert.equal(run.controller.get(runId)?.auditSegment?.acceptedReportCount, 1);
  assert.equal(sessionFor(run, "audit-synthesis").sends.length, 1);
  assert.equal(second.interrupted, 0);
  await run.controller.dispose();
});

test("malformed executor evidence receives same-session correction without losing peers", async () => {
  const run = harness();
  const runId = run.controller.start({
    pipeline: "audit-pipeline",
    task: "Audit executor correction",
    workingDir: "/tmp/work",
  });
  await flush();
  const executor = sessionFor(run, EXECUTOR_AUDIT_ROLE);
  settle(
    executor,
    JSON.stringify({
      track: EXECUTOR_AUDIT_ROLE,
      executedChecks: [{ command: "npm test", status: "passed" }],
      workspaceChangesObserved: [],
      findings: [],
      unprovenChecks: [],
    }),
  );
  await flush();
  assert.equal(executor.sends.length, 1);
  assert.equal(run.controller.get(runId)?.status, "running");

  const peerRole = STATIC_LUNA_AUDIT_ROLES[0];
  settle(sessionFor(run, peerRole), trackReport(peerRole));
  await flush();
  assert.equal(run.controller.get(runId)?.auditSegment?.acceptedReportCount, 1);
  await run.controller.dispose();
});

test("a fourth schema error in one track session fails and cancels the run", async () => {
  const run = harness();
  const runId = run.controller.start({
    pipeline: "audit-pipeline",
    task: "Audit exhausted retry budget",
    workingDir: "/tmp/work",
  });
  await flush();
  const failedRole = AUDIT_SEGMENT_LUNA_ROLES[0];
  const failed = sessionFor(run, failedRole);

  for (let error = 1; error <= 4; error++) {
    settle(failed, JSON.stringify({ track: "wrong" }));
    await flush();
  }

  assert.equal(run.controller.get(runId)?.status, "failed");
  assert.equal(failed.sends.length, 3);
  assert.equal(sessionFor(run, AUDIT_SEGMENT_LUNA_ROLES[1]).interrupted, 1);
  assert.equal(run.handoffs.length, 1);
  await run.controller.dispose();
});

test("a corrected synthesis tool submission continues and finalizes", async () => {
  const run = harness();
  const runId = run.controller.start({
    pipeline: "audit-pipeline",
    task: "Audit synthesis recovery",
    workingDir: "/tmp/work",
  });
  await flush();
  const firstRole = AUDIT_SEGMENT_LUNA_ROLES[0];
  settle(sessionFor(run, firstRole), trackReport(firstRole));
  await flush();
  const synthesizer = sessionFor(run, "audit-synthesis");
  for (const role of AUDIT_SEGMENT_LUNA_ROLES.slice(1)) {
    settle(sessionFor(run, role), trackReport(role));
  }
  await flush();
  settle(synthesizer, "not JSON");
  await flush();
  assert.equal(run.controller.get(runId)?.status, "running");
  assert.equal(synthesizer.sends.length, 2);

  await run.submitAudit(
    "audit-synthesis",
    JSON.parse(intermediate([firstRole])),
  );
  settle(synthesizer, "tool submission recorded");
  await flush();
  assert.equal(run.controller.get(runId)?.auditSegment?.revision, 2);
  await run.submitAudit(
    "audit-synthesis",
    JSON.parse(finalReport(AUDIT_SEGMENT_LUNA_ROLES)),
  );
  settle(synthesizer, "tool submission recorded");
  await flush();
  assert.equal(run.controller.get(runId)?.status, "completed");
  assert.equal(run.handoffs.length, 1);
  await run.controller.dispose();
});

test("synthesis schema correction budget is cumulative across reducer revisions", async () => {
  const run = harness();
  const runId = run.controller.start({
    pipeline: "audit-pipeline",
    task: "Audit cumulative synthesis retry budget",
    workingDir: "/tmp/work",
  });
  await flush();
  const firstRole = AUDIT_SEGMENT_LUNA_ROLES[0];
  settle(sessionFor(run, firstRole), trackReport(firstRole));
  await flush();
  const synthesizer = sessionFor(run, "audit-synthesis");

  for (let error = 1; error <= 3; error++) {
    settle(synthesizer, malformedIntermediateImpact([firstRole]));
    await flush();
    assert.equal(run.controller.get(runId)?.status, "running");
  }
  for (const role of AUDIT_SEGMENT_LUNA_ROLES.slice(1)) {
    settle(sessionFor(run, role), trackReport(role));
  }
  await run.submitAudit(
    "audit-synthesis",
    JSON.parse(intermediate([firstRole])),
  );
  settle(synthesizer, "tool submission recorded");
  await flush();
  assert.equal(run.controller.get(runId)?.auditSegment?.revision, 2);
  assert.equal(run.controller.get(runId)?.status, "running");

  settle(synthesizer, "not JSON");
  await flush();
  assert.equal(run.controller.get(runId)?.status, "failed");
  assert.equal(synthesizer.sends.length, 5);
  assert.equal(run.handoffs.length, 1);
  await run.controller.dispose();
});

test("executor evidence and observed workspace changes survive final canonicalization", () => {
  const segment = synthesisSegment();
  const executorReport = {
    track: EXECUTOR_AUDIT_ROLE,
    executedChecks: [
      {
        command: "npm run check",
        status: "passed",
        exitCode: 0,
        evidence: "Type check passed with no output.",
      },
      {
        command: "npm run test:watch",
        status: "skipped",
        exitCode: null,
        evidence: "Watch mode is prohibited.",
      },
    ],
    workspaceChangesObserved: [
      {
        path: ".cache/tests",
        change: "untracked",
        evidence: "Observed after the passing check.",
      },
    ],
    findings: [],
    unprovenChecks: [],
  };
  for (const role of AUDIT_SEGMENT_LUNA_ROLES) {
    segment.accept(
      role,
      role === EXECUTOR_AUDIT_ROLE
        ? JSON.stringify(executorReport)
        : trackReport(role),
      1,
    );
  }
  segment.nextPrompt();
  segment.settleSubmitted(
    JSON.parse(finalReport([...AUDIT_SEGMENT_LUNA_ROLES].reverse())),
  );
  assert.deepEqual(
    segment.finalReport?.executedChecks,
    executorReport.executedChecks,
  );
  assert.deepEqual(
    segment.finalReport?.workspaceChangesObserved,
    executorReport.workspaceChangesObserved,
  );
  assert.equal(
    segment.finalReport?.hostWorkspaceObservation.capturedAfterExecutor,
    true,
  );
  assert.deepEqual(segment.finalReport?.findings, []);
});

test("host workspace observation detects fresh bounded Git status and diff changes", () => {
  const before = synthesisSegment().context.git;
  const after = {
    ...before,
    status: { state: "available" as const, value: "?? .cache/tests" },
    dirtyDiff: {
      state: "available" as const,
      value: "diff --git a/src/a.ts b/src/a.ts",
    },
    combinedDiff: {
      state: "available" as const,
      value: "diff --git a/src/a.ts b/src/a.ts",
    },
  };
  const observation = buildAuditHostWorkspaceObservation(before, after);
  assert.equal(observation.workspaceChanged, true);
  assert.equal(observation.statusAfter.value, "?? .cache/tests");
  assert.match(observation.dirtyDiffAfter.value, /diff --git/);
  assert.match(observation.summary, /not rolled back/);
});

test("final audit findings are canonicalized, deduplicated, and assigned IDs host-side", () => {
  const segment = new AuditSegment({
    task: "Audit stable IDs",
    acceptanceContract: "The final report is deterministic",
    assumptions: [],
    checks: [],
    purpose: "standalone",
    input: { mode: "initial", acceptanceCriteria: [] },
    git: {
      baseSha: "base123",
      headSha: "head123",
      worktreeLabel: "WORKTREE",
      workingDir: "/tmp/work",
      branch: "main",
      status: { state: "available", value: "" },
      baseIsAncestor: "yes",
      commits: { state: "available", value: "" },
      committedDiff: { state: "available", value: "" },
      dirtyDiff: { state: "available", value: "" },
      combinedDiff: { state: "available", value: "" },
    },
  });
  for (const role of AUDIT_SEGMENT_LUNA_ROLES) {
    segment.accept(role, trackReport(role), 1);
  }
  assert.equal(segment.nextPrompt()?.turn.final, true);
  const finding = (title: string, impact: number) => ({
    title,
    sourceRoles: [AUDIT_SEGMENT_LUNA_ROLES[0]],
    scope: "initial",
    scopeReference: "task",
    scenario: `Scenario ${title}`,
    expected: "Expected behavior",
    actual: "Actual behavior",
    affectedPaths: ["src/example.ts"],
    relationship: "introduced",
    evidenceType: "static",
    evidence: `Evidence ${title}`,
    impact,
    confidence: 90,
    minimalNextAction: `Fix ${title}`,
  });
  assert.throws(
    () =>
      segment.settleSubmitted({
        reportType: "audit-synthesis-final",
        mode: "initial",
        baseSha: "base123",
        headSha: "head123",
        integratedRoles: AUDIT_SEGMENT_LUNA_ROLES,
        findings: [],
        closureResults: [],
        unresolvedConflicts: [],
        unprovenChecks: [],
        summary: "x".repeat(64 * 1024),
      }),
    /65536-byte limit/,
  );
  segment.settle(
    JSON.stringify({
      reportType: "audit-synthesis-final",
      mode: "initial",
      baseSha: "base123",
      headSha: "head123",
      integratedRoles: AUDIT_SEGMENT_LUNA_ROLES,
      findings: [
        finding("lower", 2),
        finding("higher", 4),
        finding("higher", 4),
      ],
      closureResults: [],
      unresolvedConflicts: [],
      unprovenChecks: [],
      executedChecks: [],
      workspaceChangesObserved: [],
      hostWorkspaceObservation: hostWorkspaceObservation(),
      summary: "Canonical findings",
    }),
  );
  assert.deepEqual(
    segment.finalReport?.findings.map((item) => [item.id, item.title]),
    [
      ["AUD-001", "higher"],
      ["AUD-002", "lower"],
    ],
  );
});

test("synthesis accepts any exact role order and canonicalizes it without reducer restart", () => {
  const segment = synthesisSegment();
  for (const role of AUDIT_SEGMENT_LUNA_ROLES) {
    segment.accept(role, trackReport(role), 1);
  }
  assert.equal(segment.nextPrompt()?.turn.final, true);
  const arrivalOrder = [
    AUDIT_SEGMENT_LUNA_ROLES[0],
    AUDIT_SEGMENT_LUNA_ROLES[2],
    AUDIT_SEGMENT_LUNA_ROLES[4],
    AUDIT_SEGMENT_LUNA_ROLES[3],
    AUDIT_SEGMENT_LUNA_ROLES[1],
  ];
  const invalid = JSON.parse(
    finalReport(
      [...arrivalOrder.slice(0, -1), arrivalOrder[0]],
      [{ blockerId: "BLOCK-1", closureCondition: "not applicable" }],
    ),
  );
  assert.equal(Check(AUDIT_SYNTHESIS_REPORT_SCHEMA, invalid), false);
  assert.throws(
    () => segment.settleSubmitted(invalid),
    (error) => {
      assert.match(String(error), /integratedRoles exact set mismatch/);
      assert.match(
        String(error),
        /initial closureResults must be an empty array/,
      );
      return true;
    },
  );
  assert.equal(segment.progress().revision, 1);
  segment.settleSubmitted(JSON.parse(finalReport(arrivalOrder)));
  assert.deepEqual(
    segment.finalReport?.integratedRoles,
    AUDIT_SEGMENT_LUNA_ROLES,
  );
});

test("fallback rejects non-array initial closureResults with a bounded diagnostic", () => {
  const segment = synthesisSegment();
  for (const role of AUDIT_SEGMENT_LUNA_ROLES) {
    segment.accept(role, trackReport(role), 1);
  }
  segment.nextPrompt();
  const report = JSON.parse(finalReport(AUDIT_SEGMENT_LUNA_ROLES));
  report.closureResults = "not an array";
  assert.throws(
    () => segment.settleSubmitted(report),
    /initial closureResults must be an empty array/,
  );
});

test("final schema bounds unprovenChecks and rejects extra properties", () => {
  const report = JSON.parse(finalReport(AUDIT_SEGMENT_LUNA_ROLES));
  const check = { claim: "claim", reason: "reason", requiredCheck: "check" };
  report.unprovenChecks = Array.from({ length: 129 }, () => check);
  assert.equal(Check(AUDIT_SYNTHESIS_REPORT_SCHEMA, report), false);
  report.unprovenChecks = [{ ...check, extra: "rejected" }];
  assert.equal(Check(AUDIT_SYNTHESIS_REPORT_SCHEMA, report), false);
});

test("synthesis rejects duplicate or missing integrated roles", () => {
  const segment = synthesisSegment();
  for (const role of AUDIT_SEGMENT_LUNA_ROLES) {
    segment.accept(role, trackReport(role), 1);
  }
  segment.nextPrompt();
  const duplicate = [
    ...AUDIT_SEGMENT_LUNA_ROLES.slice(0, -1),
    AUDIT_SEGMENT_LUNA_ROLES[0],
  ];
  assert.throws(
    () => segment.settleSubmitted(JSON.parse(finalReport(duplicate))),
    /integratedRoles exact set mismatch/,
  );
  const missing = AUDIT_SEGMENT_LUNA_ROLES.slice(0, -1);
  assert.throws(
    () => segment.settleSubmitted(JSON.parse(finalReport(missing))),
    /integratedRoles exact set mismatch.*missing=/,
  );
});

test("closure synthesis keeps blocker IDs, order, and conditions strict", () => {
  const blockers = [
    { id: "BLOCK-1", closureCondition: "first condition" },
    { id: "BLOCK-2", closureCondition: "second condition" },
  ];
  const segment = synthesisSegment("closure", blockers);
  for (const role of AUDIT_SEGMENT_LUNA_ROLES) {
    segment.accept(role, trackReport(role), 1);
  }
  segment.nextPrompt();
  const wrongOrder = [
    { ...blockers[1], status: "closed", evidence: "evidence" },
    { ...blockers[0], status: "open", evidence: "evidence" },
  ];
  assert.throws(
    () =>
      segment.settleSubmitted(
        JSON.parse(
          finalReport(AUDIT_SEGMENT_LUNA_ROLES, wrongOrder, "closure"),
        ),
      ),
    /closure blocker ID\/order\/condition mismatch/,
  );
  const validSegment = synthesisSegment("closure", blockers);
  for (const role of AUDIT_SEGMENT_LUNA_ROLES) {
    validSegment.accept(role, trackReport(role), 1);
  }
  validSegment.nextPrompt();
  assert.deepEqual(validSegment.context.input.priorBlockers, blockers);
  validSegment.settleSubmitted(
    JSON.parse(
      finalReport(
        AUDIT_SEGMENT_LUNA_ROLES,
        blockers.map((blocker) => ({
          blockerId: blocker.id,
          closureCondition: blocker.closureCondition,
          status: "closed",
          evidence: "evidence",
        })),
        "closure",
      ),
    ),
  );
  assert.equal(validSegment.finalReport?.closureResults.length, 2);
});

test("closure audit input rejects an empty directly touched invariant scope", async () => {
  const run = harness();
  assert.throws(
    () =>
      run.controller.start({
        pipeline: "audit-pipeline",
        task: "Incomplete closure audit",
        workingDir: "/tmp/work",
        audit: {
          mode: "closure",
          acceptanceCriteria: [],
          priorBlockers: [{ id: "BLOCK-1", closureCondition: "Fixed" }],
          remediationDiff: "diff",
          touchedInvariants: [],
        },
      }),
    /at least one directly touched invariant/,
  );
  await run.controller.dispose();
});

test("standalone audit fails closed on malformed or missing reports", async () => {
  const malformed = harness();
  const malformedId = malformed.controller.start({
    pipeline: "audit-pipeline",
    task: "Audit malformed output",
    workingDir: "/tmp/work",
  });
  await flush();
  for (let attempt = 0; attempt < 4; attempt++) {
    settle(
      sessionFor(malformed, AUDIT_SEGMENT_LUNA_ROLES[0]),
      JSON.stringify({ track: "wrong", findings: [], unprovenChecks: [] }),
    );
    await flush();
  }
  assert.equal(malformed.controller.get(malformedId)?.status, "failed");
  assert.match(
    malformed.handoffs[0]?.error ?? "",
    /invalid or mismatched report/,
  );
  await malformed.controller.dispose();

  const missing = harness();
  const missingId = missing.controller.start({
    pipeline: "audit-pipeline",
    task: "Audit missing output",
    workingDir: "/tmp/work",
  });
  await flush();
  for (let attempt = 0; attempt < 4; attempt++) {
    settle(sessionFor(missing, AUDIT_SEGMENT_LUNA_ROLES[0]), "");
    await flush();
  }
  assert.equal(missing.controller.get(missingId)?.status, "failed");
  assert.equal(missing.handoffs.length, 1);
  await missing.controller.dispose();
});

test("standalone closure audit preserves supplied blocker scope and cancels session-scoped agents", async () => {
  const run = harness();
  const runId = run.controller.start({
    pipeline: "audit-pipeline",
    task: "Verify blocker closure",
    workingDir: "/tmp/work",
    audit: {
      mode: "closure",
      acceptanceCriteria: ["Prior blocker is closed"],
      priorBlockers: [
        { id: "AUD-004", closureCondition: "The race is impossible" },
      ],
      remediationDiff: "Bounded supplied remediation diff",
      touchedInvariants: ["Exactly-once delivery"],
    },
  });
  await flush();
  for (const role of AUDIT_SEGMENT_LUNA_ROLES) {
    const prompt = sessionFor(run, role).prompts[0] ?? "";
    assert.match(prompt, /Do not reopen broad discovery/);
    assert.match(prompt, /AUD-004/);
  }
  await run.controller.cancelRun(runId);
  assert.equal(run.controller.get(runId)?.status, "cancelled");
  assert.equal(run.handoffs.length, 1);
  assert.equal(
    run.sessions
      .filter((session) => session.spec.role !== "audit-synthesis")
      .every((session) => session.interrupted === 1),
    true,
  );
  assert.equal(
    run.controller
      .get(runId)
      ?.agents.every((agent) => agent.status === "cancelled"),
    true,
  );
  await run.controller.dispose();
});

test("closure finalization rejects blocker substitution", async () => {
  const run = harness();
  const runId = run.controller.start({
    pipeline: "audit-pipeline",
    task: "Verify blocker closure",
    workingDir: "/tmp/work",
    audit: {
      mode: "closure",
      acceptanceCriteria: [],
      priorBlockers: [{ id: "BLOCK-1", closureCondition: "Condition one" }],
      remediationDiff: "diff",
      touchedInvariants: ["Invariant one"],
    },
  });
  await flush();
  const firstRole = AUDIT_SEGMENT_LUNA_ROLES[0];
  settle(sessionFor(run, firstRole), trackReport(firstRole));
  await flush();
  for (const role of AUDIT_SEGMENT_LUNA_ROLES.slice(1)) {
    settle(sessionFor(run, role), trackReport(role));
  }
  const synthesizer = sessionFor(run, "audit-synthesis");
  settle(synthesizer, intermediate([firstRole]));
  await flush();
  for (let attempt = 0; attempt < 4; attempt++) {
    settle(
      synthesizer,
      finalReport(
        AUDIT_SEGMENT_LUNA_ROLES,
        [
          {
            blockerId: "OTHER",
            closureCondition: "Condition one",
            status: "closed",
            evidence: "proof",
          },
        ],
        "closure",
      ),
    );
    await flush();
  }
  assert.equal(run.controller.get(runId)?.status, "failed");
  assert.equal(run.handoffs.length, 1);
  await run.controller.dispose();
});
