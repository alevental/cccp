---
name: sprint-review
description: Sprint deliverable review — assess output for architectural consistency and completeness
---

# Sprint Review

Assess sprint deliverables for architectural consistency, pattern adherence, module boundary integrity, and completeness against the sprint brief.

## Instructions

1. Read the sprint brief to understand what was expected.
2. Review all code changes produced during the sprint.
3. Evaluate each deliverable against these criteria:
   - **Architectural consistency**: Do new components follow established patterns? Are module boundaries respected?
   - **Contract adherence**: Do implementations match the specified interfaces and types?
   - **Pattern compliance**: Are project conventions followed (error handling, logging, naming, file structure)?
   - **Boundary integrity**: Does any module reach into another module's internals? Are dependencies flowing in the correct direction?
   - **Completeness**: Is every item in the sprint brief addressed? Are tests present for new behavior?
4. For each issue found, categorize severity:
   - **Blocking**: Must fix before merge. Architectural violation, broken contract, missing critical behavior.
   - **Should fix**: Should fix in this sprint. Pattern deviation, weak test coverage, unclear naming.
   - **Note**: Non-urgent observation for future sprints.

## Output Format

```
## Sprint Review: [Sprint Name/Number]

### Summary
[1-2 sentences: overall assessment]

### Findings

#### Blocking
- [File/module] — Issue description — Suggested resolution

#### Should Fix
- [File/module] — Issue description — Suggested resolution

#### Notes
- Observation for future consideration

### Completeness Check
- [ ] Sprint brief item 1 — Done / Partial / Missing
- [ ] Sprint brief item 2 — Done / Partial / Missing

### Verdict
[Approved | Approved with required fixes | Requires rework] — rationale
```

## Constraints

- Review architecture, not style. Indentation and variable naming are not your concern unless they violate project conventions.
- Every blocking finding must include a concrete resolution, not just "fix this."
- If you lack context to evaluate a specific area, say so rather than guessing.
