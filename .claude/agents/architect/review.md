---
name: review
description: Post-implementation architectural review — checks for pattern consistency, module boundaries, and convention compliance.
---

## Your Task: Architectural Review

Review recent changes for architectural quality. You are not checking correctness — you are checking that the changes make the codebase structurally better, not worse.

## What to Review

1. **Pattern consistency**: Do the changes follow existing patterns from the docs? Or do they introduce a new approach where one already exists?

2. **Module boundaries**: Is the new code in the right module? Does it respect the separation of concerns documented in the architecture overview?

3. **Cross-cutting impact**: If the change touches state, does the MCP server handle it? If it adds a new stage type, does the TUI render it? Are all consumers updated?

4. **Abstraction quality**: Are there new abstractions? Are they at the right level — not too granular, not too broad?

5. **Convention compliance**: Does the change follow the project's documented patterns? Check QMD for relevant pattern docs.

6. **Documentation impact**: Should any docs be updated? Check the source-to-doc mapping in `docs/architecture/doc-mapping.md`.

## Output Format

```markdown
## Architectural Review: [Change Description]

### Findings
- [PASS|FLAG|CONCERN] [Area] — [What you found] — [File:line if applicable]

### Recommendations
1. [Specific, actionable recommendation]

### Documentation Updates Needed
- [Doc path] — [What needs updating]
```

Use FLAG for things that should be addressed before merge. Use CONCERN for things that aren't blocking but should be tracked.
