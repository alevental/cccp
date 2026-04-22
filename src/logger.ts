// ---------------------------------------------------------------------------
// Logger abstraction — decouples pipeline output from console
// ---------------------------------------------------------------------------

import { appendFileSync, mkdirSync, statSync, renameSync } from "node:fs";
import { dirname } from "node:path";

/** Minimal logger interface used throughout the pipeline runner. */
export interface Logger {
  log(...args: unknown[]): void;
  error(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  /**
   * Tag-gated structured debug logging. Disabled by default; enable tags
   * via the `CCCP_DEBUG` env var, e.g. `CCCP_DEBUG=wasm,leak`, or `*` for all.
   * When the tag isn't enabled the call returns after a single Set lookup —
   * safe to leave in hot paths.
   */
  debug(tag: string, ...args: unknown[]): void;
}

// ---------------------------------------------------------------------------
// Debug tag parsing (module-level cache)
// ---------------------------------------------------------------------------

let _debugTags: Set<string> | null = null;
function getDebugTags(): Set<string> {
  if (_debugTags === null) {
    const raw = process.env.CCCP_DEBUG ?? "";
    _debugTags = new Set(
      raw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    );
  }
  return _debugTags;
}

/** True when `tag` or `*` is present in CCCP_DEBUG. */
export function isDebugTagEnabled(tag: string): boolean {
  const tags = getDebugTags();
  return tags.size > 0 && (tags.has("*") || tags.has(tag));
}

/** For tests: reset the cached parse of CCCP_DEBUG. */
export function resetDebugTagsForTest(): void {
  _debugTags = null;
}

// ---------------------------------------------------------------------------
// Debug log sink (lazy-opened, single-rotation)
// ---------------------------------------------------------------------------

const DEFAULT_MAX_MB = 10;
let _sinkPath: string | null = null;
let _sinkReady = false;

function maxSinkBytes(): number {
  const v = Number(process.env.CCCP_DEBUG_MAX_MB ?? DEFAULT_MAX_MB);
  return (Number.isFinite(v) && v > 0 ? v : DEFAULT_MAX_MB) * 1024 * 1024;
}

/**
 * Configure the on-disk sink for debug logs. Call once, early, with
 * `.cccp/debug.log`. When unset (the default), debug() falls back to stderr.
 */
export function setDebugLogPath(path: string | null): void {
  _sinkPath = path;
  _sinkReady = false;
}

function ensureSink(): string | null {
  if (!_sinkPath) return null;
  if (!_sinkReady) {
    try {
      mkdirSync(dirname(_sinkPath), { recursive: true });
      try {
        const s = statSync(_sinkPath);
        if (s.size > maxSinkBytes()) {
          renameSync(_sinkPath, _sinkPath + ".1");
        }
      } catch { /* first open — no prior file */ }
      _sinkReady = true;
    } catch {
      return null;
    }
  }
  return _sinkPath;
}

function emitDebug(tag: string, args: unknown[]): void {
  const line = `${new Date().toISOString()} [${tag}] ${args
    .map((a) => (typeof a === "string" ? a : safeStringify(a)))
    .join(" ")}\n`;
  const path = ensureSink();
  if (path) {
    try {
      appendFileSync(path, line);
    } catch {
      process.stderr.write(line);
    }
  } else {
    process.stderr.write(line);
  }
}

/**
 * Module-level convenience for call sites that don't carry a `Logger`
 * instance (e.g., React components, deep utility functions). Equivalent
 * to `logger.debug(tag, ...)`. Cheap when the tag is disabled (single
 * `Set.has()`); no-op on the fast path.
 */
export function debug(tag: string, ...args: unknown[]): void {
  if (!isDebugTagEnabled(tag)) return;
  emitDebug(tag, args);
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/** No-op kept for API compatibility (appendFileSync is self-contained). */
export function closeDebugSink(): void {
  _sinkReady = false;
}

// ---------------------------------------------------------------------------
// Logger implementations
// ---------------------------------------------------------------------------

/** Default logger that forwards everything to the console. */
export class ConsoleLogger implements Logger {
  log(...args: unknown[]): void { console.log(...args); }
  error(...args: unknown[]): void { console.error(...args); }
  warn(...args: unknown[]): void { console.warn(...args); }
  debug(tag: string, ...args: unknown[]): void {
    if (!isDebugTagEnabled(tag)) return;
    emitDebug(tag, args);
  }
}

/** Logger that suppresses log/warn but still emits errors (for TUI mode). */
export class QuietLogger implements Logger {
  log(): void {}
  error(...args: unknown[]): void { console.error(...args); }
  warn(): void {}
  debug(tag: string, ...args: unknown[]): void {
    if (!isDebugTagEnabled(tag)) return;
    emitDebug(tag, args);
  }
}

/** Completely silent logger — useful for tests. */
export class SilentLogger implements Logger {
  log(): void {}
  error(): void {}
  warn(): void {}
  debug(): void {}
}
