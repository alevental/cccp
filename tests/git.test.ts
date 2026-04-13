import { describe, it, expect, afterAll } from "vitest";
import { getGitInfo } from "../src/git.js";
import { tmpProjectDir, cleanupAll } from "./helpers.js";

afterAll(cleanupAll);

// ---------------------------------------------------------------------------
// getGitInfo — real git repo (this project)
// ---------------------------------------------------------------------------

describe("getGitInfo", () => {
  it("returns valid info for the project directory", async () => {
    const info = await getGitInfo(process.cwd());
    expect(info).not.toBeNull();
    expect(info!.branch).toBeTruthy();
    expect(info!.hash).toMatch(/^[0-9a-f]{7,}$/);
    expect(typeof info!.dirty).toBe("boolean");
    expect(typeof info!.ahead).toBe("number");
    expect(typeof info!.behind).toBe("number");
    expect(info!.repoName).toBeTruthy();
    expect(typeof info!.isWorktree).toBe("boolean");
  });

  it("returns null for a non-git directory", async () => {
    const dir = tmpProjectDir();
    const info = await getGitInfo(dir);
    expect(info).toBeNull();
  });

  it("returns null for a non-existent directory", async () => {
    const info = await getGitInfo("/tmp/cccp-nonexistent-dir-xyz");
    expect(info).toBeNull();
  });
});
