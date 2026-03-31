# Documentation Mapping

Canonical reference for CCCP's documentation structure. All documentation skills and agent orientation should reference this file.

## Key Entry Points

| Need | Doc |
|------|-----|
| System architecture | `docs/architecture/overview.md` |
| How PGE works | `docs/architecture/pge-engine.md` |
| How agents are found and dispatched | `docs/architecture/agent-resolution.md` |
| State persistence and resume | `docs/architecture/state-and-resume.md` |
| Gate system and human interaction | `docs/architecture/gate-system.md` |
| Stream parsing and TUI activity | `docs/architecture/streaming.md` |
| TUI dashboard layout | `docs/architecture/tui-dashboard.md` |
| CLI command reference | `docs/api/cli-commands.md` |
| MCP server tools | `docs/api/mcp-tools.md` |
| Configuration (cccp.yaml, MCP profiles) | `docs/api/configuration.md` |
| Writing pipeline YAML | `docs/guides/pipeline-authoring.md` |
| Writing agent definitions | `docs/guides/agent-authoring.md` |
| Setting up a project | `docs/guides/project-setup.md` |

## QMD Collections

| Collection | Directory | Priority | Content |
|------------|-----------|----------|---------|
| `architecture` | `docs/architecture/` | Foundational | System internals — how CCCP works |
| `api` | `docs/api/` | Foundational | External interfaces — CLI, MCP tools, config |
| `guides` | `docs/guides/` | Reference | User-facing how-tos — pipeline and agent authoring |
| `patterns` | `docs/patterns/` | Reference | Reusable recipes — PGE patterns, agent patterns |
| `decisions` | `docs/adr/` | Supplementary | Architecture decision records |
| `onboarding` | `.` (root *.md) | Supplementary | CLAUDE.md, README.md |

## Source-to-Doc Mapping

| Source | Doc |
|--------|-----|
| `src/runner.ts` | `docs/architecture/overview.md` |
| `src/pipeline.ts`, `src/types.ts` | `docs/architecture/pipeline-schema.md` |
| `src/pge.ts`, `src/evaluator.ts` | `docs/architecture/pge-engine.md` |
| `src/agent.ts`, `src/agent-resolver.ts`, `src/prompt.ts` | `docs/architecture/agent-resolution.md` |
| `src/state.ts`, `src/db.ts` | `docs/architecture/state-and-resume.md` |
| `src/gate/*.ts`, `src/mcp/gate-notifier.ts` | `docs/architecture/gate-system.md` |
| `src/stream/stream.ts`, `src/stream/stream-tail.ts`, `src/activity-bus.ts` | `docs/architecture/streaming.md` |
| `src/tui/components.tsx`, `src/tui/dashboard.tsx` | `docs/architecture/tui-dashboard.md` |
| `src/tui/cmux.ts` | `docs/architecture/tui-dashboard.md` |
| `src/cli.ts`, `src/context.ts` | `docs/api/cli-commands.md` |
| `src/mcp/mcp-server.ts` | `docs/api/mcp-tools.md` |
| `src/config.ts`, `src/mcp/mcp-config.ts` | `docs/api/configuration.md` |
| `src/dispatcher.ts` | `docs/architecture/overview.md` |
| `src/logger.ts` | `docs/architecture/overview.md` |
| Pipeline YAML format | `docs/guides/pipeline-authoring.md` |
| Agent markdown format | `docs/guides/agent-authoring.md` |
| `cccp.yaml` | `docs/guides/project-setup.md` |

## When to Create/Update Documentation

| Trigger | Action |
|---------|--------|
| New source module | Add mapping entry here, create doc in appropriate category |
| Architecture decision | Create ADR in `docs/adr/` using template |
| CLI command added/changed | Update `docs/api/cli-commands.md` |
| MCP tool added/changed | Update `docs/api/mcp-tools.md` |
| Config schema changed | Update `docs/api/configuration.md` |
| Pipeline YAML format changed | Update `docs/guides/pipeline-authoring.md` |
| New reusable pattern | Create doc in `docs/patterns/` |
| After QMD collection changes | Run `scripts/qmd-setup.sh` |

## Doc Quality Bar

Every doc must have:
- Source file references with paths (e.g., `src/pge.ts`)
- Actual code or config snippets from the codebase
- Cross-links to related docs
- Types and schemas shown for data structures

Guides and patterns must also have:
- "When to use" and "When NOT to use" sections
- Working examples
