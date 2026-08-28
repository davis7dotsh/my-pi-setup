import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type {
  FeatureCandidateHandoff,
  FeatureCandidateRole,
  FeatureSelection,
  FeatureSynthesisProvenance,
} from "./feature-best-of-three.ts";

const GIT_OUTPUT_LIMIT = 512 * 1024;
const CANDIDATE_DIFF_LIMIT = 48 * 1024;
const SYNTHESIS_DIFF_LIMIT = 128 * 1024;
const SYNTHESIS_CHANGED_PATH_LIMIT = 64;

export interface FeatureCallerWorktree {
  readonly workingDir: string;
  readonly repositoryRoot: string;
  readonly commonGitDir: string;
  readonly branch: string;
  readonly branchRef: string;
  readonly baseCommit: string;
}

export interface FeatureTemporaryWorktree {
  readonly role: FeatureCandidateRole;
  readonly path: string;
  readonly branchRef: string;
  readonly baseCommit: string;
}

export interface FrozenFeatureCandidate extends FeatureTemporaryWorktree {
  readonly headCommit: string;
  readonly changedPaths: ReadonlyArray<string>;
  readonly boundedDiff: {
    readonly text: string;
    readonly truncated: boolean;
    readonly bytes: number;
  };
  readonly frozen: true;
}

export interface FeatureSynthesisWorktree {
  readonly path: string;
  readonly branchRef: string;
  readonly primaryRole: FeatureCandidateRole;
  readonly primaryCommit: string;
}

export interface ValidatedFeatureSynthesis extends FeatureSynthesisWorktree {
  readonly finalCommit: string;
  readonly changedPaths: ReadonlyArray<string>;
}

export interface FeatureWorktreeLifecycle {
  readonly caller: FeatureCallerWorktree;
  readonly temporaryRoot: string;
  createCandidateWorktrees(): ReadonlyArray<FeatureTemporaryWorktree>;
  freezeCandidate(
    worktree: FeatureTemporaryWorktree,
    handoff: FeatureCandidateHandoff,
  ): FrozenFeatureCandidate;
  prepareSelectionDirectory(): string;
  assertSelectionReadOnly(
    candidates: ReadonlyArray<FrozenFeatureCandidate>,
  ): void;
  createSynthesisWorktree(
    primary: FrozenFeatureCandidate,
  ): FeatureSynthesisWorktree;
  commitAssignedWorktree(role: string, workingDir: string): string;
  validateSynthesis(
    worktree: FeatureSynthesisWorktree,
    provenance: FeatureSynthesisProvenance,
    selection: FeatureSelection,
    candidates: ReadonlyArray<FrozenFeatureCandidate>,
  ): ValidatedFeatureSynthesis;
  promote(synthesis: ValidatedFeatureSynthesis): void;
  cleanup(): ReadonlyArray<string>;
}

export interface FeatureGitOperations {
  preflight(workingDir: string): FeatureCallerWorktree;
  createLifecycle(
    caller: FeatureCallerWorktree,
    runId: string,
  ): FeatureWorktreeLifecycle;
}

function git(
  cwd: string,
  args: ReadonlyArray<string>,
  maxBuffer = GIT_OUTPUT_LIMIT,
) {
  return execFileSync("git", [...args], {
    cwd,
    encoding: "utf8",
    maxBuffer,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function boundedDiagnostic(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/g, " ").slice(0, 2 * 1024);
}

function requireGit(cwd: string, args: ReadonlyArray<string>, label: string) {
  try {
    return git(cwd, args);
  } catch (error) {
    throw new Error(`${label}: ${boundedDiagnostic(error)}`);
  }
}

function cleanStatus(workingDir: string) {
  return requireGit(
    workingDir,
    ["status", "--porcelain=v1", "--untracked-files=all"],
    "Unable to inspect worktree cleanliness",
  );
}

function canonical(value: string) {
  return fs.realpathSync.native(path.resolve(value));
}

function comparablePath(value: string) {
  try {
    return canonical(value);
  } catch {
    return path.resolve(value);
  }
}

function parseWorktreeList(value: string) {
  return value
    .split(/\n\s*\n/)
    .map((block) =>
      Object.fromEntries(
        block
          .split("\n")
          .filter(Boolean)
          .map((line) => {
            const space = line.indexOf(" ");
            return space < 0
              ? [line, "true"]
              : [line.slice(0, space), line.slice(space + 1)];
          }),
      ),
    )
    .filter((entry) => typeof entry.worktree === "string");
}

export function validateDedicatedFeatureWorktree(
  workingDir: string,
): FeatureCallerWorktree {
  if (process.platform !== "linux" || !fs.existsSync("/usr/bin/bwrap")) {
    throw new Error(
      "feature-pipeline requires Linux bubblewrap at /usr/bin/bwrap for candidate workspace isolation.",
    );
  }
  try {
    fs.accessSync("/usr/bin/bwrap", fs.constants.X_OK);
  } catch {
    throw new Error(
      "feature-pipeline requires executable /usr/bin/bwrap for candidate workspace isolation.",
    );
  }
  let resolved: string;
  try {
    resolved = canonical(workingDir);
  } catch (error) {
    throw new Error(
      `feature-pipeline working_dir is unavailable: ${boundedDiagnostic(error)}`,
    );
  }
  const repositoryRoot = canonical(
    requireGit(
      resolved,
      ["rev-parse", "--show-toplevel"],
      "Not a Git worktree",
    ),
  );
  if (repositoryRoot !== resolved) {
    throw new Error(
      "feature-pipeline working_dir must be the root of its dedicated linked Git worktree.",
    );
  }
  const worktrees = parseWorktreeList(
    requireGit(
      resolved,
      ["worktree", "list", "--porcelain"],
      "Unable to list Git worktrees",
    ),
  );
  const currentIndex = worktrees.findIndex(
    (entry) => comparablePath(entry.worktree!) === resolved,
  );
  if (currentIndex < 0) {
    throw new Error(
      "feature-pipeline working_dir is not registered as a linked Git worktree.",
    );
  }
  if (currentIndex === 0) {
    throw new Error(
      "feature-pipeline rejects the repository primary checkout; use a dedicated linked Git worktree.",
    );
  }
  const entry = worktrees[currentIndex]!;
  if (entry.detached === "true" || !entry.branch) {
    throw new Error(
      "feature-pipeline requires an attached branch in the dedicated linked worktree.",
    );
  }
  const branchRef = requireGit(
    resolved,
    ["symbolic-ref", "-q", "HEAD"],
    "feature-pipeline requires an attached branch",
  );
  const branch = requireGit(
    resolved,
    ["symbolic-ref", "--short", "HEAD"],
    "Unable to resolve feature branch",
  );
  const firstHead = requireGit(
    resolved,
    ["rev-parse", "HEAD"],
    "Unable to capture feature base commit",
  );
  const status = cleanStatus(resolved);
  if (status) {
    throw new Error(
      `feature-pipeline requires a clean dedicated worktree; status is non-empty (${status.slice(0, 1024)}).`,
    );
  }
  const secondHead = requireGit(
    resolved,
    ["rev-parse", "HEAD"],
    "Unable to confirm stable feature base commit",
  );
  if (firstHead !== secondHead) {
    throw new Error(
      "feature-pipeline base commit changed during preflight; retry from a stable worktree.",
    );
  }
  const commonGitDir = canonical(
    path.resolve(
      resolved,
      requireGit(
        resolved,
        ["rev-parse", "--git-common-dir"],
        "Unable to resolve common Git directory",
      ),
    ),
  );
  const gitDir = canonical(
    path.resolve(
      resolved,
      requireGit(
        resolved,
        ["rev-parse", "--git-dir"],
        "Unable to resolve Git directory",
      ),
    ),
  );
  if (gitDir === commonGitDir) {
    throw new Error(
      "feature-pipeline requires a linked worktree with a worktree-specific Git directory.",
    );
  }
  return {
    workingDir: resolved,
    repositoryRoot,
    commonGitDir,
    branch,
    branchRef,
    baseCommit: firstHead,
  };
}

function branchSlug(runId: string) {
  const safe = runId
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .slice(0, 48);
  return `pipi-feature/${safe || "run"}`;
}

function roleSlug(role: FeatureCandidateRole) {
  return role.toLowerCase();
}

function requireAncestor(
  cwd: string,
  ancestor: string,
  descendant: string,
  label: string,
) {
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", ancestor, descendant], {
      cwd,
      stdio: "ignore",
    });
  } catch {
    throw new Error(
      `${label}: ${ancestor} is not an ancestor of ${descendant}.`,
    );
  }
}

function readChangedPaths(cwd: string, from: string, to: string) {
  const value = requireGit(
    cwd,
    ["diff", "--name-only", "--no-renames", `${from}..${to}`, "--"],
    "Unable to inspect changed paths",
  );
  return value ? value.split("\n").filter(Boolean) : [];
}

function equalUniquePathSets(
  reported: ReadonlyArray<string>,
  actual: ReadonlyArray<string>,
) {
  const reportedSet = new Set(reported);
  const actualSet = new Set(actual);
  return (
    reportedSet.size === reported.length &&
    actualSet.size === actual.length &&
    reportedSet.size === actualSet.size &&
    [...reportedSet].every((item) => actualSet.has(item))
  );
}

function selectionAugmentationKey(value: {
  sourceRole: FeatureCandidateRole;
  idea: string;
  objectiveBenefit: string;
  evidence: string;
}) {
  return JSON.stringify([
    value.sourceRole,
    value.idea,
    value.objectiveBenefit,
    value.evidence,
  ]);
}

function validateAugmentationAttribution(
  provenance: FeatureSynthesisProvenance,
  selection: FeatureSelection,
  candidates: ReadonlyArray<FrozenFeatureCandidate>,
  actualChangedPaths: ReadonlyArray<string>,
) {
  const selectedIdeas = new Set(
    selection.augmentationCandidates.map(selectionAugmentationKey),
  );
  const usedIdeas = new Set<string>();
  const attributedPaths: string[] = [];
  for (const augmentation of provenance.acceptedAugmentations) {
    if (augmentation.sourceRole === provenance.primaryCandidate) {
      throw new Error(
        "Accepted augmentation must originate from a losing candidate.",
      );
    }
    const ideaKey = selectionAugmentationKey(augmentation);
    if (!selectedIdeas.has(ideaKey) || usedIdeas.has(ideaKey)) {
      throw new Error(
        "Accepted augmentation must match exactly one validated selection idea.",
      );
    }
    usedIdeas.add(ideaKey);
    const source = candidates.find(
      ({ role }) => role === augmentation.sourceRole,
    );
    if (
      !source ||
      !equalUniquePathSets(
        augmentation.sourcePaths,
        augmentation.sourcePaths.filter((item) =>
          source.changedPaths.includes(item),
        ),
      )
    ) {
      throw new Error(
        "Accepted augmentation sourcePaths must be unique paths from its losing candidate diff.",
      );
    }
    if (
      new Set(augmentation.changedPaths).size !==
        augmentation.changedPaths.length ||
      augmentation.changedPaths.some(
        (item) => !actualChangedPaths.includes(item),
      )
    ) {
      throw new Error(
        "Accepted augmentation changedPaths must uniquely identify actual primary-to-final changes.",
      );
    }
    attributedPaths.push(...augmentation.changedPaths);
  }
  if (!equalUniquePathSets(attributedPaths, actualChangedPaths)) {
    throw new Error(
      "Every primary-to-final changed path must be attributed exactly once to a validated losing-candidate idea.",
    );
  }
}

function boundedDiff(cwd: string, from: string, to: string, limit: number) {
  const value = requireGit(
    cwd,
    ["diff", "--no-ext-diff", "--no-color", `${from}..${to}`, "--"],
    "Unable to inspect candidate diff",
  );
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes <= limit) return { text: value, truncated: false, bytes };
  const marker = `\n[diff truncated at ${limit} UTF-8 bytes]`;
  const payload = Buffer.from(value, "utf8")
    .subarray(0, limit - Buffer.byteLength(marker, "utf8"))
    .toString("utf8");
  return { text: `${payload}${marker}`, truncated: true, bytes };
}

export function cleanupOwnedFeatureWorktreePaths(
  temporaryRoot: string,
  ownedPaths: ReadonlyArray<string>,
  removeWorktree: (worktreePath: string) => void,
) {
  const failures: string[] = [];
  for (const worktreePath of [...ownedPaths].reverse()) {
    if (
      !path
        .resolve(worktreePath)
        .startsWith(`${path.resolve(temporaryRoot)}${path.sep}`)
    ) {
      continue;
    }
    try {
      removeWorktree(worktreePath);
    } catch (error) {
      failures.push(
        `Failed to remove controller-owned worktree ${worktreePath}: ${boundedDiagnostic(error)}`,
      );
    }
  }
  if (failures.length > 0) return failures;
  try {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  } catch (error) {
    failures.push(
      `Failed to remove controller-owned temporary root ${temporaryRoot}: ${boundedDiagnostic(error)}`,
    );
  }
  return failures;
}

class GitFeatureWorktreeLifecycle implements FeatureWorktreeLifecycle {
  readonly caller: FeatureCallerWorktree;
  readonly runId: string;
  readonly temporaryRoot: string;
  private readonly ownedWorktreePaths = new Set<string>();
  private readonly candidateHeads = new Map<FeatureCandidateRole, string>();
  private selectionDirectory?: string;
  private synthesis?: FeatureSynthesisWorktree;
  private cleaned = false;

  constructor(caller: FeatureCallerWorktree, runId: string) {
    this.caller = caller;
    this.runId = runId;
    this.temporaryRoot = fs.mkdtempSync(
      path.join(
        os.tmpdir(),
        `pipi-feature-${branchSlug(runId).split("/").at(-1)}-`,
      ),
    );
  }

  private worktreeAdd(worktreePath: string, branchRef: string, commit: string) {
    requireGit(
      this.caller.workingDir,
      ["worktree", "add", "--no-track", "-b", branchRef, worktreePath, commit],
      `Unable to create controller-owned worktree ${branchRef}`,
    );
    this.ownedWorktreePaths.add(worktreePath);
  }

  createCandidateWorktrees() {
    const base = branchSlug(this.runId);
    const worktrees = (["Minimal", "Robust", "Architectural"] as const).map(
      (role) => ({
        role,
        path: path.join(this.temporaryRoot, `candidate-${roleSlug(role)}`),
        branchRef: `${base}/candidate-${roleSlug(role)}`,
        baseCommit: this.caller.baseCommit,
      }),
    );
    try {
      for (const worktree of worktrees) {
        this.worktreeAdd(
          worktree.path,
          worktree.branchRef,
          this.caller.baseCommit,
        );
      }
      return worktrees;
    } catch (error) {
      this.cleanup();
      throw error;
    }
  }

  freezeCandidate(
    worktree: FeatureTemporaryWorktree,
    handoff: FeatureCandidateHandoff,
  ) {
    const headCommit = requireGit(
      worktree.path,
      ["rev-parse", "HEAD"],
      `Unable to inspect ${worktree.role} candidate HEAD`,
    );
    const branchRef = requireGit(
      worktree.path,
      ["symbolic-ref", "--short", "HEAD"],
      `Unable to inspect ${worktree.role} candidate branch`,
    );
    const expected = {
      role: worktree.role,
      worktreePath: worktree.path,
      branchRef: worktree.branchRef,
      baseCommit: worktree.baseCommit,
      candidateHeadCommit: headCommit,
    };
    for (const [key, value] of Object.entries(expected)) {
      if (handoff[key as keyof typeof expected] !== value) {
        throw new Error(
          `${worktree.role} candidate handoff ${key} does not match controller Git state.`,
        );
      }
    }
    if (branchRef !== worktree.branchRef) {
      throw new Error(
        `${worktree.role} candidate changed its controller-owned branch.`,
      );
    }
    if (headCommit === worktree.baseCommit) {
      throw new Error(
        `${worktree.role} candidate did not create an implementation commit.`,
      );
    }
    requireAncestor(
      worktree.path,
      worktree.baseCommit,
      headCommit,
      `${worktree.role} candidate ancestry is invalid`,
    );
    if (cleanStatus(worktree.path)) {
      throw new Error(
        `${worktree.role} candidate must commit all implementation changes.`,
      );
    }
    const changedPaths = readChangedPaths(
      worktree.path,
      worktree.baseCommit,
      headCommit,
    );
    if (changedPaths.length === 0) {
      throw new Error(
        `${worktree.role} candidate commit contains no implementation changes.`,
      );
    }
    if (!equalUniquePathSets(handoff.changedPaths, changedPaths)) {
      throw new Error(
        `${worktree.role} candidate changedPaths do not match its committed diff.`,
      );
    }
    this.candidateHeads.set(worktree.role, headCommit);
    return {
      ...worktree,
      headCommit,
      changedPaths,
      boundedDiff: boundedDiff(
        worktree.path,
        worktree.baseCommit,
        headCommit,
        CANDIDATE_DIFF_LIMIT,
      ),
      frozen: true as const,
    };
  }

  prepareSelectionDirectory() {
    if (this.selectionDirectory) return this.selectionDirectory;
    this.selectionDirectory = path.join(this.temporaryRoot, "synthesis");
    fs.mkdirSync(this.selectionDirectory);
    return this.selectionDirectory;
  }

  assertSelectionReadOnly(candidates: ReadonlyArray<FrozenFeatureCandidate>) {
    if (!this.selectionDirectory) {
      throw new Error("Selection directory was not prepared.");
    }
    if (fs.readdirSync(this.selectionDirectory).length > 0) {
      throw new Error(
        "Selection phase wrote before choosing a primary candidate.",
      );
    }
    for (const candidate of candidates) {
      const head = requireGit(
        candidate.path,
        ["rev-parse", "HEAD"],
        "Unable to confirm frozen candidate",
      );
      if (
        head !== candidate.headCommit ||
        this.candidateHeads.get(candidate.role) !== head ||
        cleanStatus(candidate.path)
      ) {
        throw new Error(`${candidate.role} candidate changed after freeze.`);
      }
    }
  }

  createSynthesisWorktree(primary: FrozenFeatureCandidate) {
    this.assertSelectionReadOnly(
      [...this.candidateHeads].map(([role, headCommit]) => {
        if (role === primary.role) return primary;
        const candidatePath = path.join(
          this.temporaryRoot,
          `candidate-${roleSlug(role)}`,
        );
        return {
          role,
          path: candidatePath,
          branchRef: `${branchSlug(this.runId)}/candidate-${roleSlug(role)}`,
          baseCommit: this.caller.baseCommit,
          headCommit,
          changedPaths: [],
          boundedDiff: { text: "", truncated: false, bytes: 0 },
          frozen: true as const,
        };
      }),
    );
    const synthesisPath = this.selectionDirectory!;
    fs.rmdirSync(synthesisPath);
    const synthesis: FeatureSynthesisWorktree = {
      path: synthesisPath,
      branchRef: `${branchSlug(this.runId)}/synthesis`,
      primaryRole: primary.role,
      primaryCommit: primary.headCommit,
    };
    this.worktreeAdd(
      synthesis.path,
      synthesis.branchRef,
      synthesis.primaryCommit,
    );
    this.synthesis = synthesis;
    return synthesis;
  }

  commitAssignedWorktree(role: string, workingDir: string) {
    const resolved = comparablePath(workingDir);
    if (!this.ownedWorktreePaths.has(resolved)) {
      throw new Error("Feature commit path is not owned by this pipeline run.");
    }
    const candidateRole = (
      ["Minimal", "Robust", "Architectural"] as const
    ).find((item) => `candidate-${item.toLowerCase()}` === role);
    const expectedPath = candidateRole
      ? path.join(this.temporaryRoot, `candidate-${roleSlug(candidateRole)}`)
      : role === "implementation-synthesis"
        ? this.synthesis?.path
        : undefined;
    if (!expectedPath || comparablePath(expectedPath) !== resolved) {
      throw new Error(
        "Feature commit role does not own the assigned worktree.",
      );
    }
    requireGit(
      resolved,
      ["add", "-A", "--"],
      "Unable to stage feature implementation",
    );
    const commitArgs = [
      "commit",
      "-m",
      candidateRole
        ? `feature-pipeline ${candidateRole.toLowerCase()} candidate`
        : "feature-pipeline final synthesis",
    ];
    if (!candidateRole) commitArgs.push("--allow-empty");
    requireGit(
      resolved,
      commitArgs,
      "Unable to commit assigned feature worktree",
    );
    return requireGit(
      resolved,
      ["rev-parse", "HEAD"],
      "Unable to read committed feature HEAD",
    );
  }

  validateSynthesis(
    worktree: FeatureSynthesisWorktree,
    provenance: FeatureSynthesisProvenance,
    selection: FeatureSelection,
    candidates: ReadonlyArray<FrozenFeatureCandidate>,
  ) {
    if (this.synthesis?.path !== worktree.path) {
      throw new Error(
        "Synthesis worktree is not controller-owned by this run.",
      );
    }
    const finalCommit = requireGit(
      worktree.path,
      ["rev-parse", "HEAD"],
      "Unable to inspect final synthesis commit",
    );
    if (
      provenance.primaryCandidate !== worktree.primaryRole ||
      provenance.primaryCommit !== worktree.primaryCommit ||
      provenance.finalCommit !== finalCommit
    ) {
      throw new Error(
        "Synthesis provenance does not match controller Git state.",
      );
    }
    if (finalCommit === worktree.primaryCommit) {
      throw new Error(
        "Synthesis must create a distinct final commit, including for no-augmentation selection.",
      );
    }
    requireAncestor(
      worktree.path,
      worktree.primaryCommit,
      finalCommit,
      "Synthesis ancestry is invalid",
    );
    if (cleanStatus(worktree.path)) {
      throw new Error(
        "Synthesis worktree must be clean after its final commit.",
      );
    }
    const changedPaths = readChangedPaths(
      worktree.path,
      worktree.primaryCommit,
      finalCommit,
    );
    if (changedPaths.length > SYNTHESIS_CHANGED_PATH_LIMIT) {
      throw new Error(
        `Bounded augmentation changed ${changedPaths.length} paths; maximum is ${SYNTHESIS_CHANGED_PATH_LIMIT}.`,
      );
    }
    const diff = boundedDiff(
      worktree.path,
      worktree.primaryCommit,
      finalCommit,
      SYNTHESIS_DIFF_LIMIT,
    );
    if (diff.truncated) {
      throw new Error(
        `Bounded augmentation diff exceeds ${SYNTHESIS_DIFF_LIMIT} UTF-8 bytes.`,
      );
    }
    if (!equalUniquePathSets(provenance.changedPaths, changedPaths)) {
      throw new Error(
        "Synthesis changedPaths do not match its augmentation diff.",
      );
    }
    validateAugmentationAttribution(
      provenance,
      selection,
      candidates,
      changedPaths,
    );
    return { ...worktree, finalCommit, changedPaths };
  }

  promote(synthesis: ValidatedFeatureSynthesis) {
    const currentHead = requireGit(
      this.caller.workingDir,
      ["rev-parse", "HEAD"],
      "Unable to inspect caller HEAD before promotion",
    );
    const branch = requireGit(
      this.caller.workingDir,
      ["symbolic-ref", "-q", "HEAD"],
      "Caller branch detached before promotion",
    );
    if (
      currentHead !== this.caller.baseCommit ||
      branch !== this.caller.branchRef ||
      cleanStatus(this.caller.workingDir)
    ) {
      throw new Error(
        "Caller feature worktree drifted after preflight; incomplete synthesis was not promoted.",
      );
    }
    requireGit(
      this.caller.workingDir,
      ["merge", "--ff-only", "--no-edit", synthesis.finalCommit],
      "Exact synthesized commit promotion failed",
    );
    const promotedHead = requireGit(
      this.caller.workingDir,
      ["rev-parse", "HEAD"],
      "Unable to verify promoted HEAD",
    );
    const promotedTree = requireGit(
      this.caller.workingDir,
      ["rev-parse", "HEAD^{tree}"],
      "Unable to verify promoted tree",
    );
    const synthesisTree = requireGit(
      synthesis.path,
      ["rev-parse", `${synthesis.finalCommit}^{tree}`],
      "Unable to verify synthesis tree",
    );
    if (
      promotedHead !== synthesis.finalCommit ||
      promotedTree !== synthesisTree ||
      cleanStatus(this.caller.workingDir)
    ) {
      throw new Error(
        "Promoted caller state is not the exact synthesized commit/state.",
      );
    }
  }

  cleanup() {
    if (this.cleaned) return [];
    this.cleaned = true;
    return cleanupOwnedFeatureWorktreePaths(
      this.temporaryRoot,
      [...this.ownedWorktreePaths],
      (worktreePath) =>
        git(this.caller.workingDir, [
          "worktree",
          "remove",
          "--force",
          worktreePath,
        ]),
    );
  }
}

export const defaultFeatureGitOperations: FeatureGitOperations = {
  preflight: validateDedicatedFeatureWorktree,
  createLifecycle: (caller, runId) =>
    new GitFeatureWorktreeLifecycle(caller, runId),
};
