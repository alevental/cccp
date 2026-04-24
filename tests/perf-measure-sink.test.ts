import { describe, it, expect, afterEach } from "vitest";
import { performance, PerformanceObserver } from "node:perf_hooks";
import {
  installPerfMeasureSink,
  performanceMeasuresDrained,
  resetPerfMeasureSink,
} from "../src/diagnostics/perf-measure-sink.js";

describe("perf-measure sink", () => {
  afterEach(() => {
    resetPerfMeasureSink();
    performance.clearMarks();
    performance.clearMeasures();
  });

  it("counts drained entries and clears the default buffer", async () => {
    const uninstall = installPerfMeasureSink();

    // Emit several measures.
    for (let i = 0; i < 5; i++) {
      performance.mark(`m-${i}-start`);
      performance.mark(`m-${i}-end`);
      performance.measure(`m-${i}`, `m-${i}-start`, `m-${i}-end`);
    }

    // Yield to let the PerformanceObserver callback fire.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    // Counter should have absorbed all emitted entries.
    expect(performanceMeasuresDrained()).toBeGreaterThanOrEqual(5);

    // Default buffer must be empty — the sink clears it on each callback.
    expect(performance.getEntriesByType("measure")).toHaveLength(0);
    expect(performance.getEntriesByType("mark")).toHaveLength(0);

    uninstall();
  });

  it("idempotent — repeat install returns a no-op uninstaller", () => {
    const u1 = installPerfMeasureSink();
    const u2 = installPerfMeasureSink();

    performance.mark("only-once-a");
    performance.mark("only-once-b");
    performance.measure("only-once", "only-once-a", "only-once-b");

    // Second uninstall is a no-op; first is the real one.
    u2();
    u1();
  });
});
