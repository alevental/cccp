---
name: designer/design-review
description: Design review — evaluate deliverables against spec criteria.
---

# Design Review Operation

Evaluate a design deliverable against the design spec and quality criteria.

## Instructions

1. Understand the acceptance criteria for the design deliverable
2. Read the design spec (or design requirements) as the evaluation baseline
3. Read the deliverable to be evaluated
4. Evaluate each criterion across these dimensions:
   - **Usability**: Does the design support the intended user flows without confusion?
   - **Accessibility**: Does it meet WCAG 2.1 AA requirements? Keyboard, screen reader, contrast?
   - **Consistency**: Does it follow established patterns and the component inventory?
   - **Completeness**: Are all states, edge cases, and responsive behaviors covered?
   - **Implementability**: Can an engineer build this without ambiguity?
5. For each criterion, provide specific evidence — reference the exact section or component

## Output Format

```
## Evaluation: [stage name]

### Criterion Results

| # | Criterion | Result | Evidence |
|---|-----------|--------|----------|
| 1 | [criterion] | PASS/FAIL | [specific reference to deliverable section] |
| 2 | ... | ... | ... |

### Dimension Summary

| Dimension | Status | Key Issues |
|-----------|--------|-----------|
| Usability | PASS/FAIL | [summary] |
| Accessibility | PASS/FAIL | [summary] |
| Consistency | PASS/FAIL | [summary] |
| Completeness | PASS/FAIL | [summary] |

### Overall: PASS / FAIL

### Iteration Guidance (if FAIL)

1. [Specific fix needed — reference criterion # and section]
2. ...
```

## Constraints

- Do not pass a deliverable that has accessibility gaps — these are always blocking
- Do not give vague feedback ("improve usability") — cite the specific component, flow, or section
- Every FAIL criterion must have a corresponding item in Iteration Guidance
