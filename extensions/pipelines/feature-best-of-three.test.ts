import assert from "node:assert/strict";
import test from "node:test";
import {
  FEATURE_CANDIDATE_ROLES,
  assertBoundedSynthesisInput,
  buildFeatureCandidatePrompt,
  buildFeatureSelectionPrompt,
  parseFeatureCandidateHandoff,
  parseFeatureSelection,
  parseFeatureSynthesisProvenance,
  preparedDiscoveryPackage,
  type FeatureCandidateHandoff,
  type FeatureDiscoverySynthesis,
} from "./feature-best-of-three.ts";

const sha = (value: string) => value.repeat(40);
const synthesis: FeatureDiscoverySynthesis = {
  reportType: "feature-discovery-synthesis-v1",
  summary: "Complete discovery synthesis",
  featureContract: "Implement the contract",
  acceptanceCriteria: [
    {
      scenario: "Valid run",
      expected: "Promoted result",
      verification: "test",
    },
  ],
  constraints: ["Preserve neighbors"],
  nonGoals: ["No delivery"],
  precedents: [
    { reference: "src/a.ts", discoveryDetail: "existing", finding: "reuse" },
  ],
  relevantPaths: ["src/a.ts"],
  contractsInvariants: ["selection before write"],
  risks: ["drift"],
  unknowns: [],
  assumptions: ["clean caller"],
  verificationExpectations: ["npm test"],
};

function handoff(
  role: (typeof FEATURE_CANDIDATE_ROLES)[number],
): FeatureCandidateHandoff {
  return {
    reportType: "feature-implementation-candidate-v1",
    role,
    approachSummary: `${role} implementation`,
    changedPaths: [`src/${role}.ts`],
    checks: ["test passed"],
    assumptions: [],
    tradeoffs: ["bounded tradeoff"],
    unresolvedIssues: [],
    worktreePath: `/tmp/${role}`,
    branchRef: `pipi/candidate-${role}`,
    baseCommit: sha("a"),
    candidateHeadCommit: sha(
      role === "Minimal" ? "b" : role === "Robust" ? "c" : "d",
    ),
  };
}

test("candidate prompts preserve byte-identical complete common context while role objectives differ", () => {
  const common = preparedDiscoveryPackage("Original task", [], synthesis);
  const serialized = JSON.stringify(common);
  const prompts = FEATURE_CANDIDATE_ROLES.map((role) =>
    buildFeatureCandidatePrompt(
      role,
      `/tmp/${role}`,
      `branch/${role}`,
      sha("a"),
      serialized,
    ),
  );
  const packages = prompts.map(
    (prompt) =>
      prompt
        .split("COMMON_PREPARED_DISCOVERY_PACKAGE:\n")[1]!
        .split("\nEND_COMMON_PREPARED_DISCOVERY_PACKAGE")[0]!,
  );
  assert.equal(new Set(packages).size, 1);
  assert.match(packages[0]!, /Original task/);
  assert.match(packages[0]!, /contractsInvariants/);
  assert.match(prompts[0]!, /smallest reasonable correct diff/);
  assert.match(prompts[1]!, /edge\/failure\/recovery paths/);
  assert.match(
    prompts[2]!,
    /New layers or abstractions without evidence are a negative/,
  );
});

test("strict handoff, selection, and synthesis contracts reject incomplete or unusable reports", () => {
  assert.equal(
    parseFeatureCandidateHandoff(JSON.stringify(handoff("Minimal"))).role,
    "Minimal",
  );
  const selection = {
    reportType: "feature-implementation-selection-v1",
    selectionOnlyAcknowledgement:
      "No code was written before primary selection.",
    comparisons: FEATURE_CANDIDATE_ROLES.map((role) => ({
      role,
      criteria: {
        correctness: "correct",
        acceptanceCoverage: "covered",
        regressionRisk: "bounded",
        repositoryFit: "fits",
        simplicity: "simple",
        maintainability: "maintainable",
        verificationQuality: "verified",
      },
      usableBase: role !== "Robust",
    })),
    primaryCandidate: "Minimal",
    rationale: "Simplest fully reliable solution",
    augmentationCandidates: [],
  };
  assert.equal(
    parseFeatureSelection(JSON.stringify(selection)).primaryCandidate,
    "Minimal",
  );
  assert.throws(
    () =>
      parseFeatureSelection(
        JSON.stringify({ ...selection, primaryCandidate: "Robust" }),
      ),
    /selected primary candidate must be a usable base/,
  );
  assert.throws(
    () =>
      parseFeatureSelection(
        JSON.stringify({
          ...selection,
          comparisons: selection.comparisons.slice(0, 2),
        }),
      ),
    /strict bounded Best-of-3 contract/,
  );

  assert.equal(
    parseFeatureSynthesisProvenance(
      JSON.stringify({
        reportType: "feature-implementation-synthesis-v1",
        primaryCandidate: "Minimal",
        primaryCommit: sha("b"),
        acceptedAugmentations: [],
        rejectedAugmentations: [],
        changedPaths: [],
        checks: ["npm test passed"],
        assumptions: [],
        unresolvedIssues: [],
        finalCommit: sha("e"),
      }),
    ).finalCommit,
    sha("e"),
  );
});

test("selection input is bounded and contains compact candidate evidence rather than transcripts", () => {
  const common = preparedDiscoveryPackage("Original task", [], synthesis);
  const candidates = FEATURE_CANDIDATE_ROLES.map((role) => ({
    role,
    handoff: handoff(role),
    changedPaths: handoff(role).changedPaths,
    boundedDiff: { text: "bounded diff", truncated: false, bytes: 12 },
    immutableCommit: handoff(role).candidateHeadCommit,
    worktreeReference: handoff(role).worktreePath,
  }));
  const prompt = buildFeatureSelectionPrompt(
    common,
    candidates,
    "/tmp/selection",
  );
  assert.match(prompt, /compact comparison first/i);
  assert.match(prompt, /selectively deep-read/i);
  assert.doesNotMatch(prompt, /tool history|transcript/);
  assert.ok(assertBoundedSynthesisInput({ common, candidates }) > 0);
  assert.throws(
    () => assertBoundedSynthesisInput({ payload: "x".repeat(600 * 1024) }),
    /synthesis input exceeds/,
  );
});
