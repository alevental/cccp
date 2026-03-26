#!/usr/bin/env node

import { resolve, dirname } from "node:path";
import { writeFile, mkdir } from "node:fs/promises";
import { Command } from "commander";
import { loadProjectConfig } from "./config.js";
import { AutoApproveStrategy } from "./gate/auto-approve.js";
import { FilesystemGateStrategy } from "./gate/gate-watcher.js";
import type { GateStrategy } from "./gate/gate-strategy.js";
import { loadPipeline } from "./pipeline.js";
import { interpolate } from "./prompt.js";
import { runPipeline } from "./runner.js";
import { loadState } from "./state.js";
import type { RunContext } from "./types.js";

const program = new Command();

program
  .name("cccpr")
  .description(
    "Claude Code and Cmux Pipeline Reagent — deterministic YAML-based pipeline orchestration",
  )
  .version("0.1.0");

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
    "Artifact output directory (overrides cccpr.yaml and default)",
  )
  .option("--dry-run", "Show assembled prompts without executing agents")
  .option("--headless", "Auto-approve all gates (no human interaction)")
  .option("--webhook-url <url>", "Send pipeline event notifications to a webhook URL")
  .option(
    "-v, --var <key=value...>",
    "Set pipeline variables (repeatable)",
  )
  .action(async (opts) => {
    const pipelineFile = resolve(opts.file);
    const projectDir = resolve(opts.projectDir ?? process.cwd());

    // Load project config (cccpr.yaml) — returns empty defaults if absent.
    const projectConfig = await loadProjectConfig(projectDir);

    const pipeline = await loadPipeline(pipelineFile);

    // Artifact dir priority: CLI flag > cccpr.yaml > default pattern.
    let artifactDir: string;
    if (opts.artifactDir) {
      artifactDir = resolve(opts.artifactDir);
    } else if (projectConfig.artifact_dir) {
      artifactDir = resolve(
        projectDir,
        interpolate(projectConfig.artifact_dir, {
          project: opts.project,
          pipeline_name: pipeline.name,
        }),
      );
    } else {
      artifactDir = resolve(
        projectDir,
        `docs/projects/${opts.project}/${pipeline.name}`,
      );
    }

    // Build agent search paths.
    const agentSearchPaths: string[] = [];
    agentSearchPaths.push(resolve(dirname(pipelineFile), "agents"));
    agentSearchPaths.push(resolve(projectDir, ".claude", "agents"));
    agentSearchPaths.push(resolve(projectDir, "agents"));
    if (projectConfig.agent_paths) {
      agentSearchPaths.push(...projectConfig.agent_paths);
    }

    // Parse --var flags.
    const cliVars: Record<string, string> = {};
    if (opts.var) {
      for (const v of opts.var as string[]) {
        const eq = v.indexOf("=");
        if (eq === -1) {
          console.error(`Invalid variable format: ${v} (expected key=value)`);
          process.exit(1);
        }
        cliVars[v.slice(0, eq)] = v.slice(eq + 1);
      }
    }

    const variables: Record<string, string> = {
      project: opts.project,
      project_dir: projectDir,
      artifact_dir: artifactDir,
      pipeline_name: pipeline.name,
      ...(pipeline.variables ?? {}),
      ...cliVars,
    };

    // Gate strategy: headless → auto-approve, otherwise → filesystem polling.
    const gateStrategy: GateStrategy = opts.headless
      ? new AutoApproveStrategy()
      : new FilesystemGateStrategy(artifactDir);

    const ctx: RunContext = {
      project: opts.project,
      projectDir,
      artifactDir,
      pipelineFile,
      pipeline,
      dryRun: !!opts.dryRun,
      variables,
      agentSearchPaths,
      projectConfig,
      gateStrategy,
    };

    const result = await runPipeline(ctx);

    process.exit(result.status === "passed" ? 0 : 1);
  });

program
  .command("resume")
  .description("Resume an interrupted pipeline run")
  .requiredOption("-p, --project <name>", "Project name")
  .option(
    "-d, --project-dir <path>",
    "Project directory (defaults to cwd)",
  )
  .option(
    "-a, --artifact-dir <path>",
    "Artifact directory containing .cccpr/state.json",
  )
  .option("--headless", "Auto-approve all gates")
  .action(async (opts) => {
    const projectDir = resolve(opts.projectDir ?? process.cwd());
    const projectConfig = await loadProjectConfig(projectDir);

    let artifactDir: string;
    if (opts.artifactDir) {
      artifactDir = resolve(opts.artifactDir);
    } else {
      console.error(
        "Error: --artifact-dir is required for resume (to locate .cccpr/state.json)",
      );
      process.exit(1);
    }

    const existingState = await loadState(artifactDir);
    if (!existingState) {
      console.error(
        `No state file found at ${artifactDir}/.cccpr/state.json`,
      );
      process.exit(1);
    }

    console.log(
      `Found interrupted run: pipeline "${existingState.pipeline}", ` +
        `status "${existingState.status}", started ${existingState.startedAt}`,
    );

    const pipelineFile = resolve(existingState.pipelineFile);
    const pipeline = await loadPipeline(pipelineFile);

    const agentSearchPaths: string[] = [];
    agentSearchPaths.push(resolve(dirname(pipelineFile), "agents"));
    agentSearchPaths.push(resolve(projectDir, ".claude", "agents"));
    agentSearchPaths.push(resolve(projectDir, "agents"));
    if (projectConfig.agent_paths) {
      agentSearchPaths.push(...projectConfig.agent_paths);
    }

    const variables: Record<string, string> = {
      project: opts.project,
      project_dir: projectDir,
      artifact_dir: artifactDir,
      pipeline_name: pipeline.name,
      ...(pipeline.variables ?? {}),
    };

    const gateStrategy: GateStrategy = opts.headless
      ? new AutoApproveStrategy()
      : new FilesystemGateStrategy(artifactDir);

    const ctx: RunContext = {
      project: opts.project,
      projectDir,
      artifactDir,
      pipelineFile,
      pipeline,
      dryRun: false,
      variables,
      agentSearchPaths,
      projectConfig,
      gateStrategy,
    };

    const result = await runPipeline(ctx, { existingState });

    process.exit(result.status === "passed" ? 0 : 1);
  });

program
  .command("dashboard")
  .description("Launch the TUI dashboard to monitor a running pipeline")
  .requiredOption(
    "-a, --artifact-dir <path>",
    "Artifact directory containing .cccpr/state.json",
  )
  .action(async (opts) => {
    const artifactDir = resolve(opts.artifactDir);
    const existingState = await loadState(artifactDir);

    if (!existingState) {
      console.error(
        `No state file found at ${artifactDir}/.cccpr/state.json`,
      );
      process.exit(1);
    }

    const { launchDashboard } = await import("./tui/dashboard.js");
    await launchDashboard(artifactDir, existingState);
  });

program
  .command("gate-server")
  .description(
    "Start the MCP server for pipeline gate interaction. " +
      "Register this in .mcp.json for Claude Code integration.",
  )
  .action(async () => {
    const { startMcpServer } = await import("./gate/mcp-server.js");
    await startMcpServer();
  });

program
  .command("init")
  .description("Scaffold a cccpr.yaml config and example pipeline in the current directory")
  .option("-d, --dir <path>", "Directory to scaffold in (defaults to cwd)")
  .action(async (opts) => {
    const dir = resolve(opts.dir ?? process.cwd());

    // Write cccpr.yaml
    const configPath = resolve(dir, "cccpr.yaml");
    const configContent = `# CCCPR project configuration
# See: https://github.com/your-org/cccpr

# Directories to search for agent definitions (in priority order).
agent_paths:
  - ./agents
  - ./.claude/agents

# Named MCP server profiles.
# Each agent gets only the servers its profile specifies.
# mcp_profiles:
#   base:
#     servers:
#       qmd:
#         command: qmd
#         args: [serve, --stdio]
#   design:
#     extends: base
#     servers:
#       figma:
#         command: npx
#         args: [-y, figma-console-mcp]

# Default artifact output directory pattern.
# Supports {project} and {pipeline_name} variables.
artifact_dir: docs/projects/{project}/{pipeline_name}

# Default MCP profile applied when a stage doesn't specify one.
# default_mcp_profile: base
`;

    // Write example pipeline
    const pipelinesDir = resolve(dir, "pipelines");
    await mkdir(pipelinesDir, { recursive: true });
    const pipelinePath = resolve(pipelinesDir, "example.yaml");
    const pipelineContent = `name: example
description: Example pipeline — replace with your own stages.

stages:
  - name: research
    type: agent
    description: "Research the project and write a summary."
    agent: researcher
    output: "{artifact_dir}/research.md"

  - name: review
    type: pge
    description: "Write a technical document and evaluate it."
    generator:
      agent: writer
    evaluator:
      agent: reviewer
    contract:
      deliverable: "{artifact_dir}/document.md"
      criteria:
        - name: completeness
          description: "All required sections are present."
        - name: accuracy
          description: "Technical details are correct."
      max_iterations: 3
    on_fail: stop

  - name: approval
    type: human_gate
    prompt: "Please review the document and approve."
    artifacts:
      - "{artifact_dir}/document.md"
`;

    // Write example agents
    const agentsDir = resolve(dir, "agents");
    await mkdir(agentsDir, { recursive: true });

    await writeFile(
      resolve(agentsDir, "researcher.md"),
      `---
name: researcher
description: Researches a topic and writes a summary.
---

# Researcher Agent

You are a research agent. Read the project files and produce a clear, concise summary.

## Instructions

1. Read the project's key files (README, package.json, etc.)
2. Identify the main technologies, patterns, and structure
3. Write your findings to the output path specified in your task
`,
      "utf-8",
    );

    await writeFile(
      resolve(agentsDir, "writer.md"),
      `---
name: writer
description: Writes technical documents based on a contract.
---

# Writer Agent

You are a technical writer. Read the contract for success criteria, then produce a document that meets all criteria.

## Instructions

1. Read the contract file to understand what is required
2. If there is a previous evaluation, read it and address all feedback
3. Write the document to the output path specified in your task
`,
      "utf-8",
    );

    await writeFile(
      resolve(agentsDir, "reviewer.md"),
      `---
name: reviewer
description: Evaluates documents against contract criteria.
---

# Reviewer Agent

You are an evaluator. Grade the deliverable against the contract criteria.

## Instructions

1. Read the contract to understand the success criteria
2. Read the deliverable
3. For each criterion, determine PASS or FAIL with specific evidence
4. Write your evaluation to the output path using this format:

## Evaluation: [stage name]

### Criterion Results

| # | Criterion | Result | Evidence |
|---|-----------|--------|----------|
| 1 | [name]    | PASS/FAIL | [specific evidence] |

### Overall: PASS / FAIL

### Iteration Guidance (if FAIL)

1. [Specific fix needed]
`,
      "utf-8",
    );

    await writeFile(configPath, configContent, "utf-8");
    await writeFile(pipelinePath, pipelineContent, "utf-8");

    console.log(`Scaffolded CCCPR project in ${dir}:`);
    console.log(`  cccpr.yaml           — project configuration`);
    console.log(`  pipelines/example.yaml — example pipeline`);
    console.log(`  agents/researcher.md — example research agent`);
    console.log(`  agents/writer.md     — example writer agent`);
    console.log(`  agents/reviewer.md   — example reviewer/evaluator agent`);
    console.log(`\nRun with: cccpr run -f pipelines/example.yaml -p my-project --dry-run`);
  });

program.parse();
