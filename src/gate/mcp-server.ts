import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { loadState, saveState, statePath } from "../state.js";
import type { PipelineState } from "../state.js";

// ---------------------------------------------------------------------------
// Find the artifact dir — searches common locations
// ---------------------------------------------------------------------------

async function findArtifactDir(): Promise<string | null> {
  // Check environment variable first.
  if (process.env.CCCPR_ARTIFACT_DIR) {
    return process.env.CCCPR_ARTIFACT_DIR;
  }

  // Try current directory's common patterns.
  const cwd = process.cwd();
  const candidates = [
    cwd, // artifact dir itself
    resolve(cwd, "docs/projects"), // look for any state.json under here
  ];

  for (const dir of candidates) {
    const state = await loadState(dir);
    if (state) return dir;
  }

  return null;
}

// ---------------------------------------------------------------------------
// MCP server
// ---------------------------------------------------------------------------

export async function startMcpServer(): Promise<void> {
  const server = new McpServer({
    name: "cccpr-gate",
    version: "0.1.0",
  });

  // --- pipeline_status tool ---
  server.tool(
    "pipeline_status",
    "Get the current pipeline execution status, including stage progress and any pending gates.",
    {
      artifact_dir: z
        .string()
        .optional()
        .describe(
          "Path to the artifact directory containing .cccpr/state.json. " +
            "If omitted, searches common locations.",
        ),
    },
    async ({ artifact_dir }) => {
      const dir = artifact_dir ?? (await findArtifactDir());
      if (!dir) {
        return {
          content: [
            {
              type: "text" as const,
              text: "No pipeline state found. No pipeline is currently running, or set CCCPR_ARTIFACT_DIR.",
            },
          ],
        };
      }

      const state = await loadState(dir);
      if (!state) {
        return {
          content: [
            {
              type: "text" as const,
              text: "No state file found. No pipeline is currently running.",
            },
          ],
        };
      }

      return {
        content: [
          {
            type: "text" as const,
            text: formatStatus(state),
          },
        ],
      };
    },
  );

  // --- pipeline_gate_respond tool ---
  server.tool(
    "pipeline_gate_respond",
    "Approve or reject a pending human gate in the pipeline. " +
      "Use pipeline_status first to see if there is a pending gate.",
    {
      artifact_dir: z
        .string()
        .optional()
        .describe("Path to the artifact directory."),
      approved: z
        .boolean()
        .describe("Whether to approve (true) or reject (false) the gate."),
      feedback: z
        .string()
        .optional()
        .describe(
          "Optional feedback. On rejection, this is passed back to the generator for retry.",
        ),
    },
    async ({ artifact_dir, approved, feedback }) => {
      const dir = artifact_dir ?? (await findArtifactDir());
      if (!dir) {
        return {
          content: [
            {
              type: "text" as const,
              text: "No pipeline state found.",
            },
          ],
        };
      }

      const state = await loadState(dir);
      if (!state) {
        return {
          content: [
            {
              type: "text" as const,
              text: "No pipeline state found.",
            },
          ],
        };
      }

      if (!state.gate || state.gate.status !== "pending") {
        return {
          content: [
            {
              type: "text" as const,
              text: "No pending gate to respond to.",
            },
          ],
        };
      }

      state.gate.status = approved ? "approved" : "rejected";
      state.gate.feedback = feedback;
      state.gate.respondedAt = new Date().toISOString();
      await saveState(dir, state);

      return {
        content: [
          {
            type: "text" as const,
            text: `Gate "${state.gate.stageName}" ${approved ? "approved" : "rejected"}.${feedback ? ` Feedback: ${feedback}` : ""}`,
          },
        ],
      };
    },
  );

  // --- pipeline_logs tool ---
  server.tool(
    "pipeline_logs",
    "View recent pipeline activity logs.",
    {
      artifact_dir: z
        .string()
        .optional()
        .describe("Path to the artifact directory."),
      lines: z
        .number()
        .optional()
        .default(50)
        .describe("Number of recent log lines to return (default 50)."),
    },
    async ({ artifact_dir, lines }) => {
      const dir = artifact_dir ?? (await findArtifactDir());
      if (!dir) {
        return {
          content: [
            {
              type: "text" as const,
              text: "No pipeline state found.",
            },
          ],
        };
      }

      const state = await loadState(dir);
      if (!state) {
        return {
          content: [
            {
              type: "text" as const,
              text: "No pipeline state found.",
            },
          ],
        };
      }

      // Find the most recent stream log.
      const stateDirectory = resolve(dir, ".cccpr");
      const { readdir } = await import("node:fs/promises");
      let logContent = "No agent logs found.";

      try {
        const files = await readdir(stateDirectory);
        const logFiles = files
          .filter((f) => f.endsWith(".stream.jsonl"))
          .sort()
          .reverse();

        if (logFiles.length > 0) {
          const latestLog = resolve(stateDirectory, logFiles[0]);
          const raw = await readFile(latestLog, "utf-8");
          const allLines = raw.trim().split("\n");
          const recent = allLines.slice(-lines);
          logContent = `Latest log: ${logFiles[0]}\n\n${recent.join("\n")}`;
        }
      } catch {
        logContent = "Could not read log files.";
      }

      return {
        content: [{ type: "text" as const, text: logContent }],
      };
    },
  );

  // --- Start server ---
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// ---------------------------------------------------------------------------
// Format status for display
// ---------------------------------------------------------------------------

function formatStatus(state: PipelineState): string {
  const lines: string[] = [
    `Pipeline: ${state.pipeline}`,
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

    lines.push(`  ${icon} ${name}: ${s.status}${iterInfo}${duration}`);
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
