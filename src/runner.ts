import { resolve } from "node:path";
import { dispatchAgent } from "./agent.js";
import { resolveAgent } from "./agent-resolver.js";
import { AgentCrashError, MissingOutputError } from "./errors.js";
import { writeMcpConfigFile } from "./mcp-config.js";
import { runPgeCycle } from "./pge.js";
import { interpolate, loadAgentMarkdown, buildTaskContext, writeSystemPromptFile } from "./prompt.js";
import { updatePipelineStatus, notifyPipelineComplete } from "./tui/cmux.js";
import {
  createState,
  loadState,
  saveState,
  updateStageStatus,
  finishPipeline,
  findResumePoint,
  type PipelineState,
} from "./state.js";
import type {
  AgentStage,
  HumanGateStage,
  PgeStage,
  RunContext,
  StageResult,
  PipelineResult,
  Stage,
} from "./types.js";
import type { GateInfo } from "./state.js";

// ---------------------------------------------------------------------------
// Stage dispatch — type: agent
// ---------------------------------------------------------------------------

async function runAgentStage(
  stage: AgentStage,
  ctx: RunContext,
): Promise<StageResult> {
  const start = Date.now();
  const vars = { ...ctx.variables, ...(stage.variables ?? {}) };

  const taskDescription =
    stage.description ?? `Execute stage: ${stage.name}`;
  const output = stage.output ? interpolate(stage.output, vars) : undefined;
  const inputs = stage.inputs?.map((i) => interpolate(i, vars));

  const userPrompt = buildTaskContext({
    task: taskDescription,
    inputs,
    output,
  });

  // In dry-run mode, try to resolve but don't fail if files are missing.
  if (ctx.dryRun) {
    let resolvedPath = stage.agent;
    try {
      const resolved = await resolveAgent(stage.agent, ctx.agentSearchPaths, stage.operation, ctx.projectDir);
      resolvedPath = resolved.agentPath;
    } catch {
      resolvedPath = `${stage.agent} (not found — will resolve at runtime)`;
    }
    console.log("\n[dry-run] Stage:", stage.name);
    console.log("  agent:     ", resolvedPath);
    if (stage.operation) console.log("  operation: ", stage.operation);
    if (stage.mcp_profile) console.log("  mcp:       ", stage.mcp_profile);
    if (inputs?.length) console.log("  inputs:    ", inputs.join(", "));
    if (output) console.log("  output:    ", output);
    console.log("  user prompt:");
    for (const line of userPrompt.split("\n")) {
      console.log("    " + line);
    }
    return {
      stageName: stage.name,
      status: "passed",
      result: { exitCode: 0, outputExists: false, durationMs: 0 },
      durationMs: 0,
    };
  }

  // Resolve agent via search paths.
  const resolved = await resolveAgent(
    stage.agent,
    ctx.agentSearchPaths,
    stage.operation,
    ctx.projectDir,
  );

  const agentMarkdown = await loadAgentMarkdown(resolved.agentPath, resolved.operationPath);
  const systemPromptFile = await writeSystemPromptFile(agentMarkdown);
  const mcpConfigFile = ctx.projectConfig
    ? await writeMcpConfigFile(stage.mcp_profile, ctx.projectConfig)
    : undefined;

  const result = await dispatchAgent({
    userPrompt,
    systemPromptFile,
    mcpConfigFile,
    expectedOutput: output ? resolve(ctx.projectDir, output) : undefined,
    cwd: ctx.projectDir,
    allowedTools: stage.allowed_tools,
    agentName: stage.agent.replace(/[/\\]/g, "-").replace(/\.md$/, ""),
    streamLogDir: resolve(ctx.artifactDir, ".cccpr"),
  });

  if (result.exitCode !== 0) {
    throw new AgentCrashError(stage.agent, result.exitCode);
  }
  if (output && !result.outputExists) {
    throw new MissingOutputError(stage.agent, output);
  }

  return {
    stageName: stage.name,
    status: "passed",
    result,
    durationMs: Date.now() - start,
  };
}

// ---------------------------------------------------------------------------
// Stage dispatch — type: pge
// ---------------------------------------------------------------------------

async function runPgeStage(
  stage: PgeStage,
  ctx: RunContext,
): Promise<StageResult> {
  const start = Date.now();
  const pgeResult = await runPgeCycle(stage, ctx);

  if (pgeResult.outcome === "pass") {
    return {
      stageName: stage.name,
      status: "passed",
      result: pgeResult,
      durationMs: Date.now() - start,
    };
  }

  if (pgeResult.outcome === "error") {
    return {
      stageName: stage.name,
      status: "error",
      result: pgeResult,
      error: "Evaluation parse error",
      durationMs: Date.now() - start,
    };
  }

  // outcome === "fail" — apply escalation strategy
  const strategy = stage.on_fail ?? "stop";
  switch (strategy) {
    case "stop":
      return {
        stageName: stage.name,
        status: "failed",
        result: pgeResult,
        error: `Failed after ${pgeResult.iterations}/${pgeResult.maxIterations} iterations`,
        durationMs: Date.now() - start,
      };

    case "skip":
      console.log(`    escalation: skip — continuing pipeline`);
      return {
        stageName: stage.name,
        status: "skipped",
        result: pgeResult,
        durationMs: Date.now() - start,
      };

    case "human_gate":
      if (!ctx.gateStrategy) {
        console.log(`    escalation: human_gate — no gate strategy, stopping`);
        return {
          stageName: stage.name,
          status: "failed",
          result: pgeResult,
          error: `Failed after ${pgeResult.iterations} iterations (no gate strategy configured)`,
          durationMs: Date.now() - start,
        };
      }
      console.log(`    escalation: human_gate — awaiting approval`);
      const gateInfo: GateInfo = {
        stageName: stage.name,
        status: "pending",
        prompt: `PGE stage "${stage.name}" failed after ${pgeResult.iterations} iterations. Approve to continue or reject to stop.`,
      };
      const state = await loadState(ctx.artifactDir);
      if (state) {
        state.gate = gateInfo;
        await saveState(ctx.artifactDir, state);
      }
      const gateResponse = await ctx.gateStrategy.waitForGate(gateInfo);
      if (state) {
        state.gate = undefined;
        await saveState(ctx.artifactDir, state);
      }
      if (gateResponse.approved) {
        console.log(`    gate approved — continuing pipeline`);
        return {
          stageName: stage.name,
          status: "skipped",
          result: pgeResult,
          durationMs: Date.now() - start,
        };
      }
      return {
        stageName: stage.name,
        status: "failed",
        result: pgeResult,
        error: `Failed and gate rejected${gateResponse.feedback ? `: ${gateResponse.feedback}` : ""}`,
        durationMs: Date.now() - start,
      };
  }
}

// ---------------------------------------------------------------------------
// Stage dispatch — type: human_gate
// ---------------------------------------------------------------------------

async function runHumanGateStage(
  stage: HumanGateStage,
  ctx: RunContext,
): Promise<StageResult> {
  const start = Date.now();

  // Dry-run: just show what would happen.
  if (ctx.dryRun) {
    console.log("\n[dry-run] Human Gate:", stage.name);
    if (stage.prompt) console.log("  prompt:    ", stage.prompt);
    if (stage.artifacts?.length) console.log("  artifacts: ", stage.artifacts.join(", "));
    console.log("  on_reject: ", stage.on_reject ?? "stop");
    return {
      stageName: stage.name,
      status: "passed",
      durationMs: 0,
    };
  }

  // No gate strategy configured — skip with warning.
  if (!ctx.gateStrategy) {
    console.log(`  [skip] No gate strategy configured (stage: ${stage.name})`);
    return {
      stageName: stage.name,
      status: "skipped",
      durationMs: 0,
    };
  }

  // Write gate_pending to state.
  const gateInfo: GateInfo = {
    stageName: stage.name,
    status: "pending",
    prompt: stage.prompt,
  };

  const state = await loadState(ctx.artifactDir);
  if (state) {
    state.gate = gateInfo;
    await saveState(ctx.artifactDir, state);
  }

  // Wait for response via the gate strategy.
  const response = await ctx.gateStrategy.waitForGate(gateInfo);

  // Clear gate from state.
  if (state) {
    state.gate = undefined;
    await saveState(ctx.artifactDir, state);
  }

  if (response.approved) {
    return {
      stageName: stage.name,
      status: "passed",
      durationMs: Date.now() - start,
    };
  }

  // Rejected.
  const onReject = stage.on_reject ?? "stop";
  if (onReject === "stop") {
    return {
      stageName: stage.name,
      status: "failed",
      error: `Gate rejected${response.feedback ? `: ${response.feedback}` : ""}`,
      durationMs: Date.now() - start,
    };
  }

  // on_reject: retry — for now, treat same as stop since retry needs
  // the previous generator context which is stage-dependent.
  return {
    stageName: stage.name,
    status: "failed",
    error: `Gate rejected (retry not yet supported)${response.feedback ? `: ${response.feedback}` : ""}`,
    durationMs: Date.now() - start,
  };
}

// ---------------------------------------------------------------------------
// Stage router
// ---------------------------------------------------------------------------

async function runStage(
  stage: Stage,
  ctx: RunContext,
): Promise<StageResult> {
  switch (stage.type) {
    case "agent":
      return runAgentStage(stage, ctx);

    case "pge":
      return runPgeStage(stage, ctx);

    case "human_gate":
      return runHumanGateStage(stage, ctx);
  }
}

// ---------------------------------------------------------------------------
// Pipeline runner
// ---------------------------------------------------------------------------

export interface RunOptions {
  /** Existing state to resume from. If provided, completed stages are skipped. */
  existingState?: PipelineState;
}

/**
 * Run all stages in a pipeline sequentially.
 * Persists state to disk after every stage transition.
 * Returns the overall pipeline result.
 */
export async function runPipeline(
  ctx: RunContext,
  opts?: RunOptions,
): Promise<PipelineResult> {
  const start = Date.now();
  const results: StageResult[] = [];
  let pipelineStatus: PipelineResult["status"] = "passed";

  // --- State initialization ---
  let state: PipelineState;
  let skipUntilIndex = -1;

  if (opts?.existingState) {
    state = opts.existingState;
    state.status = "running";
    const resume = findResumePoint(state);
    if (resume) {
      skipUntilIndex = resume.stageIndex;
      console.log(`\nCCCPR: Resuming pipeline "${ctx.pipeline.name}" from stage "${resume.stageName}"\n`);
    } else {
      console.log(`\nCCCPR: Pipeline "${ctx.pipeline.name}" has no resumable stages\n`);
      return {
        pipeline: ctx.pipeline.name,
        project: ctx.project,
        stages: [],
        status: "passed",
        durationMs: 0,
      };
    }
  } else {
    state = createState(
      ctx.pipeline.name,
      ctx.project,
      ctx.pipelineFile,
      ctx.pipeline.stages.map((s) => ({ name: s.name, type: s.type })),
    );
    console.log(`\nCCCPR: Running pipeline "${ctx.pipeline.name}" for project "${ctx.project}"\n`);
  }

  if (!ctx.dryRun) {
    await saveState(ctx.artifactDir, state);
  }

  for (let i = 0; i < ctx.pipeline.stages.length; i++) {
    const stage = ctx.pipeline.stages[i];

    // Skip completed stages on resume.
    if (opts?.existingState && i < skipUntilIndex) {
      const stageState = state.stages[stage.name];
      if (stageState?.status === "passed" || stageState?.status === "skipped") {
        console.log(`  ⏭ ${stage.name}: already ${stageState.status}`);
        results.push({
          stageName: stage.name,
          status: stageState.status as "passed" | "skipped",
          durationMs: stageState.durationMs ?? 0,
        });
        continue;
      }
    }

    console.log(`▸ Stage: ${stage.name} (${stage.type})`);

    // Mark in_progress in state + update cmux.
    if (!ctx.dryRun) {
      updateStageStatus(state, stage.name, "in_progress");
      await saveState(ctx.artifactDir, state);
      await updatePipelineStatus(stage.name, i, ctx.pipeline.stages.length);
    }

    try {
      const result = await runStage(stage, ctx);
      results.push(result);

      // Persist stage result to state.
      if (!ctx.dryRun) {
        updateStageStatus(state, stage.name, result.status as any, {
          durationMs: result.durationMs,
          error: result.error,
        });
        await saveState(ctx.artifactDir, state);
      }

      if (result.status === "failed" || result.status === "error") {
        pipelineStatus = "failed";
        console.log(`  ✗ ${stage.name}: ${result.status}${result.error ? ` — ${result.error}` : ""}`);
        break;
      }

      const duration = result.durationMs > 0
        ? ` (${(result.durationMs / 1000).toFixed(1)}s)`
        : "";
      console.log(`  ✓ ${stage.name}: ${result.status}${duration}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      results.push({
        stageName: stage.name,
        status: "error",
        error: message,
        durationMs: Date.now() - start,
      });
      pipelineStatus = "error";

      if (!ctx.dryRun) {
        updateStageStatus(state, stage.name, "error", { error: message });
        await saveState(ctx.artifactDir, state);
      }

      console.error(`  ✗ ${stage.name}: error — ${message}`);
      break;
    }
  }

  // Finalize state + notify cmux.
  if (!ctx.dryRun) {
    finishPipeline(state, pipelineStatus === "passed" ? "passed" : pipelineStatus === "error" ? "error" : "failed");
    await saveState(ctx.artifactDir, state);
    await notifyPipelineComplete(ctx.pipeline.name, pipelineStatus);
  }

  const durationMs = Date.now() - start;
  console.log(`\nPipeline "${ctx.pipeline.name}": ${pipelineStatus} (${(durationMs / 1000).toFixed(1)}s)\n`);

  return {
    pipeline: ctx.pipeline.name,
    project: ctx.project,
    stages: results,
    status: pipelineStatus,
    durationMs,
  };
}
