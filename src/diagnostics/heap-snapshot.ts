// ---------------------------------------------------------------------------
// Heap snapshot capture.
//
// Three triggers (all opt-in — zero overhead when no env var is set):
//   - SIGUSR2: on-demand snapshot via `kill -USR2 <pid>`
//   - Threshold auto-capture: CCCP_HEAP_SNAPSHOT_ON_RSS_MB, _ON_HEAP_MB
//   - Periodic: CCCP_HEAP_SNAPSHOT_EVERY_MIN (for longitudinal diffs)
//   - Crash: CCCP_HEAP_SNAPSHOT_ON_CRASH=1 (uncaughtException/unhandledRejection)
//
// Snapshots are written via `v8.writeHeapSnapshot()` — Node core, no deps.
// Output files are Chrome DevTools "Memory" panel compatible.
// ---------------------------------------------------------------------------

import { writeHeapSnapshot } from "node:v8";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

// ---------------------------------------------------------------------------
// Config parsing
// ---------------------------------------------------------------------------

export interface HeapSnapshotConfig {
  onSigUsr2: boolean;      // always true when anything else is enabled
  rssMb: number | null;    // auto-snapshot when RSS crosses this
  heapMb: number | null;   // auto-snapshot when heapUsed crosses this
  everyMin: number | null; // periodic snapshots
  onCrash: boolean;
}

export function readHeapSnapshotConfig(): HeapSnapshotConfig {
  const rssMb = readMb(process.env.CCCP_HEAP_SNAPSHOT_ON_RSS_MB);
  const heapMb = readMb(process.env.CCCP_HEAP_SNAPSHOT_ON_HEAP_MB);
  const everyMin = readNum(process.env.CCCP_HEAP_SNAPSHOT_EVERY_MIN);
  const onCrash = truthy(process.env.CCCP_HEAP_SNAPSHOT_ON_CRASH);
  const anyEnabled = rssMb !== null || heapMb !== null || everyMin !== null || onCrash;
  return { onSigUsr2: anyEnabled, rssMb, heapMb, everyMin, onCrash };
}

function readMb(v: string | undefined): number | null {
  if (!v) return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}
function readNum(v: string | undefined): number | null {
  if (!v) return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}
function truthy(v: string | undefined): boolean {
  if (!v) return false;
  const l = v.toLowerCase();
  return !(l === "0" || l === "false" || l === "off" || l === "no");
}

// ---------------------------------------------------------------------------
// Snapshot writing
// ---------------------------------------------------------------------------

const MB = 1024 * 1024;

function tsStamp(): string {
  // Filesystem-safe ISO timestamp: "2026-04-22T10-15-42"
  return new Date().toISOString().replace(/[:.]/g, "-").split(".")[0];
}

/** Write a heap snapshot to .cccp/heap-<runId>-<ts>-<reason>.heapsnapshot. */
export function writeSnapshot(artifactDir: string, runId: string, reason: string): string {
  const dir = resolve(artifactDir, ".cccp");
  mkdirSync(dir, { recursive: true });
  const filename = resolve(
    dir,
    `heap-${runId.slice(0, 8)}-${tsStamp()}-${reason}.heapsnapshot`,
  );
  writeHeapSnapshot(filename);
  // Best effort — caller logs the path.
  return filename;
}

// ---------------------------------------------------------------------------
// Handler installation
// ---------------------------------------------------------------------------

interface Installation {
  sigusr2?: NodeJS.SignalsListener;
  uncaught?: NodeJS.UncaughtExceptionListener;
  rejection?: NodeJS.UnhandledRejectionListener;
  periodic?: ReturnType<typeof setInterval>;
}

/**
 * Install SIGUSR2 + crash + periodic snapshot hooks for the given run.
 * Returns a cleanup function that removes every listener and clears timers.
 * When no config is active, returns a no-op cleanup.
 */
export function installHeapSnapshotHandlers(ctx: {
  artifactDir: string;
  runId: string;
  log?: (msg: string) => void;
}): () => void {
  const cfg = readHeapSnapshotConfig();
  if (!cfg.onSigUsr2) return () => {};

  const install: Installation = {};
  const log = ctx.log ?? ((m: string) => process.stderr.write(m + "\n"));

  install.sigusr2 = () => {
    try {
      const file = writeSnapshot(ctx.artifactDir, ctx.runId, "sigusr2");
      log(`[cccp] heap snapshot written: ${file}`);
    } catch (err) {
      log(`[cccp] heap snapshot (sigusr2) failed: ${(err as Error).message}`);
    }
  };
  process.on("SIGUSR2", install.sigusr2);

  if (cfg.onCrash) {
    install.uncaught = (err: Error) => {
      try {
        const file = writeSnapshot(ctx.artifactDir, ctx.runId, "uncaught");
        log(`[cccp] heap snapshot on uncaughtException: ${file}`);
      } catch { /* best effort */ }
      // Re-throw: let Node's default handler print + exit 1. We don't call
      // process.exit directly — that would skip other listeners and crash
      // reporting.
      throw err;
    };
    install.rejection = (reason: unknown) => {
      try {
        const file = writeSnapshot(ctx.artifactDir, ctx.runId, "unhandled");
        log(`[cccp] heap snapshot on unhandledRejection: ${file}`);
      } catch { /* best effort */ }
      // Let Node's default handler continue.
      void reason;
    };
    process.on("uncaughtException", install.uncaught);
    process.on("unhandledRejection", install.rejection);
  }

  if (cfg.everyMin !== null) {
    install.periodic = setInterval(() => {
      try {
        const file = writeSnapshot(ctx.artifactDir, ctx.runId, "periodic");
        log(`[cccp] heap snapshot (periodic): ${file}`);
      } catch (err) {
        log(`[cccp] heap snapshot (periodic) failed: ${(err as Error).message}`);
      }
    }, cfg.everyMin * 60_000);
    install.periodic.unref();
  }

  return () => {
    if (install.sigusr2) process.off("SIGUSR2", install.sigusr2);
    if (install.uncaught) process.off("uncaughtException", install.uncaught);
    if (install.rejection) process.off("unhandledRejection", install.rejection);
    if (install.periodic) clearInterval(install.periodic);
  };
}

// ---------------------------------------------------------------------------
// Threshold checking (called from the sample-tick path)
// ---------------------------------------------------------------------------

const MIN_GAP_BETWEEN_AUTO_SNAPSHOTS_MS = 5 * 60_000; // 5 min

export class ThresholdSnapshotter {
  private lastAt = 0;
  private readonly cfg: HeapSnapshotConfig;

  constructor(
    private readonly artifactDir: string,
    private readonly runId: string,
    private readonly log: (msg: string) => void = (m) => process.stderr.write(m + "\n"),
  ) {
    this.cfg = readHeapSnapshotConfig();
  }

  /** Call every sample tick. Triggers a snapshot if a threshold is crossed. */
  maybeSnapshot(rssBytes: number, heapBytes: number): void {
    if (this.cfg.rssMb === null && this.cfg.heapMb === null) return;
    const now = Date.now();
    if (now - this.lastAt < MIN_GAP_BETWEEN_AUTO_SNAPSHOTS_MS) return;

    let reason: string | null = null;
    if (this.cfg.rssMb !== null && rssBytes / MB > this.cfg.rssMb) reason = "rss";
    else if (this.cfg.heapMb !== null && heapBytes / MB > this.cfg.heapMb) reason = "heap";

    if (!reason) return;
    this.lastAt = now;
    try {
      const file = writeSnapshot(this.artifactDir, this.runId, `thresh-${reason}`);
      this.log(`[cccp] heap snapshot (${reason} threshold): ${file}`);
    } catch (err) {
      this.log(`[cccp] heap snapshot (threshold) failed: ${(err as Error).message}`);
    }
  }
}
