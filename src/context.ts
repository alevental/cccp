import { resolve, dirname } from "node:path";
import { interpolate } from "./prompt.js";
import { AutoApproveStrategy } from "./gate/auto-approve.js";
import { ConsoleLogger, QuietLogger } from "./logger.js";
import { TempFileTracker } from "./temp-tracker.js";
import type { ProjectConfig } from "./config.js";
import type { Pipeline, RunContext } from "./types.js";

// ---------------------------------------------------------------------------
// Agent search paths — 4-source priority order
// ---------------------------------------------------------------------------

export function buildAgentSearchPaths(
  pipelineFile: string,
  projectDir: string,
  projectConfig: ProjectConfig,
): string[] {
  const paths: string[] = [];
  paths.push(resolve(dirname(pipelineFile), "agents"));
  paths.push(resolve(projectDir, ".claude", "agents"));
  paths.push(resolve(projectDir, "agents"));
  if (projectConfig.agent_paths) {
    paths.push(...projectConfig.agent_paths);
  }
  return paths;
}

// ---------------------------------------------------------------------------
// Artifact directory resolution — CLI flag > cccp.yaml > default pattern
// ---------------------------------------------------------------------------

export function resolveArtifactDir(opts: {
  artifactDir?: string;
  projectDir: string;
  projectConfig: ProjectConfig;
  project: string;
  pipelineName: string;
}): string {
  if (opts.artifactDir) return resolve(opts.artifactDir);
  if (opts.projectConfig.artifact_dir) {
    return resolve(
      opts.projectDir,
      interpolate(opts.projectConfig.artifact_dir, {
        project: opts.project,
        pipeline_name: opts.pipelineName,
      }),
    );
  }
  return resolve(
    opts.projectDir,
    `docs/projects/${opts.project}/${opts.pipelineName}`,
  );
}

// ---------------------------------------------------------------------------
// CLI variable parsing
// ---------------------------------------------------------------------------

export function parseCLIVars(vars?: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  if (!vars) return result;
  for (const v of vars) {
    const eq = v.indexOf("=");
    if (eq === -1) {
      throw new Error(`Invalid variable format: ${v} (expected key=value)`);
    }
    result[v.slice(0, eq)] = v.slice(eq + 1);
  }
  return result;
}

// ---------------------------------------------------------------------------
// RunContext construction — unifies run and resume
// ---------------------------------------------------------------------------

export interface BuildRunContextOptions {
  project: string;
  projectDir: string;
  pipelineFile: string;
  pipeline: Pipeline;
  artifactDir: string;
  projectConfig: ProjectConfig;
  dryRun?: boolean;
  headless?: boolean;
  showTui?: boolean;
  cliVars?: Record<string, string>;
}

export function buildRunContext(opts: BuildRunContextOptions): RunContext {
  const agentSearchPaths = buildAgentSearchPaths(
    opts.pipelineFile,
    opts.projectDir,
    opts.projectConfig,
  );

  const variables: Record<string, string> = {
    project: opts.project,
    project_dir: opts.projectDir,
    artifact_dir: opts.artifactDir,
    pipeline_name: opts.pipeline.name,
    ...(opts.pipeline.variables ?? {}),
    ...(opts.cliVars ?? {}),
  };

  // Gate strategy: headless → auto-approve immediately.
  // Interactive → FilesystemGateStrategy, but it needs a runId which doesn't
  // exist yet. The runner creates it after state initialization.
  const gateStrategy = opts.headless
    ? new AutoApproveStrategy()
    : undefined;

  return {
    project: opts.project,
    projectDir: opts.projectDir,
    artifactDir: opts.artifactDir,
    pipelineFile: opts.pipelineFile,
    pipeline: opts.pipeline,
    dryRun: opts.dryRun ?? false,
    variables,
    agentSearchPaths,
    projectConfig: opts.projectConfig,
    gateStrategy,
    headless: opts.headless,
    quiet: opts.showTui,
    logger: opts.showTui ? new QuietLogger() : new ConsoleLogger(),
    tempTracker: new TempFileTracker(),
  };
}
