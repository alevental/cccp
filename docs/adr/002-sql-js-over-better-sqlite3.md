# ADR-002: sql.js (WASM) Over better-sqlite3 (Native)

## Status

Accepted

## Context

CCCP needs SQLite for state persistence (see ADR-001). Two Node.js SQLite libraries are viable: `better-sqlite3` (native C addon, synchronous API) and `sql.js` (SQLite compiled to WASM, no native deps).

During the QMD upgrade from 1.0.7 to 2.0.1, we spent significant time debugging `better-sqlite3` ABI mismatches across Node versions (nvm v20 vs homebrew v25). The native addon had to be rebuilt each time the Node version changed. `SQLITE_IOERR_SHORT_READ` errors surfaced when the wrong binary was loaded.

## Decision

Use `sql.js` (WASM). Zero native compilation, works on any Node version without rebuilding.

## Alternatives Considered

**better-sqlite3** — Faster (native), synchronous API, 47M downloads/month. Industry standard. But the ABI issues we experienced firsthand make it a maintenance liability for a CLI tool that users install globally across different Node environments.

**Drizzle ORM + sql.js** — Type-safe ORM layer. More abstraction but adds dependency and complexity for a simple 3-table schema.

## Consequences

- No compilation issues across Node versions — `npm install` always works
- ~3x slower than better-sqlite3 for queries (still sub-millisecond for our workload)
- ~1.5MB WASM binary added to package size
- Database is fully in-memory — persistence requires explicit `flush()` (atomic write to disk)
- No WAL mode — cross-process access requires re-reading the file from disk
