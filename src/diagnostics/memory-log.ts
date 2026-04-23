// ---------------------------------------------------------------------------
// Persistent memory-sample JSONL logger.
//
// Every sample tick writes one line to `{artifactDir}/.cccp/memory.jsonl`
// with process.memoryUsage(), heap-space breakdowns, growth rates, and
// runtime counters from the registry. Crucially uses fs.appendFileSync so
// samples land on disk before the process OOMs — the ring buffer in the
// TUI is lost on crash, but the JSONL isn't.
//
// Default ON. Set CCCP_MEM_LOG=0 to disable (short-circuits before any
// syscall — zero overhead).
// ---------------------------------------------------------------------------

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  renameSync,
  statSync,
} from "node:fs";
import { resolve, dirname } from "node:path";
import { getHeapSpaceStatistics } from "node:v8";
import { activityBus } from "../activity-bus.js";
import { snapshotRegistry, registerActivityBus } from "./runtime-registry.js";

// Register the activityBus once at module load so the registry can read
// listenerCount without importing it (avoids a cycle).
registerActivityBus(activityBus);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RuntimeCounters {
  activityMapSize: number;
  dispatchStartTimesSize: number;
  activityBusListeners: number;
  streamTailerCount: number;
  eventCountTotal: number;
  accumulatorEntryCounts: Record<string, number>;
  stateJsonBytes: number;
}

export interface MemorySampleExt {
  ts: number;
  runId: string;
  pid: number;
  rss: number;
  heapUsed: number;
  heapTotal: number;
  external: number;
  arrayBuffers: number;
  heapSpaces: Record<string, { used: number; committed: number }>;
  counters: RuntimeCounters;
  rates: {
    rssPerMin: number | null;
    heapPerMin: number | null;
    abPerMin: number | null;
  };
}

// ---------------------------------------------------------------------------
// Memory sample ring for growth-rate calculations (duplicated minimal API
// from tui/memory-view.tsx so headless/non-TUI runs don't pull in Ink).
// ---------------------------------------------------------------------------

const WINDOW_MS = 60_000;

interface MinimalSample {
  ts: number;
  rss: number;
  heapUsed: number;
  arrayBuffers: number;
}

class GrowthRateTracker {
  private samples: MinimalSample[] = [];
  private readonly cap = 240; // ~20min at 5s sampling

  push(s: MinimalSample): void {
    this.samples.push(s);
    if (this.samples.length > this.cap) this.samples.shift();
  }

  rate(field: "rss" | "heapUsed" | "arrayBuffers"): number | null {
    const latest = this.samples[this.samples.length - 1];
    if (!latest) return null;
    const cutoff = latest.ts - WINDOW_MS;
    let firstIdx = -1;
    for (let i = 0; i < this.samples.length; i++) {
      if (this.samples[i].ts >= cutoff) { firstIdx = i; break; }
    }
    if (firstIdx < 0 || firstIdx >= this.samples.length - 1) return null;
    const first = this.samples[firstIdx];
    const dt = latest.ts - first.ts;
    if (dt <= 0) return null;
    return ((latest[field] - first[field]) * 60_000) / dt;
  }
}

// ---------------------------------------------------------------------------
// MemoryLogger
// ---------------------------------------------------------------------------

const MAX_LOG_BYTES = 50 * 1024 * 1024; // 50 MB; rotate once

export class MemoryLogger {
  private readonly tracker = new GrowthRateTracker();
  private readonly stateJsonPath: string;
  private stateJsonBytesCache = 0;
  private stateJsonBytesAt = 0;
  private enabled: boolean;

  constructor(
    private readonly logPath: string,
    private readonly runId: string,
    stateJsonPath: string,
    enabled: boolean,
  ) {
    this.stateJsonPath = stateJsonPath;
    this.enabled = enabled;
    if (this.enabled) {
      try {
        mkdirSync(dirname(this.logPath), { recursive: true });
        this.rotateIfTooLarge();
      } catch {
        // If we can't create the dir, disable silently — diagnostics must never break the run.
        this.enabled = false;
      }
    }
  }

  private rotateIfTooLarge(): void {
    try {
      const s = statSync(this.logPath);
      if (s.size > MAX_LOG_BYTES) {
        renameSync(this.logPath, this.logPath + ".prev");
      }
    } catch {
      // File doesn't exist yet — fine.
    }
  }

  private stateJsonBytes(): number {
    const now = Date.now();
    // Cache for 5s — stat() is cheap but there is no reason to hit it every tick.
    if (now - this.stateJsonBytesAt < 5000) return this.stateJsonBytesCache;
    this.stateJsonBytesAt = now;
    try {
      this.stateJsonBytesCache = statSync(this.stateJsonPath).size;
    } catch {
      this.stateJsonBytesCache = 0;
    }
    return this.stateJsonBytesCache;
  }

  /** Compose a full sample and append to the JSONL. Fast-path out when disabled. */
  record(eventCountTotal: number = 0): void {
    if (!this.enabled) return;

    const mu = process.memoryUsage();
    const ts = Date.now();

    this.tracker.push({
      ts,
      rss: mu.rss,
      heapUsed: mu.heapUsed,
      arrayBuffers: mu.arrayBuffers,
    });

    const heapSpaces: Record<string, { used: number; committed: number }> = {};
    for (const s of getHeapSpaceStatistics()) {
      heapSpaces[s.space_name] = {
        used: s.space_used_size,
        committed: s.space_size,
      };
    }

    const reg = snapshotRegistry();

    const sample: MemorySampleExt = {
      ts,
      runId: this.runId,
      pid: process.pid,
      rss: mu.rss,
      heapUsed: mu.heapUsed,
      heapTotal: mu.heapTotal,
      external: mu.external,
      arrayBuffers: mu.arrayBuffers,
      heapSpaces,
      counters: {
        activityMapSize: reg.activityMapSize,
        dispatchStartTimesSize: reg.dispatchMapSize,
        activityBusListeners: reg.activityBusListeners,
        streamTailerCount: reg.streamTailerCount,
        eventCountTotal,
        accumulatorEntryCounts: reg.accumulatorEntryCounts,
        stateJsonBytes: this.stateJsonBytes(),
      },
      rates: {
        rssPerMin: this.tracker.rate("rss"),
        heapPerMin: this.tracker.rate("heapUsed"),
        abPerMin: this.tracker.rate("arrayBuffers"),
      },
    };

    try {
      // Synchronous append — survives process crash. The write is small (~1KB).
      appendFileSync(this.logPath, JSON.stringify(sample) + "\n");
    } catch {
      // Disk full / permission error — silently skip this sample.
    }
  }

  close(): void {
    // Nothing to close — appendFileSync opens/closes per call. The no-op
    // method is here so the lifecycle shape matches future async loggers.
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Parse CCCP_MEM_LOG: default enabled, any value "0"/"false"/"off" disables. */
export function isMemoryLogEnabled(): boolean {
  const v = process.env.CCCP_MEM_LOG;
  if (v === undefined || v === "") return true;
  const lower = v.toLowerCase();
  return !(lower === "0" || lower === "false" || lower === "off" || lower === "no");
}

/** Resolve .cccp/memory.jsonl path from an artifact dir. */
export function memoryLogPath(artifactDir: string): string {
  return resolve(artifactDir, ".cccp", "memory.jsonl");
}

/** Resolve .cccp/state.json path. Mirrors state.ts/statePath without importing it
 *  (the diagnostics module should be self-contained to minimize coupling). */
export function stateJsonPath(artifactDir: string): string {
  return resolve(artifactDir, ".cccp", "state.json");
}
