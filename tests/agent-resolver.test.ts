import { describe, it, expect } from "vitest";
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { resolveAgent, listOperations } from "../src/agent-resolver.js";

function tmpPath() {
  return join(tmpdir(), `cccp-test-${randomUUID()}`);
}

async function setupAgentDirs() {
  const root = tmpPath();
  const dir1 = join(root, "search1");
  const dir2 = join(root, "search2");

  // dir1: flat agent "writer.md"
  await mkdir(dir1, { recursive: true });
  await writeFile(join(dir1, "writer.md"), "# Writer agent", "utf-8");

  // dir1: directory agent "architect/agent.md" + operations
  const archDir = join(dir1, "architect");
  await mkdir(archDir, { recursive: true });
  await writeFile(join(archDir, "agent.md"), "# Architect base", "utf-8");
  await writeFile(join(archDir, "health-assessment.md"), "# Health op", "utf-8");
  await writeFile(join(archDir, "plan-authoring.md"), "# Plan op", "utf-8");

  // dir2: flat agent "reviewer.md"
  await mkdir(dir2, { recursive: true });
  await writeFile(join(dir2, "reviewer.md"), "# Reviewer agent", "utf-8");

  // dir2: shadow of "writer.md" (lower priority)
  await writeFile(join(dir2, "writer.md"), "# Writer v2", "utf-8");

  return { root, searchPaths: [dir1, dir2] };
}

// ---------------------------------------------------------------------------
// Flat-file agent resolution
// ---------------------------------------------------------------------------

describe("resolveAgent — flat file", () => {
  it("resolves a flat agent by name", async () => {
    const { searchPaths } = await setupAgentDirs();
    const result = await resolveAgent("writer", searchPaths);
    expect(result.agentPath).toContain("search1/writer.md");
    expect(result.isDirectory).toBe(false);
    expect(result.operationPath).toBeUndefined();
  });

  it("finds agent in second search path", async () => {
    const { searchPaths } = await setupAgentDirs();
    const result = await resolveAgent("reviewer", searchPaths);
    expect(result.agentPath).toContain("search2/reviewer.md");
    expect(result.isDirectory).toBe(false);
  });

  it("first search path wins on name collision", async () => {
    const { searchPaths } = await setupAgentDirs();
    const result = await resolveAgent("writer", searchPaths);
    expect(result.agentPath).toContain("search1/writer.md");
  });

  it("throws for flat agent with operation", async () => {
    const { searchPaths } = await setupAgentDirs();
    await expect(
      resolveAgent("writer", searchPaths, "some-op"),
    ).rejects.toThrow(/does not support operation/);
  });
});

// ---------------------------------------------------------------------------
// Directory-style agent resolution
// ---------------------------------------------------------------------------

describe("resolveAgent — directory agent", () => {
  it("resolves a directory agent by name", async () => {
    const { searchPaths } = await setupAgentDirs();
    const result = await resolveAgent("architect", searchPaths);
    expect(result.agentPath).toContain("architect/agent.md");
    expect(result.isDirectory).toBe(true);
    expect(result.operationPath).toBeUndefined();
  });

  it("resolves a directory agent with operation", async () => {
    const { searchPaths } = await setupAgentDirs();
    const result = await resolveAgent("architect", searchPaths, "health-assessment");
    expect(result.agentPath).toContain("architect/agent.md");
    expect(result.operationPath).toContain("architect/health-assessment.md");
    expect(result.isDirectory).toBe(true);
  });

  it("throws for missing operation", async () => {
    const { searchPaths } = await setupAgentDirs();
    await expect(
      resolveAgent("architect", searchPaths, "nonexistent"),
    ).rejects.toThrow(/Operation "nonexistent" not found/);
  });
});

// ---------------------------------------------------------------------------
// Direct path resolution
// ---------------------------------------------------------------------------

describe("resolveAgent — direct path", () => {
  it("resolves a path containing /", async () => {
    const dir = tmpPath();
    await mkdir(join(dir, "my-agents"), { recursive: true });
    await writeFile(join(dir, "my-agents", "helper.md"), "# Helper", "utf-8");

    const result = await resolveAgent("my-agents/helper.md", [], undefined, dir);
    expect(result.agentPath).toBe(join(dir, "my-agents", "helper.md"));
    expect(result.isDirectory).toBe(false);
  });

  it("resolves a .md filename directly", async () => {
    const dir = tmpPath();
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "agent.md"), "# Agent", "utf-8");

    const result = await resolveAgent("agent.md", [], undefined, dir);
    expect(result.agentPath).toBe(join(dir, "agent.md"));
  });

  it("throws for missing direct path", async () => {
    await expect(
      resolveAgent("nonexistent/agent.md", [], undefined, "/tmp"),
    ).rejects.toThrow(/not found/);
  });
});

// ---------------------------------------------------------------------------
// Agent not found
// ---------------------------------------------------------------------------

describe("resolveAgent — not found", () => {
  it("throws with searched paths listed", async () => {
    const { searchPaths } = await setupAgentDirs();
    await expect(resolveAgent("ghost", searchPaths)).rejects.toThrow(
      /Agent "ghost" not found/,
    );
  });
});

// ---------------------------------------------------------------------------
// listOperations
// ---------------------------------------------------------------------------

describe("listOperations", () => {
  it("lists operations for a directory agent", async () => {
    const { searchPaths } = await setupAgentDirs();
    const ops = await listOperations("architect", searchPaths);
    expect(ops).toContain("health-assessment");
    expect(ops).toContain("plan-authoring");
    expect(ops).not.toContain("agent");
  });

  it("returns empty for flat agent", async () => {
    const { searchPaths } = await setupAgentDirs();
    const ops = await listOperations("writer", searchPaths);
    expect(ops).toEqual([]);
  });

  it("returns empty for nonexistent agent", async () => {
    const { searchPaths } = await setupAgentDirs();
    const ops = await listOperations("ghost", searchPaths);
    expect(ops).toEqual([]);
  });
});
