// ---------------------------------------------------------------------------
// Thin wrappers over Node core APIs that give a live view of runtime state.
// Used by the memory-diagnostics TUI and the JSONL logger.
// ---------------------------------------------------------------------------

import { getHeapCodeStatistics } from "node:v8";
import { performance } from "node:perf_hooks";

/** Count active handles/requests by type — a.k.a. "what's keeping the loop alive." */
export function activeHandleCounts(): Record<string, number> {
  const out: Record<string, number> = {};
  // getActiveResourcesInfo was added in Node 17 and is available in 24+.
  const info = (process as unknown as { getActiveResourcesInfo?: () => string[] })
    .getActiveResourcesInfo?.() ?? [];
  for (const t of info) out[t] = (out[t] ?? 0) + 1;
  return out;
}

/** V8 code-space statistics — growth here hints at script/prototype pollution. */
export function heapCodeStats(): {
  codeAndMetadataSize: number;
  bytecodeAndMetadataSize: number;
  externalScriptSourceSize: number;
} {
  const s = getHeapCodeStatistics();
  return {
    codeAndMetadataSize: s.code_and_metadata_size,
    bytecodeAndMetadataSize: s.bytecode_and_metadata_size,
    externalScriptSourceSize: s.external_script_source_size,
  };
}

/** Event loop utilization — sustained high util can mask GC-lag symptoms. */
let lastElu = performance.eventLoopUtilization();
export function eventLoopUtilization(): { utilization: number; idleMs: number; activeMs: number } {
  const current = performance.eventLoopUtilization();
  const delta = performance.eventLoopUtilization(current, lastElu);
  lastElu = current;
  return {
    utilization: delta.utilization,
    idleMs: delta.idle,
    activeMs: delta.active,
  };
}

/** process.resourceUsage() — maxRSS, page reclaims, context switches. */
export function resourceUsage(): {
  userCPUTimeMs: number;
  systemCPUTimeMs: number;
  maxRssKB: number;
  minorPageFaults: number;
  majorPageFaults: number;
  voluntaryContextSwitches: number;
  involuntaryContextSwitches: number;
} {
  const r = process.resourceUsage();
  return {
    userCPUTimeMs: r.userCPUTime / 1000,
    systemCPUTimeMs: r.systemCPUTime / 1000,
    maxRssKB: r.maxRSS,
    minorPageFaults: r.minorPageFault,
    majorPageFaults: r.majorPageFault,
    voluntaryContextSwitches: r.voluntaryContextSwitches,
    involuntaryContextSwitches: r.involuntaryContextSwitches,
  };
}
