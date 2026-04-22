import { describe, it, expect, afterAll, beforeEach } from "vitest";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  MemoryLogger,
  isMemoryLogEnabled,
  memoryLogPath,
  stateJsonPath,
} from "../src/diagnostics/memory-log.js";
import {
  registerActivityMap,
  registerDispatchMap,
  incTailerCount,
  decTailerCount,
} from "../src/diagnostics/runtime-registry.js";
import { tmpProjectDir, cleanupAll } from "./helpers.js";

afterAll(() => cleanupAll());

describe("isMemoryLogEnabled", () => {
  const original = process.env.CCCP_MEM_LOG;
  beforeEach(() => {
    process.env.CCCP_MEM_LOG = original;
  });

  it("defaults to enabled when unset", () => {
    delete process.env.CCCP_MEM_LOG;
    expect(isMemoryLogEnabled()).toBe(true);
  });
  it("honours 0/false/off/no", () => {
    for (const v of ["0", "false", "off", "no", "FALSE", "OFF"]) {
      process.env.CCCP_MEM_LOG = v;
      expect(isMemoryLogEnabled()).toBe(false);
    }
  });
  it("enabled for 1 / anything else", () => {
    process.env.CCCP_MEM_LOG = "1";
    expect(isMemoryLogEnabled()).toBe(true);
    process.env.CCCP_MEM_LOG = "yes";
    expect(isMemoryLogEnabled()).toBe(true);
  });
});

describe("MemoryLogger", () => {
  it("appends JSONL lines with expected fields", () => {
    const dir = tmpProjectDir();
    const artifactDir = dir;
    mkdirSync(join(artifactDir, ".cccp"), { recursive: true });
    writeFileSync(join(artifactDir, ".cccp", "state.json"), "{}");
    const logger = new MemoryLogger(
      memoryLogPath(artifactDir),
      "run-abc",
      stateJsonPath(artifactDir),
      true,
    );

    logger.record(42);
    logger.record(43);

    const content = readFileSync(memoryLogPath(artifactDir), "utf-8");
    const lines = content.trim().split("\n");
    expect(lines).toHaveLength(2);
    const first = JSON.parse(lines[0]);
    expect(first.runId).toBe("run-abc");
    expect(first.pid).toBe(process.pid);
    expect(typeof first.rss).toBe("number");
    expect(typeof first.heapUsed).toBe("number");
    expect(first.counters.eventCountTotal).toBe(42);
    expect(first.heapSpaces).toBeTypeOf("object");
  });

  it("is a no-op when disabled", () => {
    const dir = tmpProjectDir();
    const logger = new MemoryLogger(
      memoryLogPath(dir),
      "run-xyz",
      stateJsonPath(dir),
      false,
    );
    logger.record(1);
    expect(existsSync(memoryLogPath(dir))).toBe(false);
  });

  it("picks up registry counters", () => {
    const dir = tmpProjectDir();
    const release1 = registerActivityMap(() => 7);
    const release2 = registerDispatchMap(() => 3);
    incTailerCount();
    incTailerCount();
    try {
      const logger = new MemoryLogger(
        memoryLogPath(dir),
        "run-counters",
        stateJsonPath(dir),
        true,
      );
      logger.record();
      const line = readFileSync(memoryLogPath(dir), "utf-8").trim();
      const sample = JSON.parse(line);
      expect(sample.counters.activityMapSize).toBe(7);
      expect(sample.counters.dispatchStartTimesSize).toBe(3);
      expect(sample.counters.streamTailerCount).toBeGreaterThanOrEqual(2);
    } finally {
      release1();
      release2();
      decTailerCount();
      decTailerCount();
    }
  });
});
