import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { StreamParser } from "./stream/stream.js";
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
  onActivity?: (activity: import("./stream/stream.js").AgentActivity) => void;
  /** Claude config directory (CLAUDE_CONFIG_DIR). */
  claudeConfigDir?: string;
  /** Permission mode for the agent subprocess (default: bypassPermissions). */
  permissionMode?: string;
  /** Suppress agent stderr (when TUI dashboard is rendering). */
  quiet?: boolean;
}

// ---------------------------------------------------------------------------
// Build the claude CLI argument list
// ---------------------------------------------------------------------------

function buildArgs(opts: DispatchOptions): string[] {
  const args: string[] = [
    "-p",
    opts.userPrompt,
    "--append-system-prompt-file",
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

  // Permission mode — default to bypassPermissions for pipeline agents.
  const mode = opts.permissionMode ?? "bypassPermissions";
  args.push("--permission-mode", mode);

  return args;
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

/**
 * Dispatch an agent by spawning `claude` as a child process.
 *
 * Agents inherit the project's CLAUDE.md, hooks, and auth context.
 * The agent's markdown definition is appended via --append-system-prompt-file.
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
    if (opts.claudeConfigDir) {
      console.log(`  CLAUDE_CONFIG_DIR: ${opts.claudeConfigDir}`);
    }
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

  // Build environment — inherit parent env, set CLAUDE_CONFIG_DIR if configured.
  const env = { ...process.env };
  if (opts.claudeConfigDir) {
    env.CLAUDE_CONFIG_DIR = opts.claudeConfigDir;
  }

  const exitCode = await new Promise<number>((resolve, reject) => {
    const child = spawn("claude", args, {
      cwd: opts.cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    // Feed stdout through stream parser.
    child.stdout.on("data", (chunk: Buffer) => {
      parser.feed(chunk.toString());
    });

    // Stderr goes to parent stderr (unless TUI is active).
    if (!opts.quiet) {
      child.stderr.pipe(process.stderr);
    }

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
