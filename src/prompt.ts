import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { TempFileTracker } from "./temp-tracker.js";

// ---------------------------------------------------------------------------
// Variable interpolation
// ---------------------------------------------------------------------------

/**
 * Replace `{variable_name}` and `{stage.key}` placeholders in a string with
 * values from the variables map. Unresolved placeholders are left as-is.
 */
export function interpolate(
  template: string,
  variables: Record<string, string>,
): string {
  return template.replace(/\{([\w.]+)\}/g, (match, key: string) => {
    return key in variables ? variables[key] : match;
  });
}

// ---------------------------------------------------------------------------
// Task body resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the task body for a stage. Reads from `task_file` if specified,
 * otherwise returns the inline `task` string, otherwise the fallback.
 *
 * Throws if both `task` and `task_file` are set on the same stage.
 */
export async function resolveTaskBody(
  stage: { task?: string; task_file?: string; name: string },
  variables: Record<string, string>,
  fallback: string,
): Promise<string> {
  if (stage.task && stage.task_file) {
    throw new Error(
      `Stage "${stage.name}": cannot specify both "task" and "task_file"`,
    );
  }
  if (stage.task_file) {
    const resolved = interpolate(stage.task_file, variables);
    return readFile(resolved, "utf-8");
  }
  const body = stage.task ?? fallback;
  return interpolate(body, variables);
}

// ---------------------------------------------------------------------------
// Agent markdown loading
// ---------------------------------------------------------------------------

/**
 * Read an agent's markdown definition from disk.
 *
 * Supports two patterns:
 * - **Flat file**: `agentPath` is a `.md` file → read it directly.
 * - **Directory agent with operation**: `agentPath` is a directory containing
 *   `agent.md`, and `operationFile` is a sibling `.md` in that directory.
 *   The result concatenates `agent.md` + `\n\n---\n\n` + operation file.
 */
export async function loadAgentMarkdown(
  agentPath: string,
  operationFile?: string,
): Promise<string> {
  const base = await readFile(agentPath, "utf-8");

  if (!operationFile) {
    return base;
  }

  const opContent = await readFile(operationFile, "utf-8");
  return `${base}\n\n---\n\n${opContent}`;
}

// ---------------------------------------------------------------------------
// Task context block
// ---------------------------------------------------------------------------

export interface TaskContext {
  /** What the agent should do. */
  task: string;
  /** Files the agent should read first. */
  inputs?: string[];
  /** Where the agent should write its output. */
  output?: string;
  /** Path to a previous evaluation (on retry iterations). */
  previousEvaluation?: string;
  /** Current iteration number (1-based). */
  iteration?: number;
  /** Max iterations allowed. */
  maxIterations?: number;
  /** Path to the contract file. */
  contractPath?: string;
  /** Path to a plan document containing the task reference. */
  planFile?: string;
  /** Path to a contract template the agent should follow. */
  contractTemplate?: string;
  /** Free-form guidance for the agent. */
  guidance?: string;
  /** Info about the deliverable the generator will produce. */
  deliverableInfo?: string;
  /** Path to the ground truth file (for autoresearch evaluation). */
  groundTruthPath?: string;
  /** Path to gate feedback file from a previous human review. */
  gateFeedback?: string;
  /** When true, appends the evaluator output format (### Overall: PASS/FAIL). */
  evaluatorFormat?: boolean;
  /** Additional key-value context. */
  extra?: Record<string, string>;
  /** Path where the agent should write structured outputs JSON. */
  outputsPath?: string;
  /** Declared output keys and their descriptions (for prompt injection). */
  outputKeys?: Record<string, string>;
}

/**
 * Build the user-prompt task context block that gets passed as the `-p` arg.
 */
export function buildTaskContext(ctx: TaskContext): string {
  const lines: string[] = [`# Task\n`, ctx.task, ""];

  if (ctx.planFile) {
    lines.push(
      `## Plan\n`,
      `Find the task described above in the plan document at: ${ctx.planFile}`,
      "",
    );
  }

  if (ctx.contractPath) {
    lines.push(`## Contract\n`, `Read the contract at: ${ctx.contractPath}`, "");
  }

  if (ctx.groundTruthPath) {
    lines.push(`## Ground Truth\n`, `Compare the output against the expected result at: ${ctx.groundTruthPath}`, "");
  }

  if (ctx.inputs?.length) {
    lines.push(`## Inputs\n`);
    for (const input of ctx.inputs) {
      lines.push(`- ${input}`);
    }
    lines.push("");
  }

  if (ctx.output) {
    lines.push(`## Output\n`, `Write your output to: ${ctx.output}`, "");
  }

  if (ctx.previousEvaluation) {
    lines.push(
      `## Previous Evaluation\n`,
      `Your previous attempt was evaluated. Read the feedback at: ${ctx.previousEvaluation}`,
      `Address all issues identified in the evaluation before producing your revised output.`,
      "",
    );
  }

  if (ctx.gateFeedback) {
    lines.push(
      `## Gate Feedback\n`,
      `A human reviewer provided feedback on a previous attempt. Read the feedback at: ${ctx.gateFeedback}`,
      `Address all issues identified in the gate feedback before producing your revised output.`,
      "",
    );
  }

  if (ctx.contractTemplate) {
    lines.push(
      `## Contract Template\n`,
      `Follow the structure in: ${ctx.contractTemplate}`,
      "",
    );
  }

  if (ctx.guidance) {
    lines.push(`## Guidance\n`, ctx.guidance, "");
  }

  if (ctx.deliverableInfo) {
    lines.push(`## Deliverable\n`, ctx.deliverableInfo, "");
  }

  if (ctx.iteration != null && ctx.maxIterations != null) {
    lines.push(
      `## Iteration\n`,
      `This is iteration ${ctx.iteration} of ${ctx.maxIterations}.`,
      "",
    );
  }

  if (ctx.evaluatorFormat) {
    lines.push(
      `## Evaluation Format\n`,
      `Your evaluation MUST end with exactly one of these lines:\n`,
      `### Overall: PASS\n`,
      `or\n`,
      `### Overall: FAIL\n`,
      `Use a criterion results table to justify your decision:\n`,
      `| # | Criterion | Result | Evidence |`,
      `|---|-----------|--------|----------|`,
      `| 1 | [name]    | PASS/FAIL | [specific evidence] |`,
      "",
    );
  }

  if (ctx.outputsPath && ctx.outputKeys && Object.keys(ctx.outputKeys).length > 0) {
    lines.push(`## Structured Outputs\n`);
    lines.push(`After completing your task, write a JSON file to: ${ctx.outputsPath}\n`);
    lines.push(`The JSON must be a flat object with these keys:\n`);
    for (const [key, desc] of Object.entries(ctx.outputKeys)) {
      lines.push(`- **${key}**: ${desc}`);
    }
    const example = Object.fromEntries(
      Object.keys(ctx.outputKeys).map((k) => [k, `<${k}>`]),
    );
    lines.push("", "Example:", "```json", JSON.stringify(example, null, 2), "```", "");
  }

  if (ctx.extra && Object.keys(ctx.extra).length > 0) {
    lines.push(`## Context\n`);
    for (const [k, v] of Object.entries(ctx.extra)) {
      lines.push(`- **${k}**: ${v}`);
    }
    lines.push("");
  }

  // Repeat task at the bottom so it sandwiches all context
  lines.push(`# Reminder: Your Task\n`, ctx.task, "");

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// System prompt file (temp file for --system-prompt-file)
// ---------------------------------------------------------------------------

/**
 * Write agent markdown to a temp file and return the path.
 * If a {@link TempFileTracker} is provided the path is registered for
 * automatic cleanup; otherwise the caller (or the OS) is responsible.
 */
export async function writeSystemPromptFile(
  agentMarkdown: string,
  tracker?: TempFileTracker,
): Promise<string> {
  const filePath = join(tmpdir(), `cccp-agent-${randomUUID()}.md`);
  await writeFile(filePath, agentMarkdown, "utf-8");
  tracker?.track(filePath);
  return filePath;
}
