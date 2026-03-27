import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { openDatabase } from "./db.js";
import {
  loadState,
  saveState,
  discoverRuns,
  type PipelineState,
  type DiscoveredRun,
} from "./state.js";

// ---------------------------------------------------------------------------
// Run resolution
// ---------------------------------------------------------------------------

async function resolveRun(
  runIdPrefix?: string,
): Promise<{ run: DiscoveredRun } | { error: string }> {
  const projectDir = process.cwd();
  // Reload DB from disk — the runner (separate process) may have written new state.
  const db = await openDatabase(projectDir);
  db.reload();
  const runs = await discoverRuns(projectDir);

  if (runs.length === 0) {
    return { error: "No pipeline runs found. Start one with `cccp run`." };
  }

  if (!runIdPrefix) {
    if (runs.length === 1) {
      return { run: runs[0] };
    }
    const listing = formatRunList(runs);
    return {
      error: `${runs.length} runs found. Specify run_id to select one.\n\n${listing}`,
    };
  }

  const matches = runs.filter((r) =>
    r.state.runId.startsWith(runIdPrefix),
  );

  if (matches.length === 0) {
    return { error: `No run matching "${runIdPrefix}".` };
  }
  if (matches.length > 1) {
    return {
      error: `Ambiguous run_id "${runIdPrefix}" matches ${matches.length} runs. Use more characters.`,
    };
  }

  return { run: matches[0] };
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function formatRunList(runs: DiscoveredRun[]): string {
  const lines: string[] = ["Runs:"];

  for (const { state } of runs) {
    const short = state.runId.slice(0, 8);
    const gate = state.gate?.status === "pending"
      ? ` | GATE: ${state.gate.stageName}`
      : "";
    lines.push(
      `  ${short}  ${state.pipeline} (${state.project})  ${state.status}${gate}  ${state.startedAt}`,
    );
  }

  return lines.join("\n");
}

function formatStatus(state: PipelineState): string {
  const short = state.runId.slice(0, 8);
  const lines: string[] = [
    `Pipeline: ${state.pipeline} (run ${short})`,
    `Project: ${state.project}`,
    `Status: ${state.status}`,
    `Started: ${state.startedAt}`,
  ];

  if (state.completedAt) {
    lines.push(`Completed: ${state.completedAt}`);
  }

  lines.push("", "Stages:");

  for (const name of state.stageOrder) {
    const s = state.stages[name];
    const icon =
      s.status === "passed"
        ? "✓"
        : s.status === "failed" || s.status === "error"
          ? "✗"
          : s.status === "in_progress"
            ? "⚙"
            : s.status === "skipped"
              ? "⏭"
              : "○";
    const iterInfo =
      s.type === "pge" && s.iteration
        ? ` (iter ${s.iteration})`
        : "";
    const duration =
      s.durationMs != null
        ? ` ${(s.durationMs / 1000).toFixed(1)}s`
        : "";
    const artifacts = s.artifacts
      ? ` [${Object.keys(s.artifacts).join(", ")}]`
      : "";

    lines.push(
      `  ${icon} ${name}: ${s.status}${iterInfo}${duration}${artifacts}`,
    );
  }

  if (state.gate) {
    lines.push("");
    lines.push(`Gate: ${state.gate.stageName} — ${state.gate.status}`);
    if (state.gate.prompt) {
      lines.push(`  Prompt: ${state.gate.prompt}`);
    }
    if (state.gate.feedback) {
      lines.push(`  Feedback: ${state.gate.feedback}`);
    }
  }

  return lines.join("\n");
}

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

// ---------------------------------------------------------------------------
// MCP server
// ---------------------------------------------------------------------------

export async function startMcpServer(): Promise<void> {
  const server = new McpServer({
    name: "cccp",
    version: "0.1.0",
  });

  // --- cccp_runs ---
  server.tool(
    "cccp_runs",
    "List all pipeline runs (active and completed). Shows run ID, pipeline name, project, status, and any pending gates.",
    {},
    async () => {
      const runs = await discoverRuns(process.cwd());

      if (runs.length === 0) {
        return textResult("No pipeline runs found.");
      }

      return textResult(formatRunList(runs));
    },
  );

  // --- cccp_status ---
  server.tool(
    "cccp_status",
    "Get detailed status for a pipeline run — stages, iterations, artifacts, and pending gates. If only one run exists, it is selected automatically.",
    {
      run_id: z
        .string()
        .optional()
        .describe("Run ID prefix (8+ chars). Omit if only one run exists."),
    },
    async ({ run_id }) => {
      const result = await resolveRun(run_id);
      if ("error" in result) return textResult(result.error);

      return textResult(formatStatus(result.run.state));
    },
  );

  // --- cccp_gate_respond ---
  server.tool(
    "cccp_gate_respond",
    "Approve or reject a pending human gate. Use cccp_runs or cccp_status first to see pending gates.",
    {
      run_id: z
        .string()
        .optional()
        .describe("Run ID prefix (8+ chars). Omit if only one run exists."),
      approved: z
        .boolean()
        .describe("Whether to approve (true) or reject (false) the gate."),
      feedback: z
        .string()
        .optional()
        .describe("Optional feedback. On rejection, passed to the generator for retry."),
    },
    async ({ run_id, approved, feedback }) => {
      const result = await resolveRun(run_id);
      if ("error" in result) return textResult(result.error);

      const { artifactDir, state } = result.run;

      if (!state.gate || state.gate.status !== "pending") {
        return textResult("No pending gate on this run.");
      }

      state.gate.status = approved ? "approved" : "rejected";
      state.gate.feedback = feedback;
      state.gate.respondedAt = new Date().toISOString();
      await saveState(artifactDir, state);

      const action = approved ? "approved" : "rejected";
      return textResult(
        `Gate "${state.gate.stageName}" ${action}.${feedback ? ` Feedback: ${feedback}` : ""}`,
      );
    },
  );

  // --- cccp_logs ---
  server.tool(
    "cccp_logs",
    "View recent agent activity logs for a pipeline run.",
    {
      run_id: z
        .string()
        .optional()
        .describe("Run ID prefix (8+ chars). Omit if only one run exists."),
      lines: z
        .number()
        .optional()
        .default(50)
        .describe("Number of recent log lines (default 50)."),
    },
    async ({ run_id, lines }) => {
      const result = await resolveRun(run_id);
      if ("error" in result) return textResult(result.error);

      const cccpDir = resolve(result.run.artifactDir, ".cccp");
      let logContent = "No agent logs found.";

      try {
        const files = await readdir(cccpDir);
        const logFiles = files
          .filter((f) => f.endsWith(".stream.jsonl"))
          .sort()
          .reverse();

        if (logFiles.length > 0) {
          const latestLog = resolve(cccpDir, logFiles[0]);
          const raw = await readFile(latestLog, "utf-8");
          const allLines = raw.trim().split("\n");
          const recent = allLines.slice(-lines);
          logContent = `Log: ${logFiles[0]} (${allLines.length} total lines)\n\n${recent.join("\n")}`;
        }
      } catch {
        logContent = "Could not read log files.";
      }

      return textResult(logContent);
    },
  );

  // --- cccp_artifacts ---
  server.tool(
    "cccp_artifacts",
    "List or read artifacts produced by a pipeline run.",
    {
      run_id: z
        .string()
        .optional()
        .describe("Run ID prefix (8+ chars). Omit if only one run exists."),
      read: z
        .string()
        .optional()
        .describe("Artifact key or file path to read. Omit to list all artifacts."),
    },
    async ({ run_id, read }) => {
      const result = await resolveRun(run_id);
      if ("error" in result) return textResult(result.error);

      const { state, artifactDir } = result.run;

      // Collect all artifacts across stages.
      const allArtifacts: Array<{ stage: string; key: string; path: string }> = [];
      for (const name of state.stageOrder) {
        const stage = state.stages[name];
        if (stage.artifacts) {
          for (const [key, path] of Object.entries(stage.artifacts)) {
            allArtifacts.push({ stage: name, key, path });
          }
        }
      }

      if (!read) {
        // List mode.
        if (allArtifacts.length === 0) {
          return textResult("No artifacts recorded for this run.");
        }

        const lines = [`Artifacts for run ${state.runId.slice(0, 8)}:`, ""];
        for (const a of allArtifacts) {
          lines.push(`  [${a.stage}] ${a.key}: ${a.path}`);
        }
        return textResult(lines.join("\n"));
      }

      // Read mode — find by key or path.
      const match = allArtifacts.find(
        (a) => a.key === read || a.path === read || a.path.endsWith(read),
      );

      if (!match) {
        // Try reading as a direct path relative to artifact dir.
        try {
          const content = await readFile(resolve(artifactDir, read), "utf-8");
          return textResult(content);
        } catch {
          return textResult(`Artifact "${read}" not found.`);
        }
      }

      try {
        const content = await readFile(match.path, "utf-8");
        return textResult(`${match.key} (${match.stage}):\n\n${content}`);
      } catch {
        return textResult(`Could not read artifact at ${match.path}`);
      }
    },
  );

  // --- Start server ---
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
