---
name: health-assessment
description: Pre-implementation codebase health assessment — evaluates affected modules before planning changes.
---

## Your Task: Codebase Health Assessment

Assess the health of the codebase in the areas that the proposed change will touch. This assessment informs planning and prevents implementation agents from stumbling into existing patterns, debt, or undocumented conventions.

## What to Assess

1. **Existing patterns to leverage:**
   - Search QMD and read source files in the affected areas
   - List every reusable module, function, type, and pattern that already exists
   - Note their interfaces and where they're used
   - Flag any that are undocumented but should be used

2. **Technical debt in affected areas:**
   - Read the source files that will be modified
   - Identify issues to address alongside the change:
     * Duplicated logic that should be centralized
     * Inconsistent patterns between similar modules
     * Stale comments or dead code that could confuse implementation agents
     * Missing type safety or error handling
   - For each item: is it blocking (must fix first) or opportunistic (fix while we're here)?

3. **Patterns this change will need:**
   - Identify patterns that don't exist yet but will be needed
   - These become foundation tasks in the plan

4. **Documentation gaps:**
   - Check `docs/architecture/doc-mapping.md` for source-to-doc mappings
   - Flag any affected modules with missing or stale documentation
   - Flag any new patterns that should be documented

## Output Format

```markdown
## Health Assessment: [Change Name]

### Reusable Entities (do NOT recreate)
- [Name] — [what it does] — [file path]

### Debt to Fix
- [File:line] — [what's wrong] — blocking | opportunistic

### New Patterns to Establish
- [Pattern name] — [why needed] — [which tasks consume it]

### Documentation Gaps
- [Doc path] — [missing or stale]

### Forward-Looking Concerns
- [Concern] — [recommendation]
```
