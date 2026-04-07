import { openDatabase, reclaimWasmMemory, type CccpDatabase } from "./db.js";

// ---------------------------------------------------------------------------
// Centralized database service
//
// Wraps the singleton DB cache with two access modes:
//   - "writer" — same-process, no reload (runner, state.ts)
//   - "reader" — cross-process, reload-before-read + periodic WASM reclaim
//
// WASM linear memory (sql.js) can grow but never shrink. Reader-mode
// consumers that call reload() in a loop (dashboard, gate notifier, MCP
// server) previously managed their own poll-count-based reclaim — or
// didn't manage it at all (gate-notifier). This service centralises that
// into a single timer.
// ---------------------------------------------------------------------------

export interface DbServiceOptions {
  projectDir: string;
  /** "writer" = same-process, no reload. "reader" = cross-process, reload before read. */
  mode: "writer" | "reader";
  /** WASM reclaim interval in ms (reader mode only). Default: 15 min. */
  reclaimIntervalMs?: number;
}

const DEFAULT_RECLAIM_MS = 15 * 60 * 1000; // 15 minutes

export class DbService {
  private reclaimTimer: ReturnType<typeof setInterval> | null = null;
  private opts: DbServiceOptions;

  constructor(opts: DbServiceOptions) {
    this.opts = opts;
  }

  /** Start periodic WASM reclaim (reader mode only). Call once. */
  start(): void {
    if (this.opts.mode !== "reader" || this.reclaimTimer) return;
    const ms = this.opts.reclaimIntervalMs ?? DEFAULT_RECLAIM_MS;
    this.reclaimTimer = setInterval(() => reclaimWasmMemory(), ms);
    this.reclaimTimer.unref(); // don't keep the process alive
  }

  /** Get DB handle. Reader mode reloads from disk first. */
  async db(): Promise<CccpDatabase> {
    const db = await openDatabase(this.opts.projectDir);
    if (this.opts.mode === "reader") db.reload();
    return db;
  }

  /** Stop timer and reclaim WASM memory. Safe to call multiple times. */
  stop(): void {
    if (this.reclaimTimer) {
      clearInterval(this.reclaimTimer);
      this.reclaimTimer = null;
    }
    reclaimWasmMemory();
  }
}
