import { describe, it, expect } from "vitest";
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { parseEvaluation, parseEvaluationContent } from "../src/evaluator.js";

function tmpPath() {
  return join(tmpdir(), `cccpr-test-${randomUUID()}`);
}

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

  it("ignores Overall in wrong heading level", () => {
    const result = parseEvaluationContent("## Overall: PASS");
    expect(result.outcome).toBe("parse_error");
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
