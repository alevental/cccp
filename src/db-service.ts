import { openDatabase, type CccpDatabase } from "./db.js";

// ---------------------------------------------------------------------------
// Centralized database service
//
// Thin wrapper around the global DB handle. Before centralizing state to
// ~/.cccp/cccp.db this class held a per-projectDir handle cache; with one
// global DB it collapses to a passthrough. Retained as the single place to
// register future DB lifecycle concerns (connection limits, shutdown hooks).
// ---------------------------------------------------------------------------

export class DbService {
  /** Start lifecycle — no-op today. Retained for API stability. */
  start(): void {}

  /** Get the global DB handle. */
  db(): CccpDatabase {
    return openDatabase();
  }

  /** Stop lifecycle — no-op today. Retained for API stability. */
  stop(): void {}
}
