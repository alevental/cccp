# ADR-004: Global state database at `~/.cccp/cccp.db`

## Status

Accepted (v0.18.0). Supersedes the per-worktree DB convention introduced in [ADR-001](001-sqlite-state.md).

## Context

Pipeline state lived in `{projectDir}/.cccp/cccp.db` — one SQLite file per project, locally isolated to whatever directory `cccp run` was invoked from. Each git worktree of the same repo got its own DB, which was nice for cleanup (delete the worktree, the state goes with it) and for isolation between concurrent runs.

A user reported the resulting failure mode when running CCCP across many parallel Claude Code sessions and worktrees. To avoid spawning N MCP servers (one per worktree), they bound a singleton CCCP MCP server through the Anthropic MCP proxy. That singleton was bootstrapped with one `process.cwd()` and could only read/write the DB at that one path. Runs in sibling worktrees were invisible: gate notifications never fired, `cccp_runs` returned only the bound worktree's runs, `cccp_gate_respond` couldn't reach pipelines waiting elsewhere.

Two ways to fix this:

1. **Discovery layer over per-worktree DBs** — keep one DB per worktree, add a global registry (e.g. `~/.cccp/active/<run_id>.json`) of active runs. The singleton MCP server reads the registry on each tool call and opens the right DB. Preserves the delete-worktree-cleans-state property at the cost of registry maintenance and N open DB handles.
2. **Centralize on one DB** — move all `runs`/`events`/`checkpoints` to `~/.cccp/cccp.db`, scope by a `project_dir` column. The singleton MCP server is naturally happy. Trades away the cleanup-on-delete property and creates write contention on a single WAL across all concurrent runs on the machine.

## Decision

Centralize state in a single global SQLite database at `~/.cccp/cccp.db`, overridable via the `CCCP_DB_PATH` environment variable.

- `openDatabase()`, `closeDatabase()`, `reopenDatabase()` take no arguments. The process-wide handle cache collapses to one slot, keyed by the resolved global path (so tests toggling `CCCP_DB_PATH` get a fresh handle).
- `runs.project_dir` becomes `NOT NULL` (was nullable but always populated in practice) with an index. Every query that today asks "what runs belong to this project" filters on it.
- `RunFilter` gains a `projectDir` field; `findRuns` and `getRunByIdPrefix` accept it for scoping.
- The MCP server stops binding to `process.cwd()` at startup. `cccp_runs` returns all runs by default and accepts optional `project`, `pipeline`, `status`, `project_dir`, and `session_only` filters. Gate notification routing continues to filter by `sessionId` — that was already the cross-cutting identity key for "which Claude session cares about this gate," and it now does that work across projects instead of within one.
- Per-worktree `.cccp/` directories are retained for artifact-tied content only (stream logs, gate-feedback markdown, heap snapshots, profiler outputs, legacy `state.json`). The runner addresses these via the absolute `runs.artifact_dir` column.
- The CLI's `-d, --project-dir` flag stops controlling DB location. On `cccp run` it's still the agent subprocess cwd, the artifact root anchor, and the `project_dir` recorded in state. On `cccp resume` and `cccp dashboard` it becomes a filter for prefix disambiguation — `cccp resume -r abc12345` works from any cwd as long as the prefix is globally unique.
- Tests isolate via `CCCP_DB_PATH` (per-suite temp path) through the new `useIsolatedDb()` helper.

No migration is performed. Pre-existing per-worktree `.cccp/cccp.db` files are orphaned; affected users start with empty state. This is acceptable for the current user base — DB content is operational state, not durable record (those live in `git`-tracked artifact files).

## Alternatives Considered

**Registry over per-worktree DBs (option 1 above).** Cleaner cleanup semantics — deleting a worktree drops its state. Rejected because (a) the registry adds a separate failure mode (stale entries when runs crash), (b) the singleton MCP server still needs to maintain N open DB handles or pay reopen cost per call, and (c) the simpler centralized model gets you the same operational outcome with less moving parts.

**Push-model with runner-side server.** Each `cccp run` exposes itself on a Unix socket and pushes state events to a singleton MCP server. Most invasive; requires a wire protocol and socket discovery. Doesn't solve a problem A/B don't already solve.

**Keep `project_dir` nullable.** Simpler migration, no breaking change to the schema. Rejected: every cross-project query has to defensively handle nulls, and the column is in practice always populated by the runner — codifying the invariant in the schema is cleaner.

## Consequences

**Positive**
- A singleton MCP server (with or without the Anthropic MCP proxy) now serves runs from every worktree on the machine.
- `cccp_runs` from one Claude session sees pipelines started by sibling sessions — useful for orchestrators and cross-worktree visibility.
- Resume and dashboard commands work from any cwd; users no longer have to be inside the originating worktree.
- Test isolation now happens via env var (`CCCP_DB_PATH`) which doubles as a power-user knob for relocating state (e.g. to a synced folder).

**Negative**
- Deleting a worktree no longer cleans its state. Orphan rows in `~/.cccp/cccp.db` accumulate, pointing at filesystem paths that no longer exist. Mitigation deferred — a future `cccp prune` command can drop runs whose `project_dir` no longer exists.
- All concurrent runs across the machine hit one WAL. WAL handles N concurrent writers fine, but contention is non-zero at very high parallelism. Acceptable for typical N ≤ 10.
- `getRunByIdPrefix` has a slightly higher collision probability across many projects. UUIDs make 8-char collision ~10⁻⁴ at thousands of runs — still rare but no longer ~zero. The CLI errors clearly when ambiguous and accepts `-p`/`-d` for disambiguation.
- This is a breaking change for users with existing per-worktree state. No migration is provided; they start fresh.
