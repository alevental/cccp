---
name: spec-writing
description: Write product specs and PRDs with acceptance criteria and scope boundaries
---

# Spec Writing

Write a product specification / PRD for the requested feature or initiative.

## Instructions

1. Read all provided context — user feedback, stakeholder requests, technical constraints, existing documentation.
2. Draft the spec using the output format below. Every section is mandatory.
3. Write acceptance criteria as testable statements using "Given / When / Then" or clear boolean conditions.
4. Define scope boundaries: list 3-5 items that are explicitly **not** in scope to prevent creep.
5. Identify dependencies on other teams, systems, or decisions that must be resolved before work begins.
6. Review your draft: remove ambiguous language, ensure every user story maps to at least one acceptance criterion.

## Output Format

```
## Problem Statement
One paragraph. Who has the problem, what the problem is, why it matters now.

## User Stories
- As a [role], I want [capability] so that [outcome].

## Acceptance Criteria
- [ ] Given [precondition], when [action], then [expected result].

## Scope Boundaries
**In scope:** ...
**Out of scope:** ...

## Success Metrics
| Metric | Baseline | Target | Measurement Method |
|--------|----------|--------|--------------------|

## Dependencies
- [Dependency]: [Owner] — [Status/Risk]

## Open Questions
- [Question] — [Who can answer] — [Deadline for answer]
```

## Constraints

- Do not propose technical architecture or implementation approach.
- Every user story must have at least one matching acceptance criterion.
- Do not leave success metrics without a measurement method.
- Keep the spec under 3 pages. If it is longer, the scope is too broad — split it.
