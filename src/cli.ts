#!/usr/bin/env node

import { resolve } from "node:path";
import { Command } from "commander";
import { loadProjectConfig } from "./config.js";
import { loadPipeline } from "./pipeline.js";
import { runPipeline } from "./runner.js";
import { buildRunContext, resolveArtifactDir, parseCLIVars } from "./context.js";

const program = new Command();

program
  .name("cccp")
  .description(
    "Claude Code and Cmux Pipeline Reagent — deterministic YAML-based pipeline orchestration",
  )
  .version("0.10.3");

program
  .command("run")
  .description("Run a pipeline from a YAML definition")
  .requiredOption("-f, --file <path>", "Path to the pipeline YAML file")
  .requiredOption("-p, --project <name>", "Project name")
  .option(
    "-d, --project-dir <path>",
    "Project directory (defaults to cwd)",
  )
  .option(
    "-a, --artifact-dir <path>",
    "Artifact output directory (overrides cccp.yaml and default)",
  )
  .option("--dry-run", "Show assembled prompts without executing agents")
  .option("--headless", "Auto-approve all gates (no human interaction)")
  .option("--no-tui", "Disable the TUI dashboard")
  .option(
    "-v, --var <key=value...>",
    "Set pipeline variables (repeatable)",
  )
  .option(
    "--session-id <id>",
    "MCP session ID for gate notification routing",
  )
  .action(async (opts) => {
    const pipelineFile = resolve(opts.file);
    const projectDir = resolve(opts.projectDir ?? process.cwd());
    const projectConfig = await loadProjectConfig(projectDir);
    const pipeline = await loadPipeline(pipelineFile);

    let cliVars: Record<string, string>;
    try {
      cliVars = parseCLIVars(opts.var as string[] | undefined);
    } catch (err) {
      console.error((err as Error).message);
      process.exit(1);
    }

    const artifactDir = resolveArtifactDir({
      artifactDir: opts.artifactDir,
      projectDir,
      projectConfig,
      project: opts.project,
      pipelineName: pipeline.name,
    });

    const showTui = !opts.headless && opts.tui !== false && !opts.dryRun;

    const ctx = buildRunContext({
      project: opts.project,
      projectDir,
      pipelineFile,
      pipeline,
      artifactDir,
      projectConfig,
      dryRun: opts.dryRun,
      headless: opts.headless,
      showTui,
      cliVars,
      sessionId: opts.sessionId,
    });

    if (showTui) {
      const { createState, flattenStageEntries, saveState } = await import("./state.js");
      const { startDashboard } = await import("./tui/dashboard.js");

      // Create initial state so the dashboard has something to render.
      const initialState = createState(
        pipeline.name,
        opts.project,
        pipelineFile,
        flattenStageEntries(pipeline.stages),
        artifactDir,
        projectDir,
        opts.sessionId,
      );
      await saveState(initialState);

      // Start dashboard, then run pipeline. Dashboard watches state.json.
      const dashboard = startDashboard(initialState.runId, projectDir, initialState);
      let exitCode = 1;
      try {
        const result = await runPipeline(ctx, { existingState: initialState });
        exitCode = result.status === "passed" ? 0 : 1;
        // Brief pause for final render.
        await new Promise((r) => setTimeout(r, 500));
      } finally {
        dashboard.unmount();
      }

      process.exit(exitCode);
    } else {
      const result = await runPipeline(ctx);
      process.exit(result.status === "passed" ? 0 : 1);
    }
  });

program
  .command("resume")
  .description("Resume an interrupted pipeline run")
  .requiredOption("-p, --project <name>", "Project name")
  .requiredOption(
    "-r, --run <id-prefix>",
    "Run ID or prefix (8+ chars) to resume",
  )
  .option(
    "-d, --project-dir <path>",
    "Project directory (defaults to cwd)",
  )
  .option("--headless", "Auto-approve all gates")
  .option("--no-tui", "Disable the TUI dashboard")
  .option(
    "--session-id <id>",
    "MCP session ID for gate notification routing",
  )
  .option(
    "--from <stage>",
    "Clean-reset and resume from this named stage (resets it and all subsequent stages)",
  )
  .action(async (opts) => {
    const projectDir = resolve(opts.projectDir ?? process.cwd());
    const projectConfig = await loadProjectConfig(projectDir);

    const { openDatabase } = await import("./db.js");
    const db = await openDatabase(projectDir);
    const existingState = db.getRunByIdPrefix(opts.run);
    if (!existingState) {
      console.error(`No run matching "${opts.run}". Use \`cccp runs\` to list available runs.`);
      process.exit(1);
    }

    // --- Update session affinity for gate notifications ---
    if (opts.sessionId) {
      existingState.sessionId = opts.sessionId;
    }

    // --- Clean reset from a named stage ---
    if (opts.from) {
      const { resetFromStage } = await import("./state.js");
      try {
        const reset = await resetFromStage(existingState, opts.from);
        console.log(`Reset ${reset.length} stage(s): ${reset.join(", ")}`);
      } catch (err) {
        console.error((err as Error).message);
        process.exit(1);
      }
    }

    console.log(
      `Resuming run ${existingState.runId.slice(0, 8)}: pipeline "${existingState.pipeline}", ` +
        `status "${existingState.status}", started ${existingState.startedAt}`,
    );

    const pipelineFile = resolve(existingState.pipelineFile);
    const pipeline = await loadPipeline(pipelineFile);

    const showTui = !opts.headless && opts.tui !== false;

    const ctx = buildRunContext({
      project: opts.project,
      projectDir,
      pipelineFile,
      pipeline,
      artifactDir: existingState.artifactDir,
      projectConfig,
      headless: opts.headless,
      showTui,
      sessionId: opts.sessionId,
    });

    if (showTui) {
      const { startDashboard } = await import("./tui/dashboard.js");

      const dashboard = startDashboard(existingState.runId, projectDir, existingState);
      let exitCode = 1;
      try {
        const result = await runPipeline(ctx, { existingState });
        exitCode = result.status === "passed" ? 0 : 1;
        await new Promise((r) => setTimeout(r, 500));
      } finally {
        dashboard.unmount();
      }

      process.exit(exitCode);
    } else {
      const result = await runPipeline(ctx, { existingState });
      process.exit(result.status === "passed" ? 0 : 1);
    }
  });

program
  .command("dashboard")
  .description("Launch the TUI dashboard to monitor a running pipeline")
  .requiredOption(
    "-r, --run <id-prefix>",
    "Run ID or prefix (8+ chars) to monitor",
  )
  .option(
    "-d, --project-dir <path>",
    "Project directory (defaults to cwd)",
  )
  .option(
    "--scope <stage>",
    "Scope dashboard to a sub-pipeline stage",
  )
  .action(async (opts) => {
    const dashProjectDir = resolve(opts.projectDir ?? process.cwd());
    const { openDatabase } = await import("./db.js");
    const db = await openDatabase(dashProjectDir);
    const existingState = db.getRunByIdPrefix(opts.run);

    if (!existingState) {
      console.error(`No run matching "${opts.run}". Use \`cccp runs\` to list available runs.`);
      process.exit(1);
    }

    if (opts.scope) {
      const stageState = existingState.stages[opts.scope];
      if (!stageState) {
        console.error(`Stage "${opts.scope}" not found in run. Available: ${existingState.stageOrder.join(", ")}`);
        process.exit(1);
      }
      if (stageState.type !== "pipeline") {
        console.error(`Stage "${opts.scope}" is type "${stageState.type}", not "pipeline". --scope only works with sub-pipeline stages.`);
        process.exit(1);
      }
    }

    const { launchDashboard } = await import("./tui/dashboard.js");
    // When scoped, pass the parent state — the Dashboard extracts children internally.
    await launchDashboard(existingState.runId, dashProjectDir, existingState, opts.scope);
  });

program
  .command("mcp-server")
  .description(
    "Start the CCCP MCP server. Exposes pipeline runs, status, gate interaction, " +
      "logs, and artifacts. Register in .mcp.json for Claude Code integration.",
  )
  .action(async () => {
    const { startMcpServer } = await import("./mcp/mcp-server.js");
    await startMcpServer();
  });

program
  .command("init")
  .description("Scaffold a minimal cccp.yaml, example pipeline, and core agents")
  .option("-d, --dir <path>", "Directory to scaffold in (defaults to cwd)")
  .action(async (opts) => {
    const dir = resolve(opts.dir ?? process.cwd());
    const { scaffoldProject } = await import("./scaffold/index.js");
    await scaffoldProject(dir);
  });

program
  .command("update-skills")
  .description("Update /cccp-run and /cccp-pipeline skills to the latest version")
  .option("-d, --dir <path>", "Project directory (defaults to cwd)")
  .action(async (opts) => {
    const dir = resolve(opts.dir ?? process.cwd());
    const { scaffoldSkills } = await import("./scaffold/index.js");
    const count = await scaffoldSkills(dir);
    if (count > 0) {
      console.log(`Updated ${count} skill(s) in .claude/skills/`);
    } else {
      console.log("No skills to update.");
    }
  });

program
  .command("examples")
  .description("Scaffold the full set of template agents and example pipelines")
  .option("-d, --dir <path>", "Directory to scaffold in (defaults to cwd)")
  .option("--agents-only", "Scaffold agents only, no pipelines")
  .option("--pipelines-only", "Scaffold pipelines only, no agents")
  .action(async (opts) => {
    const dir = resolve(opts.dir ?? process.cwd());
    const { scaffoldExamples } = await import("./scaffold/index.js");
    await scaffoldExamples(dir, {
      agentsOnly: opts.agentsOnly,
      pipelinesOnly: opts.pipelinesOnly,
    });
  });

program
  .command("agent-monitor")
  .description("Launch a live monitor TUI for a single agent stream log")
  .requiredOption(
    "--stream-log <path>",
    "Path to the .stream.jsonl file to tail",
  )
  .option("--name <name>", "Agent name (derived from filename if omitted)")
  .action(async (opts) => {
    const streamLog = resolve(opts.streamLog);
    const agentName =
      opts.name ?? streamLog.split("/").pop()?.replace(/\.stream\.jsonl$/, "") ?? "agent";
    const { launchAgentMonitor } = await import("./tui/agent-monitor.js");
    await launchAgentMonitor(streamLog, agentName);
  });

// ---------------------------------------------------------------------------
// `cccp diag memory` — post-mortem analysis of .cccp/memory.jsonl
// ---------------------------------------------------------------------------

const diag = program
  .command("diag")
  .description("Diagnostics and post-mortem analysis tools");

diag
  .command("memory")
  .description("Summarize a .cccp/memory.jsonl sample log")
  .option("-f, --file <path>", "Path to memory.jsonl (default: ./.cccp/memory.jsonl)")
  .option("-p, --project <name>", "Project name (used with --pipeline to resolve artifact dir)")
  .option("--pipeline <name>", "Pipeline name (used with --project to resolve artifact dir)")
  .option("-d, --project-dir <path>", "Project directory (defaults to cwd)")
  .option("-r, --run <id-prefix>", "Filter to a specific run ID or prefix")
  .option("--since <dur>", "Only show samples from the last <dur> (e.g. 10m, 2h, 1d)")
  .option("--field <name>", "Numeric field for the sparkline (rss | heapUsed | arrayBuffers | external)", "rss")
  .option("--top <n>", "Top-N counters by growth", "10")
  .option("--width <cols>", "Sparkline width", "60")
  .action(async (opts) => {
    const { runDiag, defaultMemoryJsonlFor } = await import("./diagnostics/diag-memory.js");
    const { resolveArtifactDir } = await import("./context.js");
    const { loadProjectConfig } = await import("./config.js");

    let jsonlPath: string;
    if (opts.file) {
      jsonlPath = resolve(opts.file);
    } else if (opts.project && opts.pipeline) {
      const projectDir = resolve(opts.projectDir ?? process.cwd());
      const projectConfig = await loadProjectConfig(projectDir);
      const artifactDir = resolveArtifactDir({
        projectDir,
        projectConfig,
        project: opts.project,
        pipelineName: opts.pipeline,
      });
      jsonlPath = defaultMemoryJsonlFor(artifactDir);
    } else {
      jsonlPath = resolve(process.cwd(), ".cccp", "memory.jsonl");
    }

    const out = runDiag({
      jsonlPath,
      runId: opts.run,
      since: opts.since,
      field: opts.field,
      top: Number(opts.top),
      width: Number(opts.width),
    });
    console.log(out);
  });

program.parse();
