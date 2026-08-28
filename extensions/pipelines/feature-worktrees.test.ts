import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import {
  cleanupOwnedFeatureWorktreePaths,
  defaultFeatureGitOperations,
  validateDedicatedFeatureWorktree,
} from "./feature-worktrees.ts";
import type {
  FeatureCandidateHandoff,
  FeatureCandidateRole,
  FeatureSelection,
  FeatureSynthesisProvenance,
} from "./feature-best-of-three.ts";

function git(cwd: string, args: ReadonlyArray<string>) {
  return execFileSync("git", [...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pipi-best-three-git-"));
  const primary = path.join(root, "primary");
  const caller = path.join(root, "caller");
  fs.mkdirSync(primary);
  git(primary, ["init", "-q"]);
  git(primary, ["config", "user.email", "test@example.com"]);
  git(primary, ["config", "user.name", "Test"]);
  fs.writeFileSync(path.join(primary, "base.txt"), "base\n");
  git(primary, ["add", "."]);
  git(primary, ["commit", "-qm", "baseline"]);
  git(primary, ["worktree", "add", "-qb", "feat/caller", caller, "HEAD"]);
  return {
    root,
    primary,
    caller,
    cleanup() {
      try {
        git(primary, ["worktree", "remove", "--force", caller]);
      } catch {
        // Test cleanup remains bounded to its disposable fixture.
      }
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

function selectionFor(
  primary: FeatureCandidateRole,
  augmentationCandidates: FeatureSelection["augmentationCandidates"] = [],
): FeatureSelection {
  return {
    reportType: "feature-implementation-selection-v1",
    selectionOnlyAcknowledgement:
      "No code was written before primary selection.",
    comparisons: (["Minimal", "Robust", "Architectural"] as const).map(
      (role) => ({
        role,
        usableBase: true,
        criteria: {
          correctness: `${role} correctness`,
          acceptanceCoverage: `${role} coverage`,
          regressionRisk: `${role} regression risk`,
          repositoryFit: `${role} repository fit`,
          simplicity: `${role} simplicity`,
          maintainability: `${role} maintainability`,
          verificationQuality: `${role} verification quality`,
        },
      }),
    ),
    primaryCandidate: primary,
    rationale: `${primary} is the simplest reliable candidate`,
    augmentationCandidates,
  };
}

function commitCandidate(
  worktree: {
    role: FeatureCandidateRole;
    path: string;
    branchRef: string;
    baseCommit: string;
  },
  lifecycle: ReturnType<typeof defaultFeatureGitOperations.createLifecycle>,
) {
  const changedPath = `${worktree.role.toLowerCase()}.txt`;
  fs.writeFileSync(path.join(worktree.path, changedPath), `${worktree.role}\n`);
  const head = lifecycle.commitAssignedWorktree(
    `candidate-${worktree.role.toLowerCase()}`,
    worktree.path,
  );
  const handoff: FeatureCandidateHandoff = {
    reportType: "feature-implementation-candidate-v1",
    role: worktree.role,
    approachSummary: `${worktree.role} complete implementation`,
    changedPaths: [changedPath],
    checks: ["fixture verification passed"],
    assumptions: [],
    tradeoffs: ["Bounded fixture tradeoff"],
    unresolvedIssues: [],
    worktreePath: worktree.path,
    branchRef: worktree.branchRef,
    baseCommit: worktree.baseCommit,
    candidateHeadCommit: head,
  };
  return handoff;
}

test("feature preflight accepts only a clean attached dedicated linked worktree", () => {
  const repo = fixture();
  try {
    assert.throws(
      () => validateDedicatedFeatureWorktree(repo.primary),
      /rejects the repository primary checkout/,
    );
    const valid = validateDedicatedFeatureWorktree(repo.caller);
    assert.equal(valid.workingDir, fs.realpathSync.native(repo.caller));
    assert.equal(valid.branch, "feat/caller");
    assert.equal(valid.baseCommit, git(repo.caller, ["rev-parse", "HEAD"]));

    fs.writeFileSync(path.join(repo.caller, "dirty.txt"), "dirty\n");
    assert.throws(
      () => validateDedicatedFeatureWorktree(repo.caller),
      /requires a clean dedicated worktree/,
    );
    fs.rmSync(path.join(repo.caller, "dirty.txt"));

    git(repo.caller, ["checkout", "--detach", "-q"]);
    assert.throws(
      () => validateDedicatedFeatureWorktree(repo.caller),
      /requires an attached branch/,
    );
  } finally {
    repo.cleanup();
  }
});

test("controller lifecycle creates same-base isolated candidates, promotes exact primary-derived synthesis, and preserves refs", () => {
  const repo = fixture();
  try {
    const caller = defaultFeatureGitOperations.preflight(repo.caller);
    const lifecycle = defaultFeatureGitOperations.createLifecycle(
      caller,
      "run-integration",
    );
    const worktrees = lifecycle.createCandidateWorktrees();
    assert.equal(worktrees.length, 3);
    assert.equal(new Set(worktrees.map(({ path: item }) => item)).size, 3);
    assert.equal(
      worktrees.every(({ baseCommit }) => baseCommit === caller.baseCommit),
      true,
    );

    const frozen = worktrees.map((worktree) =>
      lifecycle.freezeCandidate(worktree, commitCandidate(worktree, lifecycle)),
    );
    assert.equal(new Set(frozen.map(({ headCommit }) => headCommit)).size, 3);
    const candidateRefs = frozen.map(({ branchRef, headCommit }) => ({
      branchRef,
      headCommit,
    }));

    const selectionDirectory = lifecycle.prepareSelectionDirectory();
    assert.deepEqual(fs.readdirSync(selectionDirectory), []);
    lifecycle.assertSelectionReadOnly(frozen);
    const primary = frozen[0]!;
    const synthesis = lifecycle.createSynthesisWorktree(primary);
    assert.equal(
      git(synthesis.path, ["rev-parse", "HEAD"]),
      primary.headCommit,
    );
    assert.equal(git(primary.path, ["rev-parse", "HEAD"]), primary.headCommit);

    const finalCommit = lifecycle.commitAssignedWorktree(
      "implementation-synthesis",
      synthesis.path,
    );
    const provenance: FeatureSynthesisProvenance = {
      reportType: "feature-implementation-synthesis-v1",
      primaryCandidate: primary.role,
      primaryCommit: primary.headCommit,
      acceptedAugmentations: [],
      rejectedAugmentations: [],
      changedPaths: [],
      checks: ["fixture verification passed"],
      assumptions: [],
      unresolvedIssues: [],
      finalCommit,
    };
    const validated = lifecycle.validateSynthesis(
      synthesis,
      provenance,
      selectionFor(primary.role),
      frozen,
    );
    lifecycle.promote(validated);
    assert.equal(git(repo.caller, ["rev-parse", "HEAD"]), finalCommit);
    assert.equal(
      git(repo.caller, ["rev-parse", "HEAD^{tree}"]),
      git(synthesis.path, ["rev-parse", `${finalCommit}^{tree}`]),
    );

    const temporaryRoot = lifecycle.temporaryRoot;
    lifecycle.cleanup();
    assert.equal(fs.existsSync(temporaryRoot), false);
    for (const reference of candidateRefs) {
      assert.equal(
        git(repo.caller, ["rev-parse", reference.branchRef]),
        reference.headCommit,
      );
    }
    assert.equal(
      git(repo.caller, ["rev-parse", synthesis.branchRef]),
      finalCommit,
    );
  } finally {
    repo.cleanup();
  }
});

test("candidate and synthesis changed-path handoffs reject duplicates and omissions", () => {
  const repo = fixture();
  try {
    const caller = defaultFeatureGitOperations.preflight(repo.caller);
    const lifecycle = defaultFeatureGitOperations.createLifecycle(
      caller,
      "run-path-sets",
    );
    const worktrees = lifecycle.createCandidateWorktrees();
    const minimal = worktrees[0]!;
    fs.writeFileSync(path.join(minimal.path, "one.txt"), "one\n");
    fs.writeFileSync(path.join(minimal.path, "two.txt"), "two\n");
    const head = lifecycle.commitAssignedWorktree(
      "candidate-minimal",
      minimal.path,
    );
    const invalidHandoff: FeatureCandidateHandoff = {
      reportType: "feature-implementation-candidate-v1",
      role: minimal.role,
      approachSummary: "Two-path implementation",
      changedPaths: ["one.txt", "one.txt"],
      checks: ["fixture verification passed"],
      assumptions: [],
      tradeoffs: ["fixture"],
      unresolvedIssues: [],
      worktreePath: minimal.path,
      branchRef: minimal.branchRef,
      baseCommit: minimal.baseCommit,
      candidateHeadCommit: head,
    };
    assert.throws(
      () => lifecycle.freezeCandidate(minimal, invalidHandoff),
      /changedPaths do not match/,
    );

    const validMinimal = lifecycle.freezeCandidate(minimal, {
      ...invalidHandoff,
      changedPaths: ["one.txt", "two.txt"],
    });
    const otherFrozen = worktrees
      .slice(1)
      .map((worktree) =>
        lifecycle.freezeCandidate(
          worktree,
          commitCandidate(worktree, lifecycle),
        ),
      );
    const frozen = [validMinimal, ...otherFrozen];
    lifecycle.prepareSelectionDirectory();
    const synthesis = lifecycle.createSynthesisWorktree(validMinimal);
    fs.writeFileSync(path.join(synthesis.path, "fourth.txt"), "rewrite\n");
    const finalCommit = lifecycle.commitAssignedWorktree(
      "implementation-synthesis",
      synthesis.path,
    );
    const provenance: FeatureSynthesisProvenance = {
      reportType: "feature-implementation-synthesis-v1",
      primaryCandidate: validMinimal.role,
      primaryCommit: validMinimal.headCommit,
      acceptedAugmentations: [],
      rejectedAugmentations: [],
      changedPaths: ["fourth.txt", "fourth.txt"],
      checks: ["fixture verification passed"],
      assumptions: [],
      unresolvedIssues: [],
      finalCommit,
    };
    assert.throws(
      () =>
        lifecycle.validateSynthesis(
          synthesis,
          provenance,
          selectionFor(validMinimal.role),
          frozen,
        ),
      /changedPaths do not match/,
    );
    assert.throws(
      () =>
        lifecycle.validateSynthesis(
          synthesis,
          { ...provenance, changedPaths: ["fourth.txt"] },
          selectionFor(validMinimal.role),
          frozen,
        ),
      /must be attributed exactly once/,
    );
    lifecycle.cleanup();
  } finally {
    repo.cleanup();
  }
});

test("synthesis accepts only fully attributed validated losing-candidate augmentations", () => {
  const repo = fixture();
  try {
    const caller = defaultFeatureGitOperations.preflight(repo.caller);
    const lifecycle = defaultFeatureGitOperations.createLifecycle(
      caller,
      "run-attribution",
    );
    const worktrees = lifecycle.createCandidateWorktrees();
    const frozen = worktrees.map((worktree) =>
      lifecycle.freezeCandidate(worktree, commitCandidate(worktree, lifecycle)),
    );
    const primary = frozen.find(({ role }) => role === "Minimal")!;
    const source = frozen.find(({ role }) => role === "Robust")!;
    const idea: FeatureSelection["augmentationCandidates"][number] = {
      sourceRole: source.role,
      idea: "Adopt the Robust edge-case fixture",
      objectiveBenefit: "Covers a concrete missing failure path",
      evidence: "robust.txt contains the verified fixture",
      sourcePaths: ["robust.txt"],
    };
    const selection = selectionFor(primary.role, [idea]);
    const synthesisPath = path.join(lifecycle.temporaryRoot, "synthesis");
    assert.throws(
      () =>
        lifecycle.validateSelection(
          selectionFor(primary.role, [
            {
              ...idea,
              sourceRole: primary.role,
              sourcePaths: ["minimal.txt"],
            },
          ]),
          frozen,
        ),
      /losing candidate before synthesis mutation/,
    );
    assert.equal(fs.existsSync(synthesisPath), false);
    assert.throws(
      () =>
        lifecycle.validateSelection(
          selectionFor(primary.role, [
            { ...idea, sourcePaths: ["invented.txt"] },
          ]),
          frozen,
        ),
      /exact unique paths/,
    );
    lifecycle.validateSelection(selection, frozen);
    lifecycle.prepareSelectionDirectory();
    const synthesis = lifecycle.createSynthesisWorktree(primary);
    fs.writeFileSync(
      path.join(synthesis.path, "fourth.txt"),
      "unrelated fourth implementation\n",
    );
    const unrelatedCommit = lifecycle.commitAssignedWorktree(
      "implementation-synthesis",
      synthesis.path,
    );
    const unrelatedProvenance: FeatureSynthesisProvenance = {
      reportType: "feature-implementation-synthesis-v1",
      primaryCandidate: primary.role,
      primaryCommit: primary.headCommit,
      acceptedAugmentations: [
        {
          ...idea,
          pathMappings: [{ sourcePath: "robust.txt", finalPath: "fourth.txt" }],
        },
      ],
      rejectedAugmentations: [],
      changedPaths: ["fourth.txt"],
      checks: ["fixture verification passed"],
      assumptions: [],
      unresolvedIssues: [],
      finalCommit: unrelatedCommit,
    };
    assert.throws(
      () =>
        lifecycle.validateSynthesis(
          synthesis,
          unrelatedProvenance,
          selection,
          frozen,
        ),
      /exactly match its frozen losing-candidate source blob/,
    );

    fs.rmSync(path.join(synthesis.path, "fourth.txt"));
    fs.copyFileSync(
      path.join(source.path, "robust.txt"),
      path.join(synthesis.path, "robust.txt"),
    );
    const finalCommit = lifecycle.commitAssignedWorktree(
      "implementation-synthesis",
      synthesis.path,
    );
    const provenance: FeatureSynthesisProvenance = {
      reportType: "feature-implementation-synthesis-v1",
      primaryCandidate: primary.role,
      primaryCommit: primary.headCommit,
      acceptedAugmentations: [
        {
          ...idea,
          pathMappings: [{ sourcePath: "robust.txt", finalPath: "robust.txt" }],
        },
      ],
      rejectedAugmentations: [],
      changedPaths: ["robust.txt"],
      checks: ["fixture verification passed"],
      assumptions: [],
      unresolvedIssues: [],
      finalCommit,
    };
    assert.throws(
      () =>
        lifecycle.validateSynthesis(
          synthesis,
          {
            ...provenance,
            acceptedAugmentations: [
              {
                ...provenance.acceptedAugmentations[0]!,
                idea: "Fabricated fourth implementation",
              },
            ],
          },
          selection,
          frozen,
        ),
      /validated selection idea/,
    );
    assert.equal(
      lifecycle.validateSynthesis(synthesis, provenance, selection, frozen)
        .finalCommit,
      finalCommit,
    );
    lifecycle.cleanup();
  } finally {
    repo.cleanup();
  }
});

test("candidate freeze rejects a clean same-branch head that does not descend from the captured base", () => {
  const repo = fixture();
  try {
    const caller = defaultFeatureGitOperations.preflight(repo.caller);
    const lifecycle = defaultFeatureGitOperations.createLifecycle(
      caller,
      "run-ancestry",
    );
    const [minimal] = lifecycle.createCandidateWorktrees();
    assert.ok(minimal);
    const tree = git(minimal.path, ["write-tree"]);
    const unrelated = git(minimal.path, [
      "commit-tree",
      tree,
      "-m",
      "unrelated root",
    ]);
    git(minimal.path, [
      "update-ref",
      `refs/heads/${minimal.branchRef}`,
      unrelated,
    ]);
    git(minimal.path, ["reset", "--hard", "-q", unrelated]);
    const handoff: FeatureCandidateHandoff = {
      reportType: "feature-implementation-candidate-v1",
      role: minimal.role,
      approachSummary: "Unrelated candidate",
      changedPaths: ["base.txt"],
      checks: ["fixture"],
      assumptions: [],
      tradeoffs: ["invalid ancestry"],
      unresolvedIssues: [],
      worktreePath: minimal.path,
      branchRef: minimal.branchRef,
      baseCommit: minimal.baseCommit,
      candidateHeadCommit: unrelated,
    };
    assert.throws(
      () => lifecycle.freezeCandidate(minimal, handoff),
      /candidate ancestry is invalid/,
    );
    lifecycle.cleanup();
  } finally {
    repo.cleanup();
  }
});

test("cleanup retains a registered run-owned directory when worktree metadata removal fails", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pipi-cleanup-failure-"));
  const owned = path.join(root, "candidate-minimal");
  fs.mkdirSync(owned);
  const failures = cleanupOwnedFeatureWorktreePaths(root, [owned], () => {
    throw new Error("injected remove failure");
  });
  assert.equal(failures.length, 1);
  assert.match(failures[0]!, /injected remove failure/);
  assert.equal(fs.existsSync(root), true);
  fs.rmSync(root, { recursive: true, force: true });
});

test("failure cleanup removes only controller-owned temporary worktrees and never promotes", () => {
  const repo = fixture();
  const unrelated = path.join(repo.root, "unrelated");
  try {
    git(repo.primary, [
      "worktree",
      "add",
      "-qb",
      "feat/unrelated",
      unrelated,
      "HEAD",
    ]);
    const caller = defaultFeatureGitOperations.preflight(repo.caller);
    const lifecycle = defaultFeatureGitOperations.createLifecycle(
      caller,
      "run-cancelled",
    );
    lifecycle.createCandidateWorktrees();
    const base = git(repo.caller, ["rev-parse", "HEAD"]);
    const temporaryRoot = lifecycle.temporaryRoot;
    lifecycle.cleanup();
    assert.equal(git(repo.caller, ["rev-parse", "HEAD"]), base);
    assert.equal(fs.existsSync(temporaryRoot), false);
    assert.equal(fs.existsSync(unrelated), true);
    assert.match(
      git(unrelated, ["branch", "--show-current"]),
      /feat\/unrelated/,
    );
  } finally {
    try {
      git(repo.primary, ["worktree", "remove", "--force", unrelated]);
    } catch {
      // Disposable fixture cleanup.
    }
    repo.cleanup();
  }
});
