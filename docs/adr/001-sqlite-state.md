# ADR-001: SQLite for Pipeline State

## Status

Accepted

## Context

Pipeline state was stored as individual `state.json` files under each run's artifact directory (`docs/projects/{project}/{pipeline}/.cccp/state.json`). This caused three problems:

1. The MCP server had to recursively scan the filesystem to discover runs
2. Every state write overwrote the entire file — no audit trail
3. The dashboard watched state.json via `fs.watch()` which was fragile cross-process

## Decision

Migrate to a single SQLite database at `{projectDir}/.cccp/cccp.db` using sql.js (WASM). Three tables: `runs` (materialized current state), `events` (append-only audit log), `checkpoints` (cached stage outputs for resume).

See `docs/architecture/state-and-resume.md` for implementation details.

## Alternatives Considered

**Keep JSON files** — Simple but doesn't scale. Filesystem scanning is O(n) per MCP tool call. No history.

**PostgreSQL/Redis** — Overkill for a local CLI tool. Adds infrastructure dependency.

**better-sqlite3 (native)** — Faster but requires native compilation. We hit ABI mismatch issues across Node versions during QMD setup. sql.js (WASM) works everywhere.

## Consequences

- Single DB file per project instead of scattered state.json files
- Run discovery is a SQL query instead of filesystem scan
- Full audit trail via events table
- Dashboard polls DB instead of watching a file
- sql.js is ~1.5MB WASM binary (no runtime cost beyond initial load)
- DB is in-memory per-process — cross-process reads require `reload()` from disk
