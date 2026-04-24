// ---------------------------------------------------------------------------
// PerformanceEntry sink — drains the default perf_hooks buffer as entries
// arrive, so Ink's react-reconciler instrumentation doesn't accumulate
// PerformanceMeasure objects indefinitely.
//
// Problem: react-reconciler calls `performance.measure('Text', …)` /
// `performance.measure('Box', …)` etc. for every fiber commit. Ink renders
// at ~10 FPS and the component tree contains hundreds of Text/Box nodes,
// so each tick produces hundreds of measures. Node's default performance
// timeline buffer is unbounded — it retains every entry. A 3+ hour TUI
// run accumulated 426,489 PerformanceMeasure objects + correlated strings
// in a heap snapshot we analysed (~260MB shallow, most of old_space).
//
// Fix: install a PerformanceObserver for "measure" and "mark" entry types
// that increments a counter and immediately clears the default buffer on
// every callback. Observer callbacks are batched by the VM, so this is
// effectively a continuous drain with negligible overhead.
//
// Side-effect concerns:
//   - Inspector's Profiler (`CCCP_PROFILE=cpu`) uses CPU sampling, not
//     marks/measures — unaffected.
//   - HeapProfiler sampling is separate from perf_hooks — unaffected.
//   - Any user-installed PerformanceObserver gets its own delivery channel
//     before our clear runs; we're clearing the *default timeline buffer*,
//     not observer queues.
// ---------------------------------------------------------------------------

import { PerformanceObserver, performance } from "node:perf_hooks";

let observer: PerformanceObserver | null = null;
let consumed = 0;

/**
 * Install the sink. Idempotent — repeat calls return the existing uninstall.
 * Call once per process that mounts Ink (dashboard, agent-monitor).
 */
export function installPerfMeasureSink(): () => void {
  if (observer) return () => {};
  observer = new PerformanceObserver((list) => {
    consumed += list.getEntries().length;
    // Drain the default timeline so entries don't accumulate between callbacks.
    performance.clearMarks();
    performance.clearMeasures();
  });
  // `buffered: true` delivers entries emitted before `observe()` was called,
  // so even if Ink mounted first we catch up in the first tick.
  observer.observe({ entryTypes: ["measure", "mark"], buffered: true });
  return () => {
    observer?.disconnect();
    observer = null;
  };
}

/** Monotonic count of perf entries the sink has drained. Exposed via the
 *  diagnostics registry as `performanceMeasuresDrained`. */
export function performanceMeasuresDrained(): number {
  return consumed;
}

/** For tests — reset counter and observer state. */
export function resetPerfMeasureSink(): void {
  observer?.disconnect();
  observer = null;
  consumed = 0;
}
