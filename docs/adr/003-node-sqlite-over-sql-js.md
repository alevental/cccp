# ADR-003: node:sqlite Over sql.js

## Status

Accepted (2026-04-23). Supersedes [ADR-002](./002-sql-js-over-better-sqlite3.md).

## Context

A long-running CCCP pipeline accumulated ~6 GB of WASM linear memory over several hours, with RSS growing at ~48 MB/min. The heap-vs-RSS divergence was diagnostic: V8 heap was small (~108 MB across all heap spaces) and shrinking, while RSS grew unbounded and unrelated to `external` or `arrayBuffers` counters. The allocation lived in `WebAssembly.Memory` owned by the sql.js module.

The existing `reclaimWasmMemory()` workaround (drop the Module + singleton cache every 10 minutes so V8 can GC the backing ArrayBuffer) was ineffective in practice. `WebAssembly.Memory` sits outside V8's managed heap, so major-GC heuristics never fire based on its size — the abandoned Module is never collected, and the next DB operation allocates a fresh Module alongside the old one. RSS growth continued regardless of the reclaim interval.

Root cause is structural in sql.js's design:
- The DB is fully in-memory inside WASM linear memory, which only grows
- Every `saveState` / `saveStateWithEvent` calls `db.export()` — copies the full DB through the WASM heap
- Every `reload()` builds a new `Database` inside the Module without freeing the prior one
- Cross-process reads require manually re-reading the file from disk

ADR-002 accepted sql.js because `better-sqlite3` had painful ABI rebuilds across Node versions (we hit `SQLITE_IOERR_SHORT_READ` errors during the QMD upgrade). CCCP is a globally installed CLI — `npm install -g` failures are worse than memory growth in a long-running pipeline.

That constraint no longer binds: **Node 24 LTS ships `node:sqlite` as a built-in module, unflagged since Node 22.13.0 / 23.4.0**. No native addon, no ABI rebuild, no extra dependency — the runtime itself now ships SQLite.

## Decision

Migrate `src/db.ts` from `sql.js` to `node:sqlite` (`DatabaseSync`). Require Node `>= 24.0.0` in `package.json#engines`. Enable WAL mode + `busy_timeout=5000` on open.

Delete the workaround infrastructure that existed only because sql.js was in-memory:
- `flush()` / `reload()` / `openReadOnly()` / `reclaimWasmMemory()` / `getDbDiagnostics()` on `CccpDatabase`
- The reclaim timer in `runPipeline()` (`src/runner.ts`) and the `CCCP_WASM_RECLAIM_MS` env var
- The reader/writer split in `DbService`; the class collapses to a handle cache
- The poll-count reclaim in `FilesystemGateStrategy` (`src/gate/gate-watcher.ts`)
- The `sqlJsCachedInstances` / `sqlJsInitialized` fields in the memory diagnostics log

Keep intact: the 15-minute TUI remount cycle (that's for yoga-layout, not sql.js).

## Alternatives Considered

**Keep sql.js, add `--expose-gc` + explicit `global.gc()` after reclaim.** Would likely fix the specific symptom (forced V8 major GC can collect the abandoned Module). Rejected because it addresses the symptom, not the cause: every write still pays `db.export()` overhead, cross-process reads still need explicit `reload()`, and the workaround infrastructure stays in place.

**Migrate to `better-sqlite3`.** Faster than `node:sqlite` on microbenchmarks, more mature. Rejected because it reintroduces the exact ABI problem ADR-002 documented — `better-sqlite3` is a native addon and still requires prebuilt binaries or build-from-source on install. `node:sqlite` eliminates the install surface entirely.

## Consequences

**Gained:**
- Memory growth bounded by SQLite's page cache (default ~2 MB, configurable)
- Writes persist immediately — no `flush()` call needed, no export/import cycle
- Cross-process reads work via WAL mode without manual `reload()`
- ~100 LOC of workaround infrastructure deleted (reclaim timer, `DbService` reader/writer split, flush plumbing, reclaim diagnostics)
- Package no longer ships a ~1.5 MB WASM binary

**Lost / traded:**
- Minimum Node version raised from `>=20` to `>=24`. Users on older Node will hit a clear `engines` check on install; document this in release notes.
- `node:sqlite` is marked "experimental" in Node 24's docs (release candidate in Node 25+). Functionally stable and unflagged since v22.13.0 for our CRUD workload, but Node emits a one-time `ExperimentalWarning` on first import.
- WAL mode creates `.db-wal` and `.db-shm` sidecar files next to `cccp.db`. Users who back up or rsync `.cccp/` need all three files to keep the DB consistent. `.cccp/` is already gitignored so this is invisible to version control.
- On OS-level crash (not process crash), WAL + `synchronous=NORMAL` can lose the last few committed transactions. Acceptable — the runner re-reads state on resume anyway.

## Verification

- 376/376 tests pass after migration (329 prior + new concurrent-handles coverage)
- Added test `tests/db.test.ts > CccpDatabase — persistence > concurrent handles on the same file see each other's writes` directly validates the WAL cross-process invariant that replaces the `reload()` pattern
- Primary success signal: re-run the pipeline that produced the 7.2 GB RSS and confirm RSS plateau in the low hundreds of MB
