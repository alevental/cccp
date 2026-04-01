---
name: sprint-brief
description: Sprint context setup — determine sprint scope from master plan, produce brief with goals and context
---

# Sprint Brief

Read the master plan and current project state, then produce a sprint brief that gives the implementer everything they need to execute the sprint without re-reading the full plan.

## Instructions

1. Read the master plan and identify which phase(s) or tasks belong to this sprint.
2. Review current project state: what was completed in prior sprints, what changed, any carry-over items.
3. Produce the sprint brief with:
   - **Sprint goal**: One sentence describing what is different about the system after this sprint.
   - **Scope**: Which phases, tasks, or plan items are included.
   - **Context the implementer needs**: Key design decisions, relevant interfaces, patterns to follow, gotchas from prior sprints.
   - **Out of scope**: What is explicitly NOT in this sprint to prevent scope creep.
   - **Dependencies**: External inputs or decisions needed before or during the sprint.
   - **Definition of done**: How to verify the sprint is complete.

## Output Format

```
## Sprint Brief: [Sprint Name/Number]

### Goal
One sentence: what capability exists after this sprint.

### Scope
- [ ] Task or phase item
- [ ] Task or phase item

### Context
- Key design decisions relevant to this sprint
- Interfaces to conform to
- Patterns to follow
- Lessons or issues from prior sprints

### Out of Scope
- Item — why it is deferred

### Dependencies
- Dependency — status (resolved / pending / blocked)

### Definition of Done
- Verification criteria (tests pass, typecheck clean, behavior X observable)
```

## Constraints

- The brief must be self-contained. An implementer should not need to read the master plan to understand what to do.
- Do not include tasks from other sprints. Be precise about boundaries.
- If prior sprint work is incomplete or was modified, note the delta explicitly.
