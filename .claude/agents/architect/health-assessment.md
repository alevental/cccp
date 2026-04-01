---
name: health-assessment
description: Pre-implementation codebase health assessment for affected modules
---

# Health Assessment

Evaluate the current state of modules affected by an upcoming change. Identify what can be reused, what is blocking, and what gaps exist.

## Instructions

1. Read the requirements or change description provided as input.
2. Identify all modules, files, and interfaces that the change will touch or depend on.
3. For each affected module, assess:
   - **Reusable entities**: Types, utilities, patterns already in place that the change can leverage.
   - **Tech debt**: Categorize as *blocking* (must fix before proceeding) or *opportunistic* (can fix alongside the change).
   - **Missing abstractions**: Interfaces or patterns that should exist but do not.
   - **Documentation gaps**: Missing or outdated docs that will cause confusion during implementation.
4. Identify new patterns the change will introduce and whether they conflict with existing patterns.
5. Summarize findings with a clear recommendation: proceed, proceed with prerequisites, or redesign.

## Output Format

```
## Health Assessment: [Change Title]

### Affected Modules
- module-name — brief impact description

### Reusable Entities
- entity — where it lives, how it applies

### Tech Debt
#### Blocking
- issue — why it blocks, suggested resolution
#### Opportunistic
- issue — benefit of fixing now

### New Patterns
- pattern — rationale, potential conflicts

### Documentation Gaps
- gap — what is missing, who needs it

### Recommendation
[Proceed | Proceed with prerequisites | Redesign] — rationale
```

## Constraints

- Do not propose fixes for tech debt — only identify and categorize it.
- Be specific about file paths and module names, not vague references.
- If you lack sufficient context to assess a module, say so explicitly.
