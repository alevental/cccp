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
// Regex patterns — tried in order from strictest → most lenient.
//
// The evaluator agent is instructed to end with `### Overall: PASS|FAIL`,
// but models occasionally drift (H2 instead of H3, bold instead of
// heading, no markdown formatting at all). Pre-v0.17.5 we accepted only
// the strict H3 form and errored the pipeline on any drift — losing
// hours of upstream work to a one-character typo. Now we try several
// permissive shapes so trivial format drift doesn't kill the run. The
// strict form remains the documented contract and the only one we emit
// in our own templates.
// ---------------------------------------------------------------------------

const OVERALL_PATTERNS: RegExp[] = [
  // 1. H1..H6 heading: "### Overall: PASS" (any heading level)
  /^#{1,6}\s+Overall:\s*(PASS|FAIL)\s*$/m,
  // 2. Bold: "**Overall: PASS**"
  /^\s*\*\*\s*Overall:\s*(PASS|FAIL)\s*\*\*\s*$/m,
  // 3. Plain line: "Overall: PASS"
  /^\s*Overall:\s*(PASS|FAIL)\s*$/m,
  // 4. Trailing-content variants — scan the last line(s) for a verdict
  //    alongside extra characters (e.g., "### Overall: PASS ✅").
  /^#{1,6}\s+Overall:\s*(PASS|FAIL)\b.*$/m,
];

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
 * Tries progressively more permissive patterns to tolerate minor format drift.
 */
export function parseEvaluationContent(content: string): EvaluationResult {
  for (const re of OVERALL_PATTERNS) {
    const match = re.exec(content);
    if (match) {
      const verdict = match[1].toLowerCase() as "pass" | "fail";
      return {
        outcome: verdict,
        rawLine: match[0].trimEnd(),
        content,
      };
    }
  }

  return {
    outcome: "parse_error",
    content,
    error:
      'Evaluation file does not contain a valid "Overall: PASS" or "Overall: FAIL" verdict line (expected "### Overall: PASS" or "### Overall: FAIL").',
  };
}
