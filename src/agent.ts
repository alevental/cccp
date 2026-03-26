import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { StreamParser } from "./stream.js";
import type { AgentResult } from "./types.js";

// ---------------------------------------------------------------------------
// Agent dispatch options
// ---------------------------------------------------------------------------

export interface DispatchOptions {
  /** The user prompt (task context) passed via -p. */
  userPrompt: string;
  /** Path to the system prompt file (agent markdown). */
  systemPromptFile: string;
  /** Path to MCP config JSON file, if any. */
  mcpConfigFile?: string;
  /** Explicit list of allowed tools. */
  allowedTools?: string[];
  /** Expected output file path (to check existence after). */
  expectedOutput?: string;
  /** Working directory for the subprocess. */
  cwd: string;
  /** If true, print the command instead of running it. */
  dryRun?: boolean;
  /** Agent name (for stream logging). */
  agentName?: string;
  /** Directory for stream log files (.stream.jsonl). */
  streamLogDir?: string;
  /** Callback for stream activity updates. */
  onActivity?: (activity: import("./stream.js").AgentActivity) => void;
}

// ---------------------------------------------------------------------------
// Build the claude CLI argument list
// ---------------------------------------------------------------------------

function buildArgs(opts: DispatchOptions): string[] {
  const args: string[] = [
    "--bare",
    "-p",
    opts.userPrompt,
    "--system-prompt-file",
    opts.systemPromptFile,
    "--output-format",
    "stream-json",
    "--verbose",
  ];

  if (opts.mcpConfigFile) {
    args.push("--mcp-config", opts.mcpConfigFile);
    args.push("--strict-mcp-config");
  }

  if (opts.allowedTools?.length) {
    args.push("--allowedTools", opts.allowedTools.join(","));
  }

  return args;
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

/**
 * Dispatch an agent by spawning `claude` as a child process.
 *
 * Returns an AgentResult with exit code, output existence check, and duration.
 * In dry-run mode, prints the command and returns a synthetic success result.
 */
export async function dispatchAgent(
  opts: DispatchOptions,
): Promise<AgentResult> {
  const args = buildArgs(opts);

  if (opts.dryRun) {
    console.log("\n[dry-run] Would execute:");
    console.log(`  claude ${args.map((a) => (a.includes(" ") ? `"${a}"` : a)).join(" ")}`);
    console.log(`  cwd: ${opts.cwd}`);
    if (opts.expectedOutput) {
      console.log(`  expected output: ${opts.expectedOutput}`);
    }
    return {
      exitCode: 0,
      outputPath: opts.expectedOutput,
      outputExists: false,
      durationMs: 0,
    };
  }

  const start = Date.now();
  const agentName = opts.agentName ?? "agent";

  // Set up stream parser for event processing and logging.
  const parser = new StreamParser(agentName);
  if (opts.streamLogDir) {
    const logPath = `${opts.streamLogDir}/${agentName}.stream.jsonl`;
    await parser.startLog(logPath);
  }
  if (opts.onActivity) {
    parser.on("activity", opts.onActivity);
  }

  const exitCode = await new Promise<number>((resolve, reject) => {
    const child = spawn("claude", args, {
      cwd: opts.cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });

    // Feed stdout through stream parser.
    child.stdout.on("data", (chunk: Buffer) => {
      parser.feed(chunk.toString());
    });

    // Stderr goes to parent stderr.
    child.stderr.pipe(process.stderr);

    child.on("error", (err) => {
      parser.flush();
      reject(new Error(`Failed to spawn claude: ${err.message}`));
    });

    child.on("close", (code) => {
      parser.flush();
      resolve(code ?? 1);
    });
  });

  const durationMs = Date.now() - start;

  let outputExists = false;
  if (opts.expectedOutput) {
    try {
      await access(opts.expectedOutput);
      outputExists = true;
    } catch {
      outputExists = false;
    }
  }

  return {
    exitCode,
    outputPath: opts.expectedOutput,
    outputExists,
    durationMs,
  };
}
