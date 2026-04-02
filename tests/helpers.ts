import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { rm } from "node:fs/promises";
import type { PipelineState, GateInfo } from "../src/types.js";
import type { GateResponse, GateStrategy } from "../src/gate/gate-strategy.js";

// ---------------------------------------------------------------------------
// Temp directory helpers — tracked for cleanup
// ---------------------------------------------------------------------------

const tracked: string[] = [];

/** Create a unique temp file path (does NOT create the file). */
export function tmpPath(): string {
  const p = join(tmpdir(), `cccp-test-${randomUUID()}`);
  tracked.push(p);
  return p;
}

/** Create a unique temp directory (creates it on disk). */
export function tmpProjectDir(): string {
  const dir = join(tmpdir(), `cccp-test-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  tracked.push(dir);
  return dir;
}

/** Remove all tracked temp paths. Call in afterAll(). */
export async function cleanupAll(): Promise<void> {
  await Promise.all(
    tracked.map((p) => rm(p, { recursive: true, force: true }).catch(() => {})),
  );
  tracked.length = 0;
}

// ---------------------------------------------------------------------------
// State factory
// ---------------------------------------------------------------------------

export function makeState(overrides?: Partial<PipelineState>): PipelineState {
  return {
    runId: randomUUID(),
    pipeline: "test-pipeline",
    project: "test-project",
    pipelineFile: "/tmp/test.yaml",
    startedAt: new Date().toISOString(),
    status: "running",
    stages: {
      s1: { name: "s1", type: "agent", status: "pending" },
      s2: { name: "s2", type: "pge", status: "pending" },
    },
    stageOrder: ["s1", "s2"],
    artifactDir: "/tmp/artifacts",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Mock gate strategy
// ---------------------------------------------------------------------------

export class MockGateStrategy implements GateStrategy {
  constructor(private response: GateResponse) {}

  async waitForGate(_gate: GateInfo): Promise<GateResponse> {
    return this.response;
  }
}

/**
 * Create a MockGateStrategy that returns a rejection with feedbackPath.
 * Convenience wrapper for tests that need a rejected gate with feedback artifact.
 */
export function mockRejectedGate(feedback: string, feedbackPath: string): MockGateStrategy {
  return new MockGateStrategy({ approved: false, feedback, feedbackPath });
}
