import React, { useRef } from "react";
import { Box, Text, useStdout } from "ink";
import { getHeapSpaceStatistics } from "node:v8";
import { snapshotRegistry, type RegistrySnapshot } from "../diagnostics/runtime-registry.js";

// ---------------------------------------------------------------------------
// Sample types + bounded ring buffer
// ---------------------------------------------------------------------------

export interface HeapSpaceInfo {
  used: number;
  committed: number;
}

export interface MemorySample {
  ts: number;
  rss: number;
  heapUsed: number;
  heapTotal: number;
  external: number;
  arrayBuffers: number;
  heapSpaces: Record<string, HeapSpaceInfo>;
}

export type MemoryField = "rss" | "heapUsed" | "heapTotal" | "external" | "arrayBuffers";

const DEFAULT_CAPACITY = 600;

/**
 * Bounded ring buffer of process memory samples.
 *
 * Lives outside the Ink tree so history is preserved across the 15-minute
 * yoga-layout remount performed by `startDashboard`.
 */
export class MemorySampleRing {
  private readonly cap: number;
  private samples: MemorySample[] = [];
  private baselineSample: MemorySample | null = null;

  constructor(capacity: number = DEFAULT_CAPACITY) {
    this.cap = capacity;
  }

  record(): MemorySample {
    const mu = process.memoryUsage();
    const heapSpaces: Record<string, HeapSpaceInfo> = {};
    for (const s of getHeapSpaceStatistics()) {
      heapSpaces[s.space_name] = {
        used: s.space_used_size,
        committed: s.space_size,
      };
    }
    const sample: MemorySample = {
      ts: Date.now(),
      rss: mu.rss,
      heapUsed: mu.heapUsed,
      heapTotal: mu.heapTotal,
      external: mu.external,
      arrayBuffers: mu.arrayBuffers,
      heapSpaces,
    };
    if (!this.baselineSample) this.baselineSample = sample;
    this.samples.push(sample);
    if (this.samples.length > this.cap) this.samples.shift();
    return sample;
  }

  getAll(): readonly MemorySample[] {
    return this.samples;
  }

  baseline(): MemorySample | null {
    return this.baselineSample;
  }

  latest(): MemorySample | null {
    return this.samples[this.samples.length - 1] ?? null;
  }

  capacity(): number {
    return this.cap;
  }

  /** Bytes/min across the last windowMs of samples. Null if < 2 samples in window. */
  growthRate(field: MemoryField, windowMs: number): number | null {
    const latest = this.samples[this.samples.length - 1];
    if (!latest) return null;
    const cutoff = latest.ts - windowMs;
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
// Formatting helpers
// ---------------------------------------------------------------------------

function fmtMB(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

function fmtDelta(bytes: number): string {
  const sign = bytes >= 0 ? "+" : "";
  return `${sign}${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

function fmtRate(bytesPerMin: number | null): string {
  if (bytesPerMin === null) return "\u2014";
  const sign = bytesPerMin >= 0 ? "+" : "";
  return `${sign}${(bytesPerMin / 1024 / 1024).toFixed(2)}MB/min`;
}

function fmtDuration(ms: number): string {
  const secs = Math.floor(ms / 1000);
  const mins = Math.floor(secs / 60);
  const s = secs % 60;
  return mins > 0 ? `${mins}m ${s}s` : `${s}s`;
}

/** Color a delta: red if > 100MB, yellow if > 20MB, otherwise dimmed. */
function deltaColor(bytes: number): "red" | "yellow" | undefined {
  if (bytes > 100 * 1024 * 1024) return "red";
  if (bytes > 20 * 1024 * 1024) return "yellow";
  return undefined;
}

// ---------------------------------------------------------------------------
// Sparkline renderer
// ---------------------------------------------------------------------------

const SPARK = ["\u2581", "\u2582", "\u2583", "\u2584", "\u2585", "\u2586", "\u2587", "\u2588"];

function sparkline(values: number[], width: number): string {
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

function minMax(values: number[]): { min: number; max: number } {
  if (values.length === 0) return { min: 0, max: 0 };
  let min = values[0];
  let max = values[0];
  for (const v of values) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return { min, max };
}

// ---------------------------------------------------------------------------
// MemoryView component
// ---------------------------------------------------------------------------

interface MemoryViewProps {
  samples: MemorySampleRing | undefined;
  events: number;
  activities: number;
  dispatches: number;
  chromeHeight: number;
}

export function MemoryView({ samples, events, activities, dispatches, chromeHeight }: MemoryViewProps) {
  const { stdout } = useStdout();
  const cols = stdout.columns ?? 80;
  const rows = stdout.rows ?? 24;
  const sparkWidth = Math.max(20, Math.min(80, cols - 28));

  if (!samples) {
    return (
      <Box flexDirection="column" marginTop={1}>
        <Text bold underline>Memory Diagnostics</Text>
        <Text dimColor>  No sample buffer available in this mode.</Text>
      </Box>
    );
  }

  const latest = samples.latest();
  const baseline = samples.baseline();
  const all = samples.getAll();

  if (!latest || !baseline) {
    return (
      <Box flexDirection="column" marginTop={1}>
        <Text bold underline>Memory Diagnostics</Text>
        <Text dimColor>  Waiting for samples...</Text>
      </Box>
    );
  }

  const sinceMount = latest.ts - baseline.ts;
  const dRss = latest.rss - baseline.rss;
  const dHeap = latest.heapUsed - baseline.heapUsed;
  const dExt = latest.external - baseline.external;
  const dAb = latest.arrayBuffers - baseline.arrayBuffers;

  const rssVals = all.map((s) => s.rss);
  const heapVals = all.map((s) => s.heapUsed);
  const abVals = all.map((s) => s.arrayBuffers);

  const rssRange = minMax(rssVals);
  const heapRange = minMax(heapVals);
  const abRange = minMax(abVals);

  const rssSpark = sparkline(rssVals, sparkWidth);
  const heapSpark = sparkline(heapVals, sparkWidth);
  const abSpark = sparkline(abVals, sparkWidth);

  // Sort heap spaces by used size, largest first.
  const spaceEntries = Object.entries(latest.heapSpaces).sort((a, b) => b[1].used - a[1].used);

  // Cap heap-space rows so the whole view fits roughly within the pane.
  const availableRows = Math.max(8, rows - chromeHeight - 2);
  const reservedRows = 10; // title + snapshot + delta + rate + 3 sparkline rows + counters block
  const maxSpaceRows = Math.max(3, availableRows - reservedRows);
  const visibleSpaces = spaceEntries.slice(0, maxSpaceRows);

  return (
    <Box flexDirection="column" marginTop={1}>
      <Box>
        <Text bold underline>Memory Diagnostics</Text>
        <Text dimColor>  [m] back to events</Text>
      </Box>

      <Box marginTop={1}>
        <Text>Current:  </Text>
        <Text>RSS {fmtMB(latest.rss)}</Text>
        <Text dimColor>{"  "}heap {fmtMB(latest.heapUsed)}/{fmtMB(latest.heapTotal)}</Text>
        <Text dimColor>{"  "}external {fmtMB(latest.external)}</Text>
        <Text dimColor>{"  "}arrayBuffers {fmtMB(latest.arrayBuffers)}</Text>
      </Box>

      <Box>
        <Text dimColor>{"\u0394"} since {fmtDuration(sinceMount)}:  </Text>
        <Text color={deltaColor(dRss)}>RSS {fmtDelta(dRss)}</Text>
        <Text>{"  "}</Text>
        <Text color={deltaColor(dHeap)}>heap {fmtDelta(dHeap)}</Text>
        <Text>{"  "}</Text>
        <Text color={deltaColor(dExt)}>external {fmtDelta(dExt)}</Text>
        <Text>{"  "}</Text>
        <Text color={deltaColor(dAb)}>arrayBuffers {fmtDelta(dAb)}</Text>
      </Box>

      <Box>
        <Text dimColor>Rate (1m):  </Text>
        <Text>RSS {fmtRate(samples.growthRate("rss", 60_000))}</Text>
        <Text dimColor>{"  "}heap {fmtRate(samples.growthRate("heapUsed", 60_000))}</Text>
        <Text dimColor>{"  "}arrayBuffers {fmtRate(samples.growthRate("arrayBuffers", 60_000))}</Text>
      </Box>

      <Box marginTop={1}>
        <Text dimColor>RSS           </Text>
        <Text>{rssSpark}</Text>
        <Text dimColor>{"  "}{fmtMB(rssRange.min)} {"\u2192"} {fmtMB(rssRange.max)}</Text>
      </Box>
      <Box>
        <Text dimColor>heapUsed      </Text>
        <Text>{heapSpark}</Text>
        <Text dimColor>{"  "}{fmtMB(heapRange.min)} {"\u2192"} {fmtMB(heapRange.max)}</Text>
      </Box>
      <Box>
        <Text dimColor>arrayBuffers  </Text>
        <Text>{abSpark}</Text>
        <Text dimColor>{"  "}{fmtMB(abRange.min)} {"\u2192"} {fmtMB(abRange.max)}</Text>
      </Box>

      <Box marginTop={1}>
        <Text bold>V8 heap spaces</Text>
        <Text dimColor>  (top {visibleSpaces.length} of {spaceEntries.length}, sorted by used)</Text>
      </Box>
      {visibleSpaces.map(([name, info]) => (
        <Box key={name}>
          <Text dimColor>  {name.padEnd(28)}</Text>
          <Text>{fmtMB(info.used).padStart(8)}</Text>
          <Text dimColor> used / {fmtMB(info.committed)} committed</Text>
        </Box>
      ))}

      <Box marginTop={1}>
        <Text bold>In-process state</Text>
      </Box>
      <Box>
        <Text dimColor>  events </Text>
        <Text>{events}</Text>
        <Text dimColor>   activities </Text>
        <Text>{activities}</Text>
        <Text dimColor>   dispatchTimes </Text>
        <Text>{dispatches}</Text>
        <Text dimColor>   samples {all.length}/{samples.capacity()}</Text>
      </Box>

      <LeakSuspectsPanel />
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Tracked leak suspects — live counters from the diagnostics registry.
// Captures a baseline on first render and renders deltas in red when a
// counter grew > 2x or > 500 absolute.
// ---------------------------------------------------------------------------

function LeakSuspectsPanel() {
  const baselineRef = useRef<{ reg: RegistrySnapshot } | null>(null);

  const reg = snapshotRegistry();

  if (!baselineRef.current) {
    baselineRef.current = { reg };
  }
  const base = baselineRef.current;

  type Row = { label: string; curr: number; base: number };
  const rows: Row[] = [
    { label: "activityMap", curr: reg.activityMapSize, base: base.reg.activityMapSize },
    { label: "dispatchMap", curr: reg.dispatchMapSize, base: base.reg.dispatchMapSize },
    { label: "busListeners", curr: reg.activityBusListeners, base: base.reg.activityBusListeners },
    { label: "streamTailers", curr: reg.streamTailerCount, base: base.reg.streamTailerCount },
  ];
  const accumTotal = Object.values(reg.accumulatorEntryCounts).reduce((a, b) => a + b, 0);
  const accumBase = Object.values(base.reg.accumulatorEntryCounts).reduce((a, b) => a + b, 0);
  rows.push({ label: "accumulatorEntries", curr: accumTotal, base: accumBase });

  function color(r: Row): "red" | "yellow" | undefined {
    const delta = r.curr - r.base;
    if (delta > 500 || (r.base > 0 && r.curr / r.base > 2)) return "red";
    if (delta > 50 || (r.base > 0 && r.curr / r.base > 1.5)) return "yellow";
    return undefined;
  }

  return (
    <>
      <Box marginTop={1}>
        <Text bold>Tracked leak suspects</Text>
        <Text dimColor>  (baseline \u2192 current; red = grew &gt;2x or &gt;500)</Text>
      </Box>
      {rows.map((r) => {
        const delta = r.curr - r.base;
        const sign = delta >= 0 ? "+" : "";
        return (
          <Box key={r.label}>
            <Text dimColor>  {r.label.padEnd(20)}</Text>
            <Text color={color(r)}>{r.curr}</Text>
            <Text dimColor>{"  ("}{sign}{delta}{" from "}{r.base}{")"}</Text>
          </Box>
        );
      })}
    </>
  );
}
