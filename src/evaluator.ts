import { readFile } from "node:fs/promises";

// ---------------------------------------------------------------------------
// Evaluation outcome
// ---------------------------------------------------------------------------

export type EvaluationOutcome = "pass" | "fail" | "parse_error";

export interface EvaluationResult {
  outcome: EvaluationOutcome;
  /** Raw text of the Overall line, if found. */
  rawLine?: string;
  /** Full evaluation file content (for logging/debugging). */
  content?: string;
  /** Error message when outcome is parse_error. */
  error?: string;
}

// ---------------------------------------------------------------------------
// Regex — matches the exact format from the evaluation template
// ---------------------------------------------------------------------------

const OVERALL_RE = /^###\s+Overall:\s*(PASS|FAIL)\s*$/m;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parse an evaluation file and extract the Overall PASS/FAIL verdict.
 *
 * Returns:
 * - `pass` if `### Overall: PASS` is found
 * - `fail` if `### Overall: FAIL` is found
 * - `parse_error` if the file can't be read or the Overall line is missing/malformed
 */
export async function parseEvaluation(
  evaluationPath: string,
): Promise<EvaluationResult> {
  let content: string;
  try {
    content = await readFile(evaluationPath, "utf-8");
  } catch (err) {
    return {
      outcome: "parse_error",
      error: `Cannot read evaluation file: ${evaluationPath}`,
    };
  }

  return parseEvaluationContent(content);
}

/**
 * Parse evaluation content directly (useful for testing without filesystem).
 */
export function parseEvaluationContent(content: string): EvaluationResult {
  const match = OVERALL_RE.exec(content);

  if (!match) {
    return {
      outcome: "parse_error",
      content,
      error:
        'Evaluation file does not contain a valid "### Overall: PASS" or "### Overall: FAIL" line',
    };
  }

  const verdict = match[1].toLowerCase() as "pass" | "fail";

  return {
    outcome: verdict,
    rawLine: match[0].trimEnd(),
    content,
  };
}
