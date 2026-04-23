import { openDatabase, type CccpDatabase } from "./db.js";

// ---------------------------------------------------------------------------
// Centralized database service
//
// Thin per-projectDir handle wrapper. Before migrating to `node:sqlite` this
// class managed a reader/writer split and a periodic WASM-reclaim timer to
// bound sql.js linear memory growth. With native sqlite + WAL, cross-process
// readers see committed writes immediately without reload, and there is no
// WASM memory to reclaim — so the class collapses to a cache lookup.
//
// The class is retained as the single place to register future DB lifecycle
// concerns (connection limits, shutdown hooks, etc.).
// ---------------------------------------------------------------------------

export interface DbServiceOptions {
  projectDir: string;
}

export class DbService {
  private opts: DbServiceOptions;

  constructor(opts: DbServiceOptions) {
    this.opts = opts;
  }

  /** Start lifecycle — no-op today. Retained for API stability. */
  start(): void {}

  /** Get the cached DB handle for this project directory. */
  db(): CccpDatabase {
    return openDatabase(this.opts.projectDir);
  }

  /** Stop lifecycle — no-op today. Retained for API stability. */
  stop(): void {}
}
