import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { writeFeedbackArtifact } from "../gate/feedback-artifact.js";
import { GateNotifier } from "./gate-notifier.js";
import { DbService } from "../db-service.js";
import { loadState, saveState, setStageArtifact, discoverRuns } from "../state.js";
import type { PipelineState, DiscoveredRun } from "../types.js";

// ---------------------------------------------------------------------------
// Run resolution
// ---------------------------------------------------------------------------

/** Module-level DbService — initialised in startMcpServer(). */
let dbService: DbService;

async function resolveRun(
  runIdPrefix?: string,
): Promise<{ run: DiscoveredRun } | { error: string }> {
  const projectDir = process.cwd();
  // WAL mode: readers see committed writes immediately, no manual reload needed.
  dbService.db();
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
  // Generate a unique session ID for this MCP server instance.
  // Used for gate notification routing — only gates from runs started
  // with this session ID (via --session-id on cccp run) will trigger
  // notifications in this session.
  const sessionId = randomUUID();
  const projectDir = process.cwd();

  const server = new McpServer({
    name: "cccp",
    version: "0.1.0",
  }, {
    capabilities: {
      experimental: { "claude/channel": {} },
    },
  });

  // --- cccp_session_id ---
  server.tool(
    "cccp_session_id",
    "Get this MCP server's session ID. Pass this as --session-id when running pipelines so gate notifications route to this session.",
    {},
    async () => textResult(sessionId),
  );

  // --- cccp_runs ---
  server.tool(
    "cccp_runs",
    "List all pipeline runs (active and completed). Shows run ID, pipeline name, project, status, and any pending gates.",
    {},
    async () => {
      dbService.db();
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
    "Approve or reject a pending human gate. Use cccp_runs or cccp_status first to see pending gates. On rejection with feedback, the feedback is written as a numbered markdown artifact and passed to the generator for retry.",
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
        .describe("Optional feedback (markdown). Written as an artifact and passed to the generator on retry."),
      feedback_file: z
        .string()
        .optional()
        .describe("Path to a markdown file with detailed feedback. Takes precedence over inline feedback."),
    },
    async ({ run_id, approved, feedback, feedback_file }) => {
      const result = await resolveRun(run_id);
      if ("error" in result) return textResult(result.error);

      const { artifactDir, state } = result.run;

      if (!state.gate || state.gate.status !== "pending") {
        return textResult("No pending gate on this run.");
      }

      // Resolve feedback content: feedback_file takes precedence.
      let feedbackContent = feedback;
      if (feedback_file) {
        try {
          feedbackContent = await readFile(resolve(feedback_file), "utf-8");
        } catch (err) {
          return textResult(`Could not read feedback file: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      state.gate.status = approved ? "approved" : "rejected";
      state.gate.feedback = feedbackContent;
      state.gate.respondedAt = new Date().toISOString();

      // Write feedback as a numbered artifact file.
      if (feedbackContent) {
        const feedbackPath = await writeFeedbackArtifact(
          artifactDir, state.gate.stageName, feedbackContent, approved,
        );
        state.gate.feedbackPath = feedbackPath;
        setStageArtifact(state, state.gate.stageName, `gate-feedback`, feedbackPath);
      }

      await saveState(state);

      const action = approved ? "approved" : "rejected";
      const feedbackNote = state.gate.feedbackPath
        ? ` Feedback artifact: ${state.gate.feedbackPath}`
        : feedbackContent ? ` Feedback: ${feedbackContent}` : "";
      return textResult(
        `Gate "${state.gate.stageName}" ${action}.${feedbackNote}`,
      );
    },
  );

  // --- cccp_pause ---
  server.tool(
    "cccp_pause",
    "Request a running pipeline to pause at the next clean breakpoint (between stages). The pipeline will finish its current stage and stop. Resume later with `cccp resume`.",
    {
      run_id: z
        .string()
        .optional()
        .describe("Run ID prefix (8+ chars). Omit if only one run exists."),
    },
    async ({ run_id }) => {
      const result = await resolveRun(run_id);
      if ("error" in result) return textResult(result.error);

      const { state } = result.run;

      if (state.status !== "running") {
        return textResult(
          `Cannot pause: pipeline is "${state.status}", not running.`,
        );
      }

      const db = dbService.db();
      db.setPauseRequested(state.runId, true);

      const short = state.runId.slice(0, 8);
      return textResult(
        `Pause requested for run ${short}. The pipeline will pause after the current stage completes.`,
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
      } catch (err) {
        logContent = `Could not read log files: ${err instanceof Error ? err.message : String(err)}`;
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
        } catch (err) {
          return textResult(`Artifact "${read}" not found: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      try {
        const content = await readFile(match.path, "utf-8");
        return textResult(`${match.key} (${match.stage}):\n\n${content}`);
      } catch (err) {
        return textResult(`Could not read artifact at ${match.path}: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  );

  // --- cccp_handoff_ack ---
  server.tool(
    "cccp_handoff_ack",
    "Acknowledge a pending pipeline_handoff gate after you've launched the next pipeline. Records the new run id and target pane on the handoff payload and transitions the gate to approved. Use cccp_gate_review or cccp_status first to see the handoff target.",
    {
      run_id: z
        .string()
        .optional()
        .describe("Run ID prefix (8+ chars) of the pipeline with the pending handoff. Omit if only one run exists."),
      launched_run_id: z
        .string()
        .optional()
        .describe("Run id of the pipeline you just launched (if known)."),
      target_pane: z
        .string()
        .optional()
        .describe("cmux pane/surface where the new pipeline is running."),
      note: z
        .string()
        .optional()
        .describe("Optional note recorded as gate feedback artifact."),
    },
    async ({ run_id, launched_run_id, target_pane, note }) => {
      const result = await resolveRun(run_id);
      if ("error" in result) return textResult(result.error);

      const { artifactDir, state } = result.run;

      if (!state.gate || state.gate.status !== "pending") {
        return textResult("No pending gate on this run.");
      }
      if (state.gate.kind !== "pipeline_handoff" || !state.gate.handoff) {
        return textResult(
          `Gate "${state.gate.stageName}" is not a pipeline_handoff gate. Use cccp_gate_respond instead.`,
        );
      }

      state.gate.handoff.launchedRunId = launched_run_id || undefined;
      state.gate.handoff.targetPane = target_pane || undefined;
      state.gate.status = "approved";
      state.gate.feedback = note || undefined;
      state.gate.respondedAt = new Date().toISOString();

      if (note) {
        const feedbackPath = await writeFeedbackArtifact(
          artifactDir, state.gate.stageName, note, true,
        );
        state.gate.feedbackPath = feedbackPath;
        setStageArtifact(state, state.gate.stageName, "gate-feedback", feedbackPath);
      }
      if (launched_run_id) {
        setStageArtifact(state, state.gate.stageName, "handoff-launched-run", launched_run_id);
      }
      if (target_pane) {
        setStageArtifact(state, state.gate.stageName, "handoff-target-pane", target_pane);
      }

      await saveState(state);

      const lines = [`Handoff "${state.gate.stageName}" acknowledged.`];
      if (launched_run_id) lines.push(`  launched_run_id: ${launched_run_id}`);
      if (target_pane) lines.push(`  target_pane: ${target_pane}`);
      if (state.gate.feedbackPath) lines.push(`  note artifact: ${state.gate.feedbackPath}`);
      return textResult(lines.join("\n"));
    },
  );

  // --- cccp_gate_review ---
  server.tool(
    "cccp_gate_review",
    "Get comprehensive gate review context: pending gate info, stage artifacts, evaluation history, and contract. Use this before responding to a gate to have an informed discussion with the user.",
    {
      run_id: z
        .string()
        .optional()
        .describe("Run ID prefix (8+ chars). Omit if only one run exists."),
    },
    async ({ run_id }) => {
      const result = await resolveRun(run_id);
      if ("error" in result) return textResult(result.error);

      const { state, artifactDir } = result.run;

      if (!state.gate || state.gate.status !== "pending") {
        return textResult("No pending gate on this run.");
      }

      const gate = state.gate;
      const stageName = gate.stageName;
      const stageState = state.stages[stageName];

      const kindLabel =
        gate.kind === "pipeline_handoff" ? "pipeline_handoff" :
        gate.kind === "agent_eval" ? "agent_eval (addressed to the Claude Code session — decide autonomously, do not ask the user)" :
        "human";

      const lines: string[] = [
        `# Gate Review: ${stageName}`,
        "",
        `**Run**: ${state.runId.slice(0, 8)} (${state.pipeline})`,
        `**Stage**: ${stageName} (type: ${stageState?.type ?? "unknown"})`,
        `**Kind**: ${kindLabel}`,
        `**Prompt**: ${gate.prompt ?? "(none)"}`,
        "",
      ];

      // Surface the handoff payload prominently — this is what the
      // orchestrator needs to act on.
      if (gate.kind === "pipeline_handoff" && gate.handoff) {
        const h = gate.handoff;
        lines.push("## Handoff", "");
        lines.push(`- **Next file**: ${h.next.file}`);
        if (h.next.project) lines.push(`- **Project**: ${h.next.project}`);
        if (h.next.sessionId) lines.push(`- **Session ID**: ${h.next.sessionId}`);
        if (h.next.variables && Object.keys(h.next.variables).length > 0) {
          lines.push(`- **Variables**:`);
          for (const [k, v] of Object.entries(h.next.variables)) {
            lines.push(`  - ${k}: ${v}`);
          }
        }
        lines.push(`- **cmux target**: ${h.cmux.target}`);
        if (h.cmux.workspace) lines.push(`- **cmux workspace**: ${h.cmux.workspace}`);
        if (h.cmux.surface) lines.push(`- **cmux surface**: ${h.cmux.surface}`);
        if (h.cmux.label) lines.push(`- **cmux label**: ${h.cmux.label}`);
        lines.push("", "Launch the next pipeline in the indicated target, then call `cccp_handoff_ack` with the new run id.", "");
      }

      // Stage artifacts
      if (stageState?.artifacts && Object.keys(stageState.artifacts).length > 0) {
        lines.push("## Artifacts", "");
        for (const [key, path] of Object.entries(stageState.artifacts)) {
          lines.push(`- **${key}**: ${path}`);
        }
        lines.push("");
      }

      // Read key artifacts inline for context
      const inlineArtifacts = ["contract", "deliverable", "task-plan"];
      for (const key of inlineArtifacts) {
        const path = stageState?.artifacts?.[key];
        if (!path) continue;
        try {
          const content = await readFile(path, "utf-8");
          const truncated = content.length > 2000
            ? content.slice(0, 2000) + "\n\n... (truncated, use cccp_artifacts to read full content)"
            : content;
          lines.push(`## ${key}`, "", "```", truncated, "```", "");
        } catch {
          // File may not exist or be unreadable
        }
      }

      // Latest evaluation
      if (stageState?.artifacts) {
        const evalKeys = Object.keys(stageState.artifacts)
          .filter((k) => k.startsWith("evaluation-"))
          .sort();
        const latestEvalKey = evalKeys[evalKeys.length - 1];
        if (latestEvalKey) {
          const evalPath = stageState.artifacts[latestEvalKey];
          try {
            const evalContent = await readFile(evalPath, "utf-8");
            const truncated = evalContent.length > 2000
              ? evalContent.slice(0, 2000) + "\n\n... (truncated)"
              : evalContent;
            lines.push(`## Latest Evaluation (${latestEvalKey})`, "", "```", truncated, "```", "");
          } catch {
            // ignore
          }
        }
      }

      // Iteration info
      if (stageState?.iteration) {
        lines.push(`## Iteration History`, "");
        lines.push(`Current iteration: ${stageState.iteration}`);
        lines.push(`Last step: ${stageState.pgeStep ?? "unknown"}`);
        lines.push("");
      }

      // Pipeline stage overview
      lines.push("## Pipeline Status", "");
      for (const name of state.stageOrder) {
        const s = state.stages[name];
        const icon =
          s.status === "passed" ? "✓" :
          s.status === "failed" || s.status === "error" ? "✗" :
          s.status === "in_progress" ? "⚙" :
          s.status === "skipped" ? "⏭" : "○";
        lines.push(`  ${icon} ${name}: ${s.status}`);
      }

      return textResult(lines.join("\n"));
    },
  );

  // --- Start DB service and server ---
  dbService = new DbService({ projectDir });
  dbService.start();

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // --- Start gate notifier ---
  const notifier = new GateNotifier({
    server,
    projectDir,
    sessionId,
    dbService,
  });
  notifier.start();

  // --- Shutdown cleanup ---
  const shutdown = () => {
    notifier.stop();
    dbService.stop();
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}
