# Coding delegation

This context defines the roles involved when a coding agent delegates implementation while retaining responsibility for the result.

## Language

**Coding parent**:
The coding role accountable for repository state, review, integration, validation, and the final response. It delegates most implementation but may take over urgent or integration-heavy work.
_Avoid_: Sub-orchestrator, dispatcher, reviewer

**Worker**:
A cheaper child coding role assigned a bounded task by a coding parent. Its output remains provisional until the coding parent reviews and accepts it.
_Avoid_: Coder, implementer, coding subagent

**Bounded task**:
A worker assignment with one concrete outcome, explicit ownership, acceptance criteria, and stop conditions. Its boundary comes from responsibility and dependencies, not line count.
_Avoid_: Small task, focused prompt

**Worker brief**:
The context prepared by the coding parent for a bounded task. It states the goal, known facts, ownership, non-goals, acceptance criteria, relevant checks, and stop conditions.
_Avoid_: Parent transcript, task prompt

**Worker slot**:
The single concurrent child capacity reserved for a worker.
_Avoid_: Coding slot, write subagent

**Research slot**:
The single concurrent child capacity reserved for either a lookup or scout role.
_Avoid_: Second worker, general child slot

**Write slot**:
The exclusive right to modify the coding parent's checkout. Either the coding parent or one worker holds it, never both and never two workers at once.
_Avoid_: File lock, worker worktree

**Clarification return**:
A worker result that requests missing information before changing code. It does not consume the worker's correction pass.
_Avoid_: Failed attempt, blocker

**Correction pass**:
The worker's single opportunity to repair an implementation rejected by the coding parent. Another rejection ends delegation for that bounded task.
_Avoid_: Retry loop, rework cycle

**Frozen task snapshot**:
An immutable task brief, repository state, tool configuration, and validation environment reused across evaluation candidates.
_Avoid_: Benchmark prompt, test task

**Accepted change**:
Worker output that the coding parent has inspected, judged correct, and incorporated into the parent task. A worker report or passing check alone does not make a change accepted.
_Avoid_: Completed work, child result
