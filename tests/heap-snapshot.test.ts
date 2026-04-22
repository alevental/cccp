import { describe, it, expect, afterAll, beforeEach } from "vitest";
import { existsSync } from "node:fs";
import {
  readHeapSnapshotConfig,
  writeSnapshot,
  installHeapSnapshotHandlers,
  ThresholdSnapshotter,
} from "../src/diagnostics/heap-snapshot.js";
import { tmpProjectDir, cleanupAll } from "./helpers.js";

afterAll(() => cleanupAll());

describe("readHeapSnapshotConfig", () => {
  const originals = {
    rss: process.env.CCCP_HEAP_SNAPSHOT_ON_RSS_MB,
    heap: process.env.CCCP_HEAP_SNAPSHOT_ON_HEAP_MB,
    every: process.env.CCCP_HEAP_SNAPSHOT_EVERY_MIN,
    crash: process.env.CCCP_HEAP_SNAPSHOT_ON_CRASH,
  };
  beforeEach(() => {
    delete process.env.CCCP_HEAP_SNAPSHOT_ON_RSS_MB;
    delete process.env.CCCP_HEAP_SNAPSHOT_ON_HEAP_MB;
    delete process.env.CCCP_HEAP_SNAPSHOT_EVERY_MIN;
    delete process.env.CCCP_HEAP_SNAPSHOT_ON_CRASH;
  });

  it("returns all-disabled when no env vars are set", () => {
    const cfg = readHeapSnapshotConfig();
    expect(cfg.onSigUsr2).toBe(false);
    expect(cfg.rssMb).toBeNull();
    expect(cfg.heapMb).toBeNull();
    expect(cfg.everyMin).toBeNull();
    expect(cfg.onCrash).toBe(false);
  });

  it("parses thresholds", () => {
    process.env.CCCP_HEAP_SNAPSHOT_ON_RSS_MB = "1500";
    process.env.CCCP_HEAP_SNAPSHOT_ON_HEAP_MB = "800";
    const cfg = readHeapSnapshotConfig();
    expect(cfg.rssMb).toBe(1500);
    expect(cfg.heapMb).toBe(800);
    expect(cfg.onSigUsr2).toBe(true);
  });

  it("enables SIGUSR2 whenever any trigger is enabled", () => {
    process.env.CCCP_HEAP_SNAPSHOT_EVERY_MIN = "60";
    expect(readHeapSnapshotConfig().onSigUsr2).toBe(true);
  });

  // Restore
  it("end", () => {
    if (originals.rss) process.env.CCCP_HEAP_SNAPSHOT_ON_RSS_MB = originals.rss;
    if (originals.heap) process.env.CCCP_HEAP_SNAPSHOT_ON_HEAP_MB = originals.heap;
    if (originals.every) process.env.CCCP_HEAP_SNAPSHOT_EVERY_MIN = originals.every;
    if (originals.crash) process.env.CCCP_HEAP_SNAPSHOT_ON_CRASH = originals.crash;
  });
});

describe("installHeapSnapshotHandlers", () => {
  const originals = {
    rss: process.env.CCCP_HEAP_SNAPSHOT_ON_RSS_MB,
  };
  beforeEach(() => {
    delete process.env.CCCP_HEAP_SNAPSHOT_ON_RSS_MB;
    delete process.env.CCCP_HEAP_SNAPSHOT_ON_HEAP_MB;
    delete process.env.CCCP_HEAP_SNAPSHOT_EVERY_MIN;
    delete process.env.CCCP_HEAP_SNAPSHOT_ON_CRASH;
  });

  it("does not install SIGUSR2 when all triggers are disabled", () => {
    const before = process.listeners("SIGUSR2").length;
    const uninstall = installHeapSnapshotHandlers({
      artifactDir: tmpProjectDir(),
      runId: "abcdefgh",
    });
    expect(process.listeners("SIGUSR2").length).toBe(before);
    uninstall();
  });

  it("installs and removes SIGUSR2 when a trigger is enabled", () => {
    process.env.CCCP_HEAP_SNAPSHOT_ON_RSS_MB = "9999";
    const before = process.listeners("SIGUSR2").length;
    const uninstall = installHeapSnapshotHandlers({
      artifactDir: tmpProjectDir(),
      runId: "abcdefgh",
    });
    expect(process.listeners("SIGUSR2").length).toBe(before + 1);
    uninstall();
    expect(process.listeners("SIGUSR2").length).toBe(before);
  });

  it("end", () => {
    if (originals.rss) process.env.CCCP_HEAP_SNAPSHOT_ON_RSS_MB = originals.rss;
  });
});

describe("ThresholdSnapshotter", () => {
  const originals = { rss: process.env.CCCP_HEAP_SNAPSHOT_ON_RSS_MB };
  beforeEach(() => {
    delete process.env.CCCP_HEAP_SNAPSHOT_ON_RSS_MB;
    delete process.env.CCCP_HEAP_SNAPSHOT_ON_HEAP_MB;
  });

  it("is a no-op when thresholds are unset", () => {
    const dir = tmpProjectDir();
    const logs: string[] = [];
    const s = new ThresholdSnapshotter(dir, "abcdefgh", (m) => logs.push(m));
    s.maybeSnapshot(10_000_000_000, 10_000_000_000);
    expect(logs).toHaveLength(0);
  });

  it("end", () => {
    if (originals.rss) process.env.CCCP_HEAP_SNAPSHOT_ON_RSS_MB = originals.rss;
  });
});

describe("writeSnapshot (smoke)", () => {
  it("writes a .heapsnapshot file under .cccp/", () => {
    const dir = tmpProjectDir();
    const file = writeSnapshot(dir, "1234abcdef", "test");
    expect(file.endsWith(".heapsnapshot")).toBe(true);
    expect(existsSync(file)).toBe(true);
  });
});
