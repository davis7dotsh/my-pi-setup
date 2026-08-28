import assert from "node:assert/strict";
import test from "node:test";
import {
  FEATURE_PIPELINE_CHILD_ROLES,
  PIPELINE_DEFINITION_IDS,
} from "./domain.ts";
import {
  pipelineCommitPolicy,
  SMALL_FEATURE_AUDIT_GIT_REQUIREMENTS,
} from "./prompt.ts";

const commitRequested = {
  gitCommit: true,
  task: "Task prose may also request a commit",
};

test("feature commit authority is explicit and limited to the persistent root", () => {
  assert.deepEqual(
    pipelineCommitPolicy("feature-pipeline", "pipeline-root", commitRequested),
    {
      requested: true,
      commitAllowed: true,
      taskProseCanGrant: false,
    },
  );
  for (const role of FEATURE_PIPELINE_CHILD_ROLES) {
    assert.equal(
      pipelineCommitPolicy("feature-pipeline", role, commitRequested)
        .commitAllowed,
      false,
      role,
    );
  }
});

test("feature commit authority defaults off and task prose cannot grant it", () => {
  for (const request of [{}, { gitCommit: false }]) {
    assert.deepEqual(
      pipelineCommitPolicy("feature-pipeline", "pipeline-root", request),
      {
        requested: false,
        commitAllowed: false,
        taskProseCanGrant: false,
      },
    );
  }
});

test("small-feature commit authority remains an explicit structured role policy", () => {
  assert.deepEqual(
    pipelineCommitPolicy(
      "small-feature-pipeline",
      "implement-small-feature",
      commitRequested,
    ),
    {
      requested: true,
      commitAllowed: true,
      taskProseCanGrant: false,
    },
  );
  assert.deepEqual(
    pipelineCommitPolicy("small-feature-pipeline", "implement-small-feature", {
      gitCommit: false,
    }),
    {
      requested: false,
      commitAllowed: false,
      taskProseCanGrant: false,
    },
  );
});

test("small-feature root and audit roles never receive commit authority", () => {
  assert.equal(
    pipelineCommitPolicy(
      "small-feature-pipeline",
      "pipeline-root",
      commitRequested,
    ).commitAllowed,
    false,
  );
  assert.equal(
    pipelineCommitPolicy(
      "small-feature-pipeline",
      "audit-logic-invariants",
      commitRequested,
    ).commitAllowed,
    false,
  );
});

test("plan and audit definitions never grant commit authority", () => {
  for (const definition of PIPELINE_DEFINITION_IDS) {
    if (
      definition === "feature-pipeline" ||
      definition === "small-feature-pipeline"
    ) {
      continue;
    }
    assert.equal(
      pipelineCommitPolicy(definition, "pipeline-root", commitRequested)
        .commitAllowed,
      false,
    );
    assert.equal(
      pipelineCommitPolicy(definition, "audit-feature-outcome", commitRequested)
        .commitAllowed,
      false,
    );
  }
});

test("small-feature commit audit requirements are a structured contract", () => {
  assert.deepEqual(Object.keys(SMALL_FEATURE_AUDIT_GIT_REQUIREMENTS), [
    "evidence",
    "scope",
    "ancestry",
    "reviewedState",
    "uncertainty",
    "commitStyle",
  ]);
});
