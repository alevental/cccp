#!/usr/bin/env node

import { resolve } from "node:path";
import { getHeapStatistics } from "node:v8";
import { Command } from "commander";
import { loadProjectConfig } from "./config.js";
import { loadPipeline } from "./pipeline.js";
import { runPipeline } from "./runner.js";
import { buildRunContext, resolveArtifactDir, parseCLIVars } from "./context.js";

// Warn if heap limit is below 8 GB — long pipelines can exceed the default ~4 GB.
const heapLimitMb = Math.round(getHeapStatistics().heap_size_limit / 1024 / 1024);
if (heapLimitMb < 8000) {
  console.error(
    `[cccp] heap limit is ${heapLimitMb} MB. For long pipelines, increase with:\n` +
    `  NODE_OPTIONS="--max-old-space-size=8192" npx @alevental/cccp run ...`,
  );
}

const program = new Command();

program
  .name("cccp")
  .description(
    "Claude Code and Cmux Pipeline Reagent — deterministic YAML-based pipeline orchestration",
  )
  .version("0.5.1");

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

    const showTui = !opts.headless && !opts.dryRun;

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
      const result = await runPipeline(ctx, { existingState: initialState });

      // Brief pause for final render, then unmount.
      await new Promise((r) => setTimeout(r, 500));
      dashboard.unmount();

      process.exit(result.status === "passed" ? 0 : 1);
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

    console.log(
      `Resuming run ${existingState.runId.slice(0, 8)}: pipeline "${existingState.pipeline}", ` +
        `status "${existingState.status}", started ${existingState.startedAt}`,
    );

    const pipelineFile = resolve(existingState.pipelineFile);
    const pipeline = await loadPipeline(pipelineFile);

    const showTui = !opts.headless;

    const ctx = buildRunContext({
      project: opts.project,
      projectDir,
      pipelineFile,
      pipeline,
      artifactDir: existingState.artifactDir,
      projectConfig,
      headless: opts.headless,
      showTui,
    });

    if (showTui) {
      const { startDashboard } = await import("./tui/dashboard.js");

      const dashboard = startDashboard(existingState.runId, projectDir, existingState);
      const result = await runPipeline(ctx, { existingState });

      await new Promise((r) => setTimeout(r, 500));
      dashboard.unmount();

      process.exit(result.status === "passed" ? 0 : 1);
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
  .action(async (opts) => {
    const dashProjectDir = resolve(opts.projectDir ?? process.cwd());
    const { openDatabase } = await import("./db.js");
    const db = await openDatabase(dashProjectDir);
    const existingState = db.getRunByIdPrefix(opts.run);

    if (!existingState) {
      console.error(`No run matching "${opts.run}". Use \`cccp runs\` to list available runs.`);
      process.exit(1);
    }

    const { launchDashboard } = await import("./tui/dashboard.js");
    await launchDashboard(existingState.runId, dashProjectDir, existingState);
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

program.parse();
