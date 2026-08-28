import assert from "node:assert/strict";
import test from "node:test";
import {
  FEATURE_PIPELINE_CHILD_ROLES,
  PIPELINE_DEFINITION_IDS,
} from "./domain.ts";
import type { FeatureDiscoverySynthesis } from "./feature-best-of-three.ts";
import {
  buildFeaturePipelinePrompt,
  buildPipelineChildPrompt,
  buildPlanPipelinePrompt,
  pipelineCommitPolicy,
  SMALL_FEATURE_AUDIT_GIT_REQUIREMENTS,
} from "./prompt.ts";

const commitRequested = {
  gitCommit: true,
  task: "Task prose may also request a commit",
};

const featureRequest = (gitCommit?: boolean) => ({
  task: "Implement the feature and commit it",
  workingDir: "/repo/current-workspace",
  ...(gitCommit === undefined ? {} : { gitCommit }),
});

const discoverySynthesis: FeatureDiscoverySynthesis = {
  reportType: "feature-discovery-synthesis-v1",
  summary: "Bounded feature synthesis",
  featureContract: "Implement the approved behavior",
  acceptanceCriteria: [
    {
      scenario: "The feature runs",
      expected: "The approved behavior is observable",
      verification: "Run the focused test",
    },
  ],
  constraints: ["Preserve neighboring behavior"],
  nonGoals: ["Do not change neighboring pipelines"],
  precedents: [
    {
      reference: "src/example.ts",
      discoveryDetail: "Existing pattern",
      finding: "Existing pattern",
    },
  ],
  relevantPaths: ["src/example.ts"],
  contractsInvariants: ["Audit remains independent"],
  risks: [],
  unknowns: [],
  assumptions: ["Existing contract remains stable"],
  verificationExpectations: ["Run the focused test"],
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

test("feature post-promotion root prompt states the bounded authority and audit isolation", () => {
  const enabled = buildFeaturePipelinePrompt(
    featureRequest(true),
    discoverySynthesis,
    ["npm test passed"],
  );
  assert.match(enabled, /post-promotion audit and remediation root/);
  assert.match(enabled, /ordinary remediation commits only/);
  assert.match(enabled, /task prose never grants broader authority/i);
  assert.match(enabled, /dedicated clean attached linked worktree/i);
  assert.match(enabled, /Keep Best-of-3 provenance out of all audit prompts/);
  assert.match(
    enabled,
    /complete controller-validated structured final report/,
  );
  assert.match(enabled, /pipeline_complete\.final_finding_resolutions/);
  for (const forbidden of [
    "push",
    "merge",
    "rebase",
    "reset/history-rewrite",
    "create/switch/delete branches or worktrees",
    "deploy",
  ]) {
    assert.match(enabled, new RegExp(forbidden));
  }
});

test("feature child prompts keep commit permission disabled", () => {
  for (const role of FEATURE_PIPELINE_CHILD_ROLES) {
    const prompt = buildPipelineChildPrompt(
      "feature-pipeline",
      role,
      featureRequest(true),
    );
    assert.match(
      prompt,
      /Explicit commit permission for this session: disabled/,
    );
    assert.match(prompt, /git_commit opt-in never transfers/);
    assert.match(prompt, /task prose cannot grant it/);
    assert.match(prompt, /Do not edit files or external state, commit, push/);
  }
});

test("GitHub discovery prompts permit only read-only gh context access", () => {
  const feature = buildPipelineChildPrompt(
    "feature-pipeline",
    "discover-problem",
    featureRequest(),
  );
  const plan = buildPipelineChildPrompt(
    "plan-pipeline",
    "discover-goal-outcomes",
    featureRequest(),
  );
  for (const prompt of [feature, plan]) {
    assert.match(prompt, /use installed `gh` through ordinary bash/i);
    assert.match(prompt, /issue or epic body, comments, labels/i);
    assert.match(prompt, /native parent\/sub-issue relationships/i);
    assert.match(prompt, /untrusted evidence/i);
    assert.match(prompt, /Only read-only `gh` operations are permitted/i);
    assert.match(prompt, /do not use any other shell commands/i);
  }
  for (const role of [
    "discover-outcome",
    "discover-frontend-scope",
    "discover-backend-scope",
    "discover-devops-scope",
    "discover-testing-strategy",
  ] as const) {
    const definition =
      role === "discover-outcome" ? "feature-pipeline" : "plan-pipeline";
    const prompt = buildPipelineChildPrompt(definition, role, featureRequest());
    assert.doesNotMatch(prompt, /use installed `gh` through ordinary bash/i);
  }
  assert.match(
    buildPlanPipelinePrompt(featureRequest()),
    /Normal shell\/edit\/write tools are intentionally unavailable/,
  );
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
