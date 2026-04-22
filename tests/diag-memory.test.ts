import { describe, it, expect, afterAll } from "vitest";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  runDiag,
  parseDuration,
  loadSamples,
  topGrowth,
  defaultMemoryJsonlFor,
} from "../src/diagnostics/diag-memory.js";
import type { MemorySampleExt } from "../src/diagnostics/memory-log.js";
import { tmpProjectDir, cleanupAll } from "./helpers.js";

afterAll(() => cleanupAll());

function makeSample(ts: number, runId: string, overrides: Partial<MemorySampleExt> = {}): MemorySampleExt {
  return {
    ts,
    runId,
    pid: 1,
    rss: 100_000_000,
    heapUsed: 50_000_000,
    heapTotal: 60_000_000,
    external: 10_000_000,
    arrayBuffers: 5_000_000,
    heapSpaces: {},
    counters: {
      activityMapSize: 0,
      dispatchStartTimesSize: 0,
      activityBusListeners: 0,
      sqlJsCachedInstances: 0,
      sqlJsInitialized: false,
      streamTailerCount: 0,
      eventCountTotal: 0,
      accumulatorEntryCounts: {},
      stateJsonBytes: 0,
    },
    rates: { rssPerMin: null, heapPerMin: null, abPerMin: null },
    ...overrides,
  };
}

describe("parseDuration", () => {
  it("parses seconds/minutes/hours/days", () => {
    expect(parseDuration("30s")).toBe(30_000);
    expect(parseDuration("5m")).toBe(300_000);
    expect(parseDuration("2h")).toBe(7_200_000);
    expect(parseDuration("1d")).toBe(86_400_000);
  });
  it("returns null for garbage", () => {
    expect(parseDuration("lol")).toBeNull();
    expect(parseDuration("")).toBeNull();
  });
});

describe("topGrowth", () => {
  it("ranks counters by delta", () => {
    const s0 = makeSample(1000, "r1", {
      counters: {
        activityMapSize: 1,
        dispatchStartTimesSize: 2,
        activityBusListeners: 1,
        sqlJsCachedInstances: 1,
        sqlJsInitialized: true,
        streamTailerCount: 0,
        eventCountTotal: 10,
        accumulatorEntryCounts: {},
        stateJsonBytes: 100,
      },
    });
    const s1 = makeSample(2000, "r1", {
      counters: {
        activityMapSize: 100, // grew +99
        dispatchStartTimesSize: 2,
        activityBusListeners: 1,
        sqlJsCachedInstances: 1,
        sqlJsInitialized: true,
        streamTailerCount: 0,
        eventCountTotal: 1000, // grew +990
        accumulatorEntryCounts: {},
        stateJsonBytes: 100,
      },
      rss: 200_000_000, // grew +100M
    });
    const top = topGrowth([s0, s1], 5);
    expect(top[0].delta).toBeGreaterThan(top[1].delta); // sorted desc
    expect(top.find((r) => r.name === "eventCountTotal")?.delta).toBe(990);
    expect(top.find((r) => r.name === "activityMapSize")?.delta).toBe(99);
  });
});

describe("runDiag end-to-end", () => {
  it("produces sparkline + top-N output", () => {
    const dir = tmpProjectDir();
    mkdirSync(join(dir, ".cccp"), { recursive: true });
    const p = defaultMemoryJsonlFor(dir);
    const lines = [
      makeSample(1_000, "run-1", { rss: 100_000_000 }),
      makeSample(61_000, "run-1", { rss: 150_000_000 }),
      makeSample(121_000, "run-1", { rss: 300_000_000 }),
    ]
      .map((s) => JSON.stringify(s))
      .join("\n");
    writeFileSync(p, lines);

    const out = runDiag({ jsonlPath: p, field: "rss", top: 3 });
    expect(out).toContain("Samples: 3");
    expect(out).toContain("rss");
    expect(out).toContain("Top 3 counters");
  });

  it("filters by runId prefix", () => {
    const dir = tmpProjectDir();
    mkdirSync(join(dir, ".cccp"), { recursive: true });
    const p = defaultMemoryJsonlFor(dir);
    writeFileSync(
      p,
      [
        makeSample(1, "aaa-bbb", { rss: 100_000_000 }),
        makeSample(2, "ccc-ddd", { rss: 200_000_000 }),
        makeSample(3, "aaa-eee", { rss: 300_000_000 }),
      ]
        .map((s) => JSON.stringify(s))
        .join("\n"),
    );

    const out = runDiag({ jsonlPath: p, runId: "aaa", field: "rss" });
    expect(out).toContain("Samples: 2");
  });
});

describe("loadSamples", () => {
  it("skips malformed lines", () => {
    const dir = tmpProjectDir();
    mkdirSync(join(dir, ".cccp"), { recursive: true });
    const p = defaultMemoryJsonlFor(dir);
    writeFileSync(
      p,
      [
        JSON.stringify(makeSample(1, "r1")),
        "{ this is not json",
        "",
        JSON.stringify(makeSample(2, "r1")),
      ].join("\n"),
    );
    expect(loadSamples(p)).toHaveLength(2);
  });
});
