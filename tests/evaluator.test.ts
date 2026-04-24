import { describe, it, expect } from "vitest";
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { parseEvaluation, parseEvaluationContent } from "../src/evaluator.js";
import { tmpPath } from "./helpers.js";

// ---------------------------------------------------------------------------
// parseEvaluationContent (in-memory)
// ---------------------------------------------------------------------------

describe("parseEvaluationContent", () => {
  it("detects PASS", () => {
    const content = `## Evaluation: tech-scoping

### Criterion Results

| # | Criterion | Result | Evidence |
|---|-----------|--------|----------|
| 1 | Coverage  | PASS   | All modules covered |

### Overall: PASS

### Iteration: 1 of 3`;

    const result = parseEvaluationContent(content);
    expect(result.outcome).toBe("pass");
    expect(result.rawLine).toBe("### Overall: PASS");
  });

  it("detects FAIL", () => {
    const content = `## Evaluation: tech-scoping

### Criterion Results

| # | Criterion | Result | Evidence |
|---|-----------|--------|----------|
| 1 | Coverage  | FAIL   | Missing auth module |

### Overall: FAIL

### Iteration Guidance (if FAIL)

1. Add auth module coverage

### Iteration: 1 of 3`;

    const result = parseEvaluationContent(content);
    expect(result.outcome).toBe("fail");
    expect(result.rawLine).toBe("### Overall: FAIL");
  });

  it("handles PASS with extra whitespace", () => {
    const result = parseEvaluationContent("### Overall: PASS  ");
    expect(result.outcome).toBe("pass");
  });

  it("handles FAIL with extra whitespace", () => {
    const result = parseEvaluationContent("### Overall: FAIL  ");
    expect(result.outcome).toBe("fail");
  });

  it("returns parse_error when Overall line is missing", () => {
    const content = `## Evaluation: something

### Criterion Results

| # | Criterion | Result |
|---|-----------|--------|
| 1 | Check     | PASS   |

No overall line here.`;

    const result = parseEvaluationContent(content);
    expect(result.outcome).toBe("parse_error");
    expect(result.error).toContain("does not contain a valid");
  });

  it("returns parse_error for invalid verdict value", () => {
    const result = parseEvaluationContent("### Overall: MAYBE");
    expect(result.outcome).toBe("parse_error");
  });

  it("returns parse_error for empty content", () => {
    const result = parseEvaluationContent("");
    expect(result.outcome).toBe("parse_error");
  });

  // Post-v0.17.5: the parser accepts H1–H6, bold, and plain-line variants
  // so a one-character format drift doesn't kill hours of upstream work.
  // Regression driven by a real incident — `## Overall: PASS` (H2 instead
  // of H3) caused a 5h pipeline to halt with "Evaluation parse error"
  // after task-11 completed successfully.
  it("accepts H2 Overall line (regression: bug report)", () => {
    const result = parseEvaluationContent("## Overall: PASS");
    expect(result.outcome).toBe("pass");
    expect(result.rawLine).toBe("## Overall: PASS");
  });

  it("accepts H1 Overall line", () => {
    const result = parseEvaluationContent("# Overall: FAIL");
    expect(result.outcome).toBe("fail");
  });

  it("accepts H4-H6 Overall line", () => {
    expect(parseEvaluationContent("#### Overall: PASS").outcome).toBe("pass");
    expect(parseEvaluationContent("##### Overall: FAIL").outcome).toBe("fail");
    expect(parseEvaluationContent("###### Overall: PASS").outcome).toBe("pass");
  });

  it("accepts bold Overall line", () => {
    const result = parseEvaluationContent("**Overall: PASS**");
    expect(result.outcome).toBe("pass");
  });

  it("accepts plain-line Overall (no markdown)", () => {
    const result = parseEvaluationContent("Overall: FAIL");
    expect(result.outcome).toBe("fail");
  });

  it("accepts trailing decoration after verdict", () => {
    // Some models append emoji / extra punctuation after the verdict word.
    const result = parseEvaluationContent("### Overall: PASS ✅");
    expect(result.outcome).toBe("pass");
  });

  it("prefers the stricter (H3) pattern over looser alternatives", () => {
    // If both an H3 and a plain line exist, the H3 wins because it's
    // evaluated first. rawLine reflects which pattern matched.
    const content = `Overall: FAIL

### Overall: PASS`;
    const result = parseEvaluationContent(content);
    expect(result.outcome).toBe("pass");
    expect(result.rawLine).toBe("### Overall: PASS");
  });

  it("ignores Overall in code blocks (finds real one)", () => {
    const content = `Some text

### Overall: PASS

Done.`;
    const result = parseEvaluationContent(content);
    expect(result.outcome).toBe("pass");
  });

  it("finds Overall line among other content", () => {
    const content = `# Lots of stuff

Paragraph about things.

### Overall: FAIL

### Guidance
- Fix it`;

    const result = parseEvaluationContent(content);
    expect(result.outcome).toBe("fail");
  });
});

// ---------------------------------------------------------------------------
// parseEvaluation (from file)
// ---------------------------------------------------------------------------

describe("parseEvaluation", () => {
  it("reads and parses a PASS file", async () => {
    const dir = tmpPath();
    await mkdir(dir, { recursive: true });
    const file = join(dir, "eval.md");
    await writeFile(file, "### Overall: PASS\n", "utf-8");

    const result = await parseEvaluation(file);
    expect(result.outcome).toBe("pass");
  });

  it("reads and parses a FAIL file", async () => {
    const dir = tmpPath();
    await mkdir(dir, { recursive: true });
    const file = join(dir, "eval.md");
    await writeFile(file, "### Overall: FAIL\n", "utf-8");

    const result = await parseEvaluation(file);
    expect(result.outcome).toBe("fail");
  });

  it("returns parse_error for missing file", async () => {
    const result = await parseEvaluation("/nonexistent/eval.md");
    expect(result.outcome).toBe("parse_error");
    expect(result.error).toContain("Cannot read evaluation file");
  });
});
