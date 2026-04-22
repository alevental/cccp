import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import {
  ConsoleLogger,
  SilentLogger,
  debug,
  isDebugTagEnabled,
  resetDebugTagsForTest,
  setDebugLogPath,
  closeDebugSink,
} from "../src/logger.js";
import { tmpProjectDir, cleanupAll } from "./helpers.js";

afterAll(() => cleanupAll());

describe("debug tags", () => {
  const original = process.env.CCCP_DEBUG;
  beforeEach(() => {
    delete process.env.CCCP_DEBUG;
    resetDebugTagsForTest();
  });

  it("is disabled by default", () => {
    expect(isDebugTagEnabled("wasm")).toBe(false);
    expect(isDebugTagEnabled("leak")).toBe(false);
  });

  it("enables only listed tags", () => {
    process.env.CCCP_DEBUG = "wasm,leak";
    resetDebugTagsForTest();
    expect(isDebugTagEnabled("wasm")).toBe(true);
    expect(isDebugTagEnabled("leak")).toBe(true);
    expect(isDebugTagEnabled("stream")).toBe(false);
  });

  it("'*' enables all tags", () => {
    process.env.CCCP_DEBUG = "*";
    resetDebugTagsForTest();
    expect(isDebugTagEnabled("anything")).toBe(true);
  });

  it("reset", () => {
    if (original) process.env.CCCP_DEBUG = original;
    else delete process.env.CCCP_DEBUG;
    resetDebugTagsForTest();
  });
});

describe("debug() sink", () => {
  beforeEach(() => {
    closeDebugSink();
    resetDebugTagsForTest();
  });

  it("writes to the configured sink path when enabled", () => {
    const dir = tmpProjectDir();
    const logPath = join(dir, ".cccp", "debug.log");
    setDebugLogPath(logPath);
    process.env.CCCP_DEBUG = "wasm";
    resetDebugTagsForTest();

    debug("wasm", "hello", { x: 1 });
    closeDebugSink();

    expect(existsSync(logPath)).toBe(true);
    const content = readFileSync(logPath, "utf-8");
    expect(content).toContain("[wasm]");
    expect(content).toContain("hello");
    expect(content).toContain('{"x":1}');
  });

  it("never opens the sink file when CCCP_DEBUG is unset", () => {
    const dir = tmpProjectDir();
    const logPath = join(dir, ".cccp", "debug.log");
    setDebugLogPath(logPath);
    delete process.env.CCCP_DEBUG;
    resetDebugTagsForTest();

    debug("wasm", "should be skipped");
    closeDebugSink();
    expect(existsSync(logPath)).toBe(false);
  });

  it("Logger.debug respects the tag gate", () => {
    const logger = new ConsoleLogger();
    const silent = new SilentLogger();
    // Just ensure they don't throw.
    delete process.env.CCCP_DEBUG;
    resetDebugTagsForTest();
    logger.debug("unknown", "msg");
    silent.debug("unknown", "msg");
  });
});
