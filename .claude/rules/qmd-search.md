# QMD Search Policy

## Hard Rule

**Before reaching for Grep, Glob, or any Bash search command, always search documentation first using the `/qmd` skill.** Documentation is the first stop — not source code. The docs contain architecture decisions, conventions, API contracts, data models, and patterns that you will not discover from reading source code alone.

## The Order

1. **Search docs first** — invoke the `/qmd` skill to find answers in project documentation. This applies regardless of whether you think the answer is in docs or code.
2. **Then search source code if needed** — only after consulting docs, if you need additional implementation detail, context, or confirmation, use Grep/Glob on source code (`src/`, `tests/`, etc.).

## Why This Matters

- Documentation captures the *why* and the *intent* — source code only shows the *what*
- QMD provides keyword + semantic search with relevance scoring and collection scoping — it finds things you wouldn't know to grep for
- Skipping docs leads to avoidable mistakes: violating conventions, duplicating patterns, missing existing solutions

## Grep/Glob on `docs/`

Not everything in `docs/` is indexed in QMD yet. If QMD doesn't return what you need, falling back to Grep/Glob on `docs/` is acceptable. But QMD should always be tried first.

## Enforcement

This applies to the main agent and all subagents. If you catch yourself grepping source code without having searched docs first, stop and invoke `/qmd`.
