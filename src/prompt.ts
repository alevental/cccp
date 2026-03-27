import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// Variable interpolation
// ---------------------------------------------------------------------------

/**
 * Replace `{variable_name}` placeholders in a string with values from the
 * variables map. Unresolved placeholders are left as-is.
 */
export function interpolate(
  template: string,
  variables: Record<string, string>,
): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => {
    return key in variables ? variables[key] : match;
  });
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
  /** Additional key-value context. */
  extra?: Record<string, string>;
}

/**
 * Build the user-prompt task context block that gets passed as the `-p` arg.
 */
export function buildTaskContext(ctx: TaskContext): string {
  const lines: string[] = [`# Task\n`, ctx.task, ""];

  if (ctx.contractPath) {
    lines.push(`## Contract\n`, `Read the contract at: ${ctx.contractPath}`, "");
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

  if (ctx.iteration != null && ctx.maxIterations != null) {
    lines.push(
      `## Iteration\n`,
      `This is iteration ${ctx.iteration} of ${ctx.maxIterations}.`,
      "",
    );
  }

  if (ctx.extra && Object.keys(ctx.extra).length > 0) {
    lines.push(`## Context\n`);
    for (const [k, v] of Object.entries(ctx.extra)) {
      lines.push(`- **${k}**: ${v}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// System prompt file (temp file for --system-prompt-file)
// ---------------------------------------------------------------------------

/**
 * Write agent markdown to a temp file and return the path.
 * The caller is responsible for cleanup (or let the OS handle it).
 */
export async function writeSystemPromptFile(
  agentMarkdown: string,
): Promise<string> {
  const filePath = join(tmpdir(), `cccp-agent-${randomUUID()}.md`);
  await writeFile(filePath, agentMarkdown, "utf-8");
  return filePath;
}
