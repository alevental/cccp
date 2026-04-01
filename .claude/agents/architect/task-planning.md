---
name: task-planning
description: Sprint task planning — decompose plan into file-level implementation tasks with ordering and acceptance criteria
---

# Task Planning

Decompose a plan or sprint brief into concrete, file-level implementation tasks that an implementer can pick up and execute without further clarification.

## Instructions

1. Read the master plan, sprint brief, or phase description provided as input.
2. Break each high-level task into atomic implementation tasks. Each task should touch a small, well-defined set of files.
3. For each task, specify:
   - **Description**: What to build or change, in one sentence.
   - **Files**: Which files are created or modified.
   - **Dependencies**: Which tasks must be complete first (by task ID).
   - **Acceptance criteria**: Concrete conditions that confirm the task is done (test passes, type checks, behavior observable).
4. Order tasks so that dependencies are satisfied and the build stays green after each task.
5. Group tasks into batches that can be worked on in parallel (no inter-dependencies within a batch).

## Output Format

```
## Task Plan: [Sprint/Phase Title]

### Batch 1 (parallel)
#### T1: [Short title]
- **Description:** What to do.
- **Files:** `src/foo.ts`, `tests/foo.test.ts`
- **Dependencies:** None
- **Acceptance:** `npm test` passes, new type exported

#### T2: [Short title]
- **Description:** What to do.
- **Files:** `src/bar.ts`
- **Dependencies:** None
- **Acceptance:** Type-checks clean

### Batch 2 (parallel, after Batch 1)
#### T3: [Short title]
- **Description:** What to do.
- **Files:** `src/baz.ts`, `tests/baz.test.ts`
- **Dependencies:** T1
- **Acceptance:** Integration test passes
```

## Constraints

- Every task must have at least one acceptance criterion that is mechanically verifiable (test, typecheck, lint).
- Do not create tasks that are purely "review" or "think about" — every task produces a code artifact.
- If a task is too large to describe in 2-3 sentences, split it further.
- File paths must be specific, not "relevant files" or "related modules."
