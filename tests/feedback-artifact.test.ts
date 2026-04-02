import { describe, it, expect, afterAll } from "vitest";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { writeFeedbackArtifact } from "../src/gate/feedback-artifact.js";
import { tmpProjectDir, cleanupAll } from "./helpers.js";

afterAll(async () => {
  await cleanupAll();
});

describe("writeFeedbackArtifact", () => {
  it("writes a feedback markdown file with correct content", async () => {
    const dir = tmpProjectDir();
    const path = await writeFeedbackArtifact(dir, "review", "The intro is too long.", false);

    expect(path).toContain("review-gate-feedback-1.md");

    const content = await readFile(path, "utf-8");
    expect(content).toContain("# Gate Feedback: review");
    expect(content).toContain("**Decision**: Rejected");
    expect(content).toContain("The intro is too long.");
  });

  it("writes approved decision when approved is true", async () => {
    const dir = tmpProjectDir();
    const path = await writeFeedbackArtifact(dir, "check", "Minor nits only.", true);

    const content = await readFile(path, "utf-8");
    expect(content).toContain("# Gate Feedback: check");
    expect(content).toContain("**Decision**: Approved");
    expect(content).toContain("Minor nits only.");
  });

  it("increments sequence number for multiple feedback files", async () => {
    const dir = tmpProjectDir();
    const path1 = await writeFeedbackArtifact(dir, "stage1", "First feedback", false);
    const path2 = await writeFeedbackArtifact(dir, "stage1", "Second feedback", false);
    const path3 = await writeFeedbackArtifact(dir, "stage1", "Third feedback", true);

    expect(path1).toContain("stage1-gate-feedback-1.md");
    expect(path2).toContain("stage1-gate-feedback-2.md");
    expect(path3).toContain("stage1-gate-feedback-3.md");
  });

  it("creates .cccp directory if it doesn't exist", async () => {
    const dir = tmpProjectDir();
    await writeFeedbackArtifact(dir, "test", "feedback", false);

    const files = await readdir(join(dir, ".cccp"));
    expect(files.length).toBeGreaterThan(0);
  });

  it("different stages get independent numbering", async () => {
    const dir = tmpProjectDir();
    const path1 = await writeFeedbackArtifact(dir, "stageA", "Feedback A", false);
    const path2 = await writeFeedbackArtifact(dir, "stageB", "Feedback B", false);

    expect(path1).toContain("stageA-gate-feedback-1.md");
    expect(path2).toContain("stageB-gate-feedback-1.md");
  });

  it("includes timestamp in file content", async () => {
    const dir = tmpProjectDir();
    const path = await writeFeedbackArtifact(dir, "ts-test", "Check timestamp.", false);

    const content = await readFile(path, "utf-8");
    expect(content).toContain("**Timestamp**:");
    // ISO timestamp format: YYYY-MM-DDTHH:MM:SS
    expect(content).toMatch(/\*\*Timestamp\*\*: \d{4}-\d{2}-\d{2}T/);
  });

  it("file path is inside the .cccp subdirectory", async () => {
    const dir = tmpProjectDir();
    const path = await writeFeedbackArtifact(dir, "loc-test", "feedback", false);

    expect(path).toBe(join(dir, ".cccp", "loc-test-gate-feedback-1.md"));
  });
});
