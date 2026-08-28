import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Check } from "typebox/value";
import { assertPipelineGitCommitSupported } from "./domain.ts";
import pipelinesExtension, {
  PIPELINE_RUN_PARAMETERS,
  resolvePipelineDefinition,
  resolvePipelineWorkingDir,
} from "./index.ts";

test("pipeline extension registers run plus main-agent check/list without status/wait aliases", () => {
  const tools: string[] = [];
  const api = {
    on: () => {},
    registerTool: (tool: { name: string }) => tools.push(tool.name),
    registerMessageRenderer: () => {},
    registerCommand: () => {},
  } as unknown as ExtensionAPI;

  pipelinesExtension(api);

  assert.deepEqual(tools, ["pipeline_run", "pipeline_check", "pipeline_list"]);
  assert.equal(tools.includes("pipeline_status"), false);
  assert.equal(tools.includes("pipeline_wait"), false);
});

test("pipeline_run accepts a task with an optional working directory", () => {
  assert.equal(
    Check(PIPELINE_RUN_PARAMETERS, { task: "Build a feature" }),
    true,
  );
  for (const git_commit of [true, false]) {
    assert.equal(
      Check(PIPELINE_RUN_PARAMETERS, {
        pipeline: "feature-pipeline",
        task: "Implement a feature",
        working_dir: "/repo/current-branch",
        git_commit,
      }),
      true,
    );
  }
  assert.equal(
    Check(PIPELINE_RUN_PARAMETERS, {
      pipeline: "small-feature-pipeline",
      task: "Implement a bounded feature",
      working_dir: ".worktrees/small-feature",
      git_commit: true,
    }),
    true,
  );
  assert.equal(
    Check(PIPELINE_RUN_PARAMETERS, {
      pipeline: "plan-pipeline",
      task: "Plan a feature",
      working_dir: ".worktrees/feature",
    }),
    true,
  );
  assert.equal(
    Check(PIPELINE_RUN_PARAMETERS, {
      pipeline: "audit-pipeline",
      task: "Audit the bounded change",
      working_dir: ".worktrees/audit",
      audit: {
        mode: "initial",
        acceptance_criteria: ["The contract holds"],
      },
    }),
    true,
  );
  assert.equal(
    Check(PIPELINE_RUN_PARAMETERS, {
      pipeline: "audit-pipeline",
      task: "Verify prior blockers",
      audit: {
        mode: "closure",
        prior_blockers: [
          { id: "AUD-001", closure_condition: "The defect is fixed" },
        ],
        remediation_diff: "bounded supplied diff",
        touched_invariants: ["exactly-once delivery"],
      },
    }),
    true,
  );
  assert.equal(
    Check(PIPELINE_RUN_PARAMETERS, {
      pipeline: "audit-pipeline",
      task: "Incomplete closure audit",
      audit: {
        mode: "closure",
        prior_blockers: [
          { id: "AUD-001", closure_condition: "The defect is fixed" },
        ],
        remediation_diff: "bounded supplied diff",
        touched_invariants: [],
      },
    }),
    false,
  );
  assert.equal(
    Check(PIPELINE_RUN_PARAMETERS, {
      pipeline: "audit-pipeline",
      task: "Unsafe audit",
      audit: { mode: "closure", base_ref: "main", command: "git diff" },
    }),
    false,
  );
  assert.equal(
    Check(PIPELINE_RUN_PARAMETERS, {
      pipeline: "unknown-pipeline",
      task: "Build a feature",
    }),
    false,
  );
  assert.equal(Check(PIPELINE_RUN_PARAMETERS, {}), false);
});

test("git_commit public schema describes the definition and role boundary", () => {
  const description = Reflect.get(
    PIPELINE_RUN_PARAMETERS.properties.git_commit,
    "description",
  );
  assert.equal(typeof description, "string");
  assert.match(description, /feature-pipeline hard-requires explicit true/);
  assert.match(description, /dedicated clean attached linked worktree/);
  assert.match(description, /persistent implementer/);
  assert.match(description, /Plan\/audit reject true/);
  assert.match(description, /Never permits push/);
});

test("git_commit validation requires feature true and rejects plan/audit true", () => {
  assert.doesNotThrow(() =>
    assertPipelineGitCommitSupported("feature-pipeline", true),
  );
  for (const requested of [false]) {
    assert.throws(
      () => assertPipelineGitCommitSupported("feature-pipeline", requested),
      /requires explicit git_commit: true/,
    );
  }
  assert.doesNotThrow(() =>
    assertPipelineGitCommitSupported("small-feature-pipeline", true),
  );
  assert.doesNotThrow(() =>
    assertPipelineGitCommitSupported("plan-pipeline", false),
  );
  for (const pipeline of ["plan-pipeline", "audit-pipeline"] as const) {
    assert.throws(
      () => assertPipelineGitCommitSupported(pipeline, true),
      new RegExp(
        `git_commit is only supported for feature-pipeline and small-feature-pipeline.*${pipeline}`,
      ),
    );
  }
});

test("pipeline_run defaults to feature-pipeline and rejects unknown definitions", () => {
  assert.equal(resolvePipelineDefinition(), "feature-pipeline");
  assert.equal(
    resolvePipelineDefinition("feature-pipeline"),
    "feature-pipeline",
  );
  assert.equal(
    resolvePipelineDefinition("small-feature-pipeline"),
    "small-feature-pipeline",
  );
  assert.equal(resolvePipelineDefinition("plan-pipeline"), "plan-pipeline");
  assert.equal(resolvePipelineDefinition("audit-pipeline"), "audit-pipeline");
  assert.throws(
    () => resolvePipelineDefinition("unknown-pipeline"),
    /Unsupported pipeline definition/,
  );
});

test("pipeline_run defaults to the current directory and resolves explicit workspaces", () => {
  assert.equal(resolvePipelineWorkingDir("/repo"), "/repo");
  assert.equal(
    resolvePipelineWorkingDir("/repo", ".worktrees/feature"),
    "/repo/.worktrees/feature",
  );
});
