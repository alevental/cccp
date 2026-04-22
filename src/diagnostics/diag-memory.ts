// ---------------------------------------------------------------------------
// `cccp diag memory` — post-mortem analysis of .cccp/memory.jsonl
//
// Reads the JSONL sample log, optionally filters by time window, and
// prints:
//   - ASCII sparkline for the requested field
//   - Top-N counters by growth rate (from first -> last sample)
//
// Designed to answer the "which counter leaked?" question without having
// to open Chrome DevTools on a heap snapshot.
// ---------------------------------------------------------------------------

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { MemorySampleExt } from "./memory-log.js";

// ---------------------------------------------------------------------------
// Duration parsing — "10m", "2h", "1d", plain number = seconds
// ---------------------------------------------------------------------------

export function parseDuration(s: string): number | null {
  if (!s) return null;
  const m = /^(\d+(?:\.\d+)?)\s*([smhd])?$/.exec(s.trim());
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2] ?? "s";
  const mult = unit === "s" ? 1000 : unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : 86_400_000;
  return n * mult;
}

// ---------------------------------------------------------------------------
// Sample loading
// ---------------------------------------------------------------------------

export function loadSamples(jsonlPath: string): MemorySampleExt[] {
  let raw: string;
  try {
    raw = readFileSync(jsonlPath, "utf-8");
  } catch (err) {
    throw new Error(`Could not read ${jsonlPath}: ${(err as Error).message}`);
  }
  const samples: MemorySampleExt[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      samples.push(JSON.parse(trimmed) as MemorySampleExt);
    } catch {
      // Skip malformed lines — partial writes are possible if the process crashed mid-line.
    }
  }
  return samples;
}

export function filterSamples(
  samples: MemorySampleExt[],
  opts: { runId?: string; sinceMs?: number },
): MemorySampleExt[] {
  let out = samples;
  if (opts.runId) {
    out = out.filter((s) => s.runId === opts.runId || s.runId.startsWith(opts.runId!));
  }
  if (opts.sinceMs !== undefined && out.length > 0) {
    const latestTs = out[out.length - 1].ts;
    const cutoff = latestTs - opts.sinceMs;
    out = out.filter((s) => s.ts >= cutoff);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const SPARK = ["\u2581", "\u2582", "\u2583", "\u2584", "\u2585", "\u2586", "\u2587", "\u2588"];

export function sparkline(values: number[], width: number): string {
  if (values.length === 0 || width <= 0) return "";
  const sampled =
    values.length <= width
      ? values
      : Array.from({ length: width }, (_, i) => values[Math.floor((i * values.length) / width)]);
  let min = sampled[0];
  let max = sampled[0];
  for (const v of sampled) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const range = max - min || 1;
  return sampled
    .map((v) => {
      const idx = Math.min(SPARK.length - 1, Math.floor(((v - min) / range) * SPARK.length));
      return SPARK[idx];
    })
    .join("");
}

function fmtMB(n: number): string {
  return `${(n / 1024 / 1024).toFixed(1)}MB`;
}

function fmtNum(n: number): string {
  if (Math.abs(n) >= 1024 * 1024) return fmtMB(n);
  if (Math.abs(n) >= 1024) return `${(n / 1024).toFixed(1)}KB`;
  return String(n);
}

// ---------------------------------------------------------------------------
// Top-N counter growth
// ---------------------------------------------------------------------------

interface CounterGrowth {
  name: string;
  first: number;
  last: number;
  delta: number;
}

function extractCounters(s: MemorySampleExt): Record<string, number> {
  const c = s.counters;
  const accumTotal = Object.values(c.accumulatorEntryCounts ?? {}).reduce((a, b) => a + b, 0);
  return {
    activityMapSize: c.activityMapSize,
    dispatchStartTimesSize: c.dispatchStartTimesSize,
    activityBusListeners: c.activityBusListeners,
    sqlJsCachedInstances: c.sqlJsCachedInstances,
    streamTailerCount: c.streamTailerCount,
    eventCountTotal: c.eventCountTotal,
    stateJsonBytes: c.stateJsonBytes,
    accumulatorEntriesTotal: accumTotal,
    rss: s.rss,
    heapUsed: s.heapUsed,
    arrayBuffers: s.arrayBuffers,
    external: s.external,
  };
}

export function topGrowth(samples: MemorySampleExt[], n: number): CounterGrowth[] {
  if (samples.length < 2) return [];
  const first = extractCounters(samples[0]);
  const last = extractCounters(samples[samples.length - 1]);
  const out: CounterGrowth[] = [];
  for (const name of Object.keys(first)) {
    const a = first[name];
    const b = last[name];
    out.push({ name, first: a, last: b, delta: b - a });
  }
  out.sort((x, y) => y.delta - x.delta);
  return out.slice(0, n);
}

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

export interface DiagOptions {
  jsonlPath: string;
  runId?: string;
  since?: string;
  field?: string;
  top?: number;
  width?: number;
}

type NumericField = "rss" | "heapUsed" | "arrayBuffers" | "external";

export function runDiag(opts: DiagOptions): string {
  const all = loadSamples(opts.jsonlPath);
  if (all.length === 0) {
    return `No samples found in ${opts.jsonlPath}`;
  }

  const sinceMs = opts.since ? (parseDuration(opts.since) ?? undefined) : undefined;
  const filtered = filterSamples(all, { runId: opts.runId, sinceMs });
  if (filtered.length === 0) {
    return `No samples match the filter.`;
  }

  const field = (opts.field ?? "rss") as NumericField;
  if (!["rss", "heapUsed", "arrayBuffers", "external"].includes(field)) {
    return `Unknown field "${field}". Valid: rss | heapUsed | arrayBuffers | external.`;
  }

  const width = opts.width ?? 60;
  const values = filtered.map((s) => s[field]);
  const first = filtered[0];
  const last = filtered[filtered.length - 1];
  const durationMs = last.ts - first.ts;
  const durationMin = durationMs / 60_000;
  const delta = last[field] - first[field];
  const rate = durationMs > 0 ? (delta * 60_000) / durationMs : 0;

  const lines: string[] = [];
  lines.push(`Samples: ${filtered.length}  run: ${first.runId.slice(0, 8)}  duration: ${durationMin.toFixed(1)}m`);
  lines.push("");
  lines.push(`${field.padEnd(14)} ${sparkline(values, width)}`);
  lines.push(`  first ${fmtMB(first[field])}  last ${fmtMB(last[field])}  \u0394 ${fmtMB(delta)}  rate ${fmtMB(rate)}/min`);
  lines.push("");

  const topN = opts.top ?? 10;
  const growth = topGrowth(filtered, topN);
  lines.push(`Top ${topN} counters by delta (first \u2192 last):`);
  for (const g of growth) {
    const rateStr = durationMs > 0 ? `${fmtNum((g.delta * 60_000) / durationMs)}/min` : "-";
    lines.push(`  ${g.name.padEnd(26)} ${fmtNum(g.first).padStart(10)} \u2192 ${fmtNum(g.last).padStart(10)}  \u0394 ${fmtNum(g.delta).padStart(10)}  ${rateStr}`);
  }

  return lines.join("\n");
}

export function defaultMemoryJsonlFor(artifactDir: string): string {
  return resolve(artifactDir, ".cccp", "memory.jsonl");
}
