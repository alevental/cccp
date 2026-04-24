// ---------------------------------------------------------------------------
// V8 sampled-allocation heap profiler + CPU profiler via node:inspector.
//
// Unlike `v8.writeHeapSnapshot()` (single-point dominator graph), the heap
// sampling profiler captures *allocation stacks* for every sampled allocation
// throughout the run. Loading the resulting `.heapprofile` into Chrome
// DevTools → Memory → Sampling Profile shows a flame graph of where
// retained bytes came from — the gold-standard tool for localising leaks
// that don't correspond to any single counter.
//
// Zero overhead when CCCP_PROFILE is unset. Writes to `<artifactDir>/.cccp/`.
// ---------------------------------------------------------------------------

import { Session } from "node:inspector/promises";
import { writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

export interface ProfilerConfig {
  cpu: boolean;
  heap: boolean;
  /** Sampling interval in bytes for heap profiler (default 32KB). */
  heapSamplingBytes: number;
}

export function parseProfilerConfig(): ProfilerConfig {
  const raw = (process.env.CCCP_PROFILE ?? "").toLowerCase();
  const parts = raw.split(/[,\s]+/).filter(Boolean);
  const all = parts.includes("all") || parts.includes("1") || parts.includes("on");
  const cpu = all || parts.includes("cpu");
  const heap = all || parts.includes("heap");
  const samplingBytes = Number(process.env.CCCP_PROFILE_HEAP_INTERVAL_BYTES);
  const heapSamplingBytes =
    Number.isFinite(samplingBytes) && samplingBytes > 0 ? samplingBytes : 32 * 1024;
  return { cpu, heap, heapSamplingBytes };
}

function tsStamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-").split(".")[0];
}

/**
 * Start CPU and/or heap-sampling profilers. Returns a `stop()` function that
 * writes profile files to `<artifactDir>/.cccp/` and disconnects the session.
 *
 * Usage:
 *   const stop = await startProfilers({ artifactDir, runId, cfg });
 *   try { await runPipeline(); } finally { await stop(); }
 */
export async function startProfilers(opts: {
  artifactDir: string;
  runId: string;
  cfg: ProfilerConfig;
  log?: (msg: string) => void;
}): Promise<() => Promise<void>> {
  const { cfg } = opts;
  if (!cfg.cpu && !cfg.heap) return async () => {};

  const log = opts.log ?? ((m: string) => process.stderr.write(m + "\n"));
  const session = new Session();
  session.connect();

  if (cfg.cpu) {
    await session.post("Profiler.enable");
    await session.post("Profiler.start");
    log(`[cccp] CPU profiler started`);
  }
  if (cfg.heap) {
    await session.post("HeapProfiler.enable");
    await session.post("HeapProfiler.startSampling", {
      samplingInterval: cfg.heapSamplingBytes,
    });
    log(`[cccp] heap sampling profiler started (interval=${cfg.heapSamplingBytes} bytes)`);
  }

  let stopped = false;
  return async () => {
    if (stopped) return;
    stopped = true;
    const dir = resolve(opts.artifactDir, ".cccp");
    mkdirSync(dir, { recursive: true });
    const stamp = tsStamp();
    const short = opts.runId.slice(0, 8);

    try {
      if (cfg.cpu) {
        const res = (await session.post("Profiler.stop")) as { profile: unknown };
        const file = resolve(dir, `cpu-${short}-${stamp}.cpuprofile`);
        writeFileSync(file, JSON.stringify(res.profile));
        log(`[cccp] CPU profile written: ${file}`);
      }
      if (cfg.heap) {
        const res = (await session.post("HeapProfiler.stopSampling")) as {
          profile: unknown;
        };
        const file = resolve(dir, `heap-${short}-${stamp}.heapprofile`);
        writeFileSync(file, JSON.stringify(res.profile));
        log(`[cccp] heap sampling profile written: ${file}`);
      }
    } catch (err) {
      log(`[cccp] profiler stop failed: ${(err as Error).message}`);
    } finally {
      try {
        session.disconnect();
      } catch {
        // best effort
      }
    }
  };
}
