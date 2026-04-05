import { resolve, dirname, join } from "node:path";
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { activityBus } from "./activity-bus.js";
import { resolveAgent } from "./agent-resolver.js";
import { DefaultAgentDispatcher, type AgentDispatcher } from "./dispatcher.js";
import { AgentCrashError, MissingOutputError } from "./errors.js";
import { FilesystemGateStrategy } from "./gate/gate-watcher.js";
import { ConsoleLogger, type Logger } from "./logger.js";
import { writeMcpConfigFile } from "./mcp/mcp-config.js";
import { runAutoresearchCycle, type AutoresearchCycleOptions } from "./autoresearch.js";
import { openDatabase } from "./db.js";
import { loadPipeline } from "./pipeline.js";
import { runPgeCycle, dispatchEvaluatorWithFeedback, type PgeCycleOptions } from "./pge.js";
import { interpolate, resolveTaskBody, loadAgentMarkdown, buildTaskContext, writeSystemPromptFile } from "./prompt.js";
import { updatePipelineStatus, notifyPipelineComplete, notifyPipelinePaused, launchScopedDashboard, isCmuxAvailable } from "./tui/cmux.js";
import {
  createState,
  flattenStageEntries,
  loadState,
  saveState,
  saveStateWithEvent,
  updateStageStatus,
  finishPipeline,
  findResumePoint,
} from "./state.js";
import type {
  AgentStage,
  AutoresearchStage,
  HumanGateStage,
  PgeStage,
  PipelineStage,
  RunContext,
  StageResult,
  StageStatus,
  StageEntry,
  PipelineResult,
  Stage,
  Pipeline,
  PipelineState,
  GateInfo,
} from "./types.js";
import { isParallelGroup } from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getLogger(ctx: RunContext): Logger {
  return ctx.logger ?? new ConsoleLogger();
}

function getDispatcher(ctx: RunContext): AgentDispatcher {
  return ctx.dispatcher ?? new DefaultAgentDispatcher();
}

// ---------------------------------------------------------------------------
// Conditional execution
// ---------------------------------------------------------------------------

const CONDITION_PATTERN = /^([\w-]+)\.([\w]+)\s+(==|!=)\s+(.+)$/;

/**
 * Evaluate `when:` conditions against current pipeline state.
 * Returns whether all conditions are met and a human-readable reason if not.
 */
function evaluateConditions(
  when: string | string[] | undefined,
  state: PipelineState,
): { met: boolean; reason?: string } {
  if (!when) return { met: true };
  const conditions = Array.isArray(when) ? when : [when];

  for (const cond of conditions) {
    const match = CONDITION_PATTERN.exec(cond);
    if (!match) return { met: false, reason: `invalid condition: ${cond}` };

    const [, stageName, key, op, expected] = match;
    const stageState = state.stages[stageName];
    if (!stageState) return { met: false, reason: `stage '${stageName}' not found in state` };

    const actual = key === "status"
      ? stageState.status
      : stageState.outputs?.[key];

    const isEqual = actual === expected;
    const conditionMet = op === "==" ? isEqual : !isEqual;

    if (!conditionMet) {
      return { met: false, reason: `${stageName}.${key} ${op} ${expected} (actual: ${actual ?? "undefined"})` };
    }
  }

  return { met: true };
}

/**
 * After a stage passes, collect its structured outputs from .outputs.json,
 * store in checkpoints + state, and inject into variables.
 */
async function collectStageOutputs(
  stage: Stage,
  ctx: RunContext,
  state: PipelineState,
): Promise<void> {
  if (!stage.outputs || Object.keys(stage.outputs).length === 0) return;

  const stageDir = join(ctx.artifactDir, stage.name);
  const outputsPath = join(stageDir, ".outputs.json");

  if (!existsSync(outputsPath)) {
    throw new Error(`Stage '${stage.name}' declares outputs but .outputs.json not found at ${outputsPath}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(outputsPath, "utf-8"));
  } catch {
    throw new Error(`Stage '${stage.name}': failed to parse .outputs.json at ${outputsPath}`);
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Stage '${stage.name}': .outputs.json must be a flat object`);
  }

  const outputs = parsed as Record<string, unknown>;
  const collected: Record<string, string> = {};

  for (const key of Object.keys(stage.outputs)) {
    if (!(key in outputs)) {
      throw new Error(`Stage '${stage.name}': .outputs.json missing declared key '${key}'`);
    }
    collected[key] = String(outputs[key]);
  }

  // Store in checkpoints (persists across resume).
  const db = await openDatabase(ctx.projectDir);
  for (const [key, value] of Object.entries(collected)) {
    db.setCheckpoint(state.runId, stage.name, key, value);
  }

  // Store in stage state (serialized in stages_json).
  const stageState = state.stages[stage.name];
  if (stageState) stageState.outputs = collected;

  // Inject into variables for downstream interpolation.
  for (const [key, value] of Object.entries(collected)) {
    ctx.variables[`${stage.name}.${key}`] = value;
  }
}

/**
 * Restore outputs from completed stages into variables (for resume).
 */
function restoreOutputVariables(
  state: PipelineState,
  ctx: RunContext,
): void {
  for (const name of state.stageOrder) {
    const stageState = state.stages[name];
    if (stageState?.outputs) {
      for (const [key, value] of Object.entries(stageState.outputs)) {
        ctx.variables[`${name}.${key}`] = value;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Stage dispatch — type: agent
// ---------------------------------------------------------------------------

async function runAgentStage(
  stage: AgentStage,
  ctx: RunContext,
  state: PipelineState,
): Promise<StageResult> {
  const start = Date.now();
  const vars = { ...ctx.variables, ...(stage.variables ?? {}) };

  const taskDescription = await resolveTaskBody(stage, vars, `Execute stage: ${stage.name}`);
  const output = stage.output ? interpolate(stage.output, vars) : undefined;
  const inputs = stage.inputs?.map((i) => interpolate(i, vars));

  // In dry-run mode, try to resolve but don't fail if files are missing.
  if (ctx.dryRun) {
    const userPrompt = buildTaskContext({ task: taskDescription, inputs, output });
    let resolvedPath = stage.agent;
    try {
      const resolved = await resolveAgent(stage.agent, ctx.agentSearchPaths, stage.operation, ctx.projectDir);
      resolvedPath = resolved.agentPath;
    } catch {
      resolvedPath = `${stage.agent} (not found — will resolve at runtime)`;
    }
    const logger = getLogger(ctx);
    logger.log("\n[dry-run] Stage:", stage.name);
    logger.log("  agent:     ", resolvedPath);
    if (stage.operation) logger.log("  operation: ", stage.operation);
    if (stage.mcp_profile) logger.log("  mcp:       ", stage.mcp_profile);
    if (inputs?.length) logger.log("  inputs:    ", inputs.join(", "));
    if (output) logger.log("  output:    ", output);
    logger.log("  user prompt:");
    for (const line of userPrompt.split("\n")) {
      logger.log("    " + line);
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
  const systemPromptFile = await writeSystemPromptFile(agentMarkdown, ctx.tempTracker);
  const mcpConfigFile = ctx.projectConfig
    ? await writeMcpConfigFile(stage.mcp_profile, ctx.projectConfig, ctx.tempTracker)
    : undefined;

  let gateFeedbackPath: string | undefined;
  let gateRetries = 0;

  // Compute outputs path if this stage declares structured outputs.
  let outputsPath: string | undefined;
  if (stage.outputs && Object.keys(stage.outputs).length > 0) {
    const stageDir = join(ctx.artifactDir, stage.name);
    mkdirSync(stageDir, { recursive: true });
    outputsPath = join(stageDir, ".outputs.json");
  }

  // Retry loop for human_review feedback.
  while (true) {
    const userPrompt = buildTaskContext({
      task: taskDescription,
      inputs,
      output,
      gateFeedback: gateFeedbackPath,
      outputsPath,
      outputKeys: stage.outputs,
    });

    const result = await getDispatcher(ctx).dispatch({
      userPrompt,
      systemPromptFile,
      mcpConfigFile,
      expectedOutput: output ? resolve(ctx.projectDir, output) : undefined,
      cwd: ctx.projectDir,
      allowedTools: stage.allowed_tools,
      agentName: stage.agent.replace(/[/\\]/g, "-").replace(/\.md$/, ""),
      streamLogDir: resolve(ctx.artifactDir, ".cccp"),
      claudeConfigDir: ctx.projectConfig?.claude_config_dir,
      permissionMode: ctx.projectConfig?.permission_mode,
      onActivity: (activity) => activityBus.emit("activity", activity),
      quiet: ctx.quiet,
      model: stage.model ?? ctx.pipeline.model,
      effort: stage.effort ?? ctx.pipeline.effort,
    });

    if (result.exitCode !== 0) {
      throw new AgentCrashError(stage.agent, result.exitCode);
    }
    if (output && !result.outputExists) {
      throw new MissingOutputError(stage.agent, output);
    }

    // Check human_review gate.
    if (stage.human_review && ctx.gateStrategy) {
      const reviewGate: GateInfo = {
        stageName: stage.name,
        status: "pending",
        prompt: `Agent stage "${stage.name}" completed. Review the output and approve or reject with feedback.`,
      };
      state.gate = reviewGate;
      await saveState(state);
      const reviewResponse = await ctx.gateStrategy.waitForGate(reviewGate);
      state.gate = undefined;
      await saveState(state);

      if (!reviewResponse.approved && reviewResponse.feedbackPath && gateRetries < MAX_GATE_RETRIES) {
        gateRetries++;
        getLogger(ctx).log(`    human review rejected with feedback — retrying agent (retry ${gateRetries}/${MAX_GATE_RETRIES})`);
        gateFeedbackPath = reviewResponse.feedbackPath;
        continue;
      }

      if (!reviewResponse.approved) {
        return {
          stageName: stage.name,
          status: "failed",
          result,
          error: gateRetries >= MAX_GATE_RETRIES
            ? `Failed and max gate retries (${MAX_GATE_RETRIES}) reached`
            : `Human review rejected${reviewResponse.feedback ? `: ${reviewResponse.feedback}` : ""}`,
          durationMs: Date.now() - start,
        };
      }

      getLogger(ctx).log(`    human review approved`);
    }

    return {
      stageName: stage.name,
      status: "passed",
      result,
      durationMs: Date.now() - start,
    };
  }
}

// ---------------------------------------------------------------------------
// Stage dispatch — type: pge
// ---------------------------------------------------------------------------

const MAX_GATE_RETRIES = 3;

async function runPgeStage(
  stage: PgeStage,
  ctx: RunContext,
  state: PipelineState,
): Promise<StageResult> {
  const start = Date.now();
  let pgeOptions: PgeCycleOptions | undefined;
  let gateRetries = 0;

  const onProgress = async (eventType?: string, eventData?: Record<string, unknown>) => {
    if (eventType) {
      await saveStateWithEvent(state, eventType, stage.name, eventData);
      ctx.parentOnProgress?.(eventType, stage.name, eventData);
    } else {
      await saveState(state);
    }
  };

  // Retry loop: runs the PGE cycle, handles escalation, and retries with feedback.
  while (true) {
    const pgeResult = await runPgeCycle(stage, ctx, state, onProgress, pgeOptions);

    if (pgeResult.outcome === "pass") {
      // Check human_review gate — fire a gate after PGE passes for human quality review.
      if (stage.human_review && ctx.gateStrategy && !ctx.dryRun) {
        const reviewGate: GateInfo = {
          stageName: stage.name,
          status: "pending",
          prompt: `PGE stage "${stage.name}" passed evaluation. Review the deliverable and approve or reject with feedback.`,
        };
        state.gate = reviewGate;
        await saveState(state);
        const reviewResponse = await ctx.gateStrategy.waitForGate(reviewGate);
        state.gate = undefined;
        await saveState(state);

        if (!reviewResponse.approved && reviewResponse.feedbackPath && gateRetries < MAX_GATE_RETRIES) {
          gateRetries++;
          getLogger(ctx).log(`    human review rejected with feedback — dispatching evaluator with feedback (retry ${gateRetries}/${MAX_GATE_RETRIES})`);

          // Route feedback through the evaluator to produce a structured FAIL evaluation.
          const humanEvalPath = await dispatchEvaluatorWithFeedback(
            stage, ctx, state, pgeResult, reviewResponse.feedbackPath, onProgress,
          );

          // Re-enter GE loop with the human-mediated evaluation.
          pgeOptions = {
            existingContractPath: pgeResult.contractPath,
            existingTaskPlanPath: pgeResult.taskPlanPath,
          };
          // Inject the human evaluation as the "last eval" by setting it as gate feedback
          // so the generator sees it alongside any previous evaluations.
          // Actually, we need the generator to see this as previousEvaluation, not gateFeedback.
          // The cleanest way: pass it as gateFeedbackPath (the generator will read both).
          pgeOptions.gateFeedbackPath = humanEvalPath;
          continue;
        }

        if (!reviewResponse.approved) {
          return {
            stageName: stage.name,
            status: "failed",
            result: pgeResult,
            error: gateRetries >= MAX_GATE_RETRIES
              ? `Failed and max gate retries (${MAX_GATE_RETRIES}) reached`
              : `Human review rejected${reviewResponse.feedback ? `: ${reviewResponse.feedback}` : ""}`,
            durationMs: Date.now() - start,
          };
        }

        getLogger(ctx).log(`    human review approved`);
      }

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

    if (strategy === "stop") {
      return {
        stageName: stage.name,
        status: "failed",
        result: pgeResult,
        error: `Failed after ${pgeResult.iterations}/${pgeResult.maxIterations} iterations`,
        durationMs: Date.now() - start,
      };
    }

    if (strategy === "skip") {
      getLogger(ctx).log(`    escalation: skip — continuing pipeline`);
      return {
        stageName: stage.name,
        status: "skipped",
        result: pgeResult,
        durationMs: Date.now() - start,
      };
    }

    // strategy === "human_gate"
    if (!ctx.gateStrategy) {
      getLogger(ctx).log(`    escalation: human_gate — no gate strategy, stopping`);
      return {
        stageName: stage.name,
        status: "failed",
        result: pgeResult,
        error: `Failed after ${pgeResult.iterations} iterations (no gate strategy configured)`,
        durationMs: Date.now() - start,
      };
    }

    getLogger(ctx).log(`    escalation: human_gate — awaiting approval`);
    const gateInfo: GateInfo = {
      stageName: stage.name,
      status: "pending",
      prompt: `PGE stage "${stage.name}" failed after ${pgeResult.iterations} iterations. Approve to skip and continue, reject to stop, or reject with feedback to retry the generation cycle.`,
    };
    state.gate = gateInfo;
    await saveState(state);
    const gateResponse = await ctx.gateStrategy.waitForGate(gateInfo);
    state.gate = undefined;
    await saveState(state);

    if (gateResponse.approved) {
      getLogger(ctx).log(`    gate approved — continuing pipeline`);
      return {
        stageName: stage.name,
        status: "skipped",
        result: pgeResult,
        durationMs: Date.now() - start,
      };
    }

    // Rejected — check for feedback retry
    if (gateResponse.feedbackPath && gateRetries < MAX_GATE_RETRIES) {
      gateRetries++;
      getLogger(ctx).log(`    gate rejected with feedback — retrying PGE cycle (retry ${gateRetries}/${MAX_GATE_RETRIES})`);
      pgeOptions = {
        gateFeedbackPath: gateResponse.feedbackPath,
        existingContractPath: pgeResult.contractPath,
        existingTaskPlanPath: pgeResult.taskPlanPath,
      };
      continue; // Re-enter the PGE cycle with feedback
    }

    // Rejected without feedback, or max retries reached
    return {
      stageName: stage.name,
      status: "failed",
      result: pgeResult,
      error: gateRetries >= MAX_GATE_RETRIES
        ? `Failed and max gate retries (${MAX_GATE_RETRIES}) reached`
        : `Failed and gate rejected${gateResponse.feedback ? `: ${gateResponse.feedback}` : ""}`,
      durationMs: Date.now() - start,
    };
  }
}

// ---------------------------------------------------------------------------
// Stage dispatch — type: autoresearch
// ---------------------------------------------------------------------------

async function runAutoresearchStage(
  stage: AutoresearchStage,
  ctx: RunContext,
  state: PipelineState,
): Promise<StageResult> {
  const start = Date.now();
  let arOptions: AutoresearchCycleOptions | undefined;
  let gateRetries = 0;

  const onProgress = async (eventType?: string, eventData?: Record<string, unknown>) => {
    if (eventType) {
      await saveStateWithEvent(state, eventType, stage.name, eventData);
      ctx.parentOnProgress?.(eventType, stage.name, eventData);
    } else {
      await saveState(state);
    }
  };

  // Retry loop: runs autoresearch cycle, handles escalation, retries with feedback.
  while (true) {
    const result = await runAutoresearchCycle(stage, ctx, state, onProgress, arOptions);

    if (result.outcome === "pass") {
      return {
        stageName: stage.name,
        status: "passed",
        result,
        durationMs: Date.now() - start,
      };
    }

    if (result.outcome === "error") {
      return {
        stageName: stage.name,
        status: "error",
        result,
        error: "Evaluation parse error",
        durationMs: Date.now() - start,
      };
    }

    // outcome === "fail" — apply escalation strategy
    const strategy = stage.on_fail ?? "stop";
    const iterLabel = result.maxIterations
      ? `${result.iterations}/${result.maxIterations}`
      : `${result.iterations}`;

    if (strategy === "stop") {
      return {
        stageName: stage.name,
        status: "failed",
        result,
        error: `Failed after ${iterLabel} iterations`,
        durationMs: Date.now() - start,
      };
    }

    if (strategy === "skip") {
      getLogger(ctx).log(`    escalation: skip — continuing pipeline`);
      return {
        stageName: stage.name,
        status: "skipped",
        result,
        durationMs: Date.now() - start,
      };
    }

    // strategy === "human_gate"
    if (!ctx.gateStrategy) {
      getLogger(ctx).log(`    escalation: human_gate — no gate strategy, stopping`);
      return {
        stageName: stage.name,
        status: "failed",
        result,
        error: `Failed after ${iterLabel} iterations (no gate strategy configured)`,
        durationMs: Date.now() - start,
      };
    }

    getLogger(ctx).log(`    escalation: human_gate — awaiting approval`);
    const gateInfo: GateInfo = {
      stageName: stage.name,
      status: "pending",
      prompt: `Autoresearch stage "${stage.name}" failed after ${iterLabel} iterations. Approve to skip and continue, reject to stop, or reject with feedback to retry.`,
    };
    state.gate = gateInfo;
    await saveState(state);
    const gateResponse = await ctx.gateStrategy.waitForGate(gateInfo);
    state.gate = undefined;
    await saveState(state);

    if (gateResponse.approved) {
      getLogger(ctx).log(`    gate approved — continuing pipeline`);
      return {
        stageName: stage.name,
        status: "skipped",
        result,
        durationMs: Date.now() - start,
      };
    }

    // Rejected — check for feedback retry
    if (gateResponse.feedbackPath && gateRetries < MAX_GATE_RETRIES) {
      gateRetries++;
      getLogger(ctx).log(`    gate rejected with feedback — retrying autoresearch cycle (retry ${gateRetries}/${MAX_GATE_RETRIES})`);
      arOptions = { gateFeedbackPath: gateResponse.feedbackPath };
      continue;
    }

    // Rejected without feedback, or max retries reached
    return {
      stageName: stage.name,
      status: "failed",
      result,
      error: gateRetries >= MAX_GATE_RETRIES
        ? `Failed and max gate retries (${MAX_GATE_RETRIES}) reached`
        : `Failed and gate rejected${gateResponse.feedback ? `: ${gateResponse.feedback}` : ""}`,
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
  state: PipelineState,
): Promise<StageResult> {
  const start = Date.now();

  // Dry-run: just show what would happen.
  if (ctx.dryRun) {
    const logger = getLogger(ctx);
    logger.log("\n[dry-run] Human Gate:", stage.name);
    if (stage.prompt) logger.log("  prompt:    ", stage.prompt);
    if (stage.artifacts?.length) logger.log("  artifacts: ", stage.artifacts.join(", "));
    logger.log("  on_reject: ", stage.on_reject ?? "stop");
    return {
      stageName: stage.name,
      status: "passed",
      durationMs: 0,
    };
  }

  // No gate strategy configured — skip with warning.
  if (!ctx.gateStrategy) {
    getLogger(ctx).log(`  [skip] No gate strategy configured (stage: ${stage.name})`);
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

  state.gate = gateInfo;
  await saveState(state);

  // Wait for response via the gate strategy.
  const response = await ctx.gateStrategy.waitForGate(gateInfo);

  // Clear gate from state.
  state.gate = undefined;
  await saveState(state);

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
// Stage dispatch — type: pipeline (sub-pipeline)
// ---------------------------------------------------------------------------

const MAX_PIPELINE_DEPTH = 5;

async function runPipelineStage(
  stage: PipelineStage,
  ctx: RunContext,
  state: PipelineState,
): Promise<StageResult> {
  const start = Date.now();
  const vars = { ...ctx.variables, ...(stage.variables ?? {}) };

  // Resolve sub-pipeline file path relative to parent pipeline's directory.
  const filePath = resolve(dirname(ctx.pipelineFile), interpolate(stage.file, vars));

  // --- Dry-run ---
  if (ctx.dryRun) {
    const logger = getLogger(ctx);
    logger.log(`\n[dry-run] Pipeline Stage: ${stage.name}`);
    logger.log(`  file:         ${filePath}`);
    if (stage.artifact_dir) {
      logger.log(`  artifact_dir: ${interpolate(stage.artifact_dir, vars)}`);
    }
    if (stage.on_fail) {
      logger.log(`  on_fail:      ${stage.on_fail}`);
    }

    // Load and dry-run the sub-pipeline.
    let childPipeline: Pipeline;
    try {
      childPipeline = await loadPipeline(filePath);
    } catch (err) {
      logger.log(`  (sub-pipeline not loadable — will resolve at runtime)`);
      return { stageName: stage.name, status: "passed", durationMs: 0 };
    }

    const flatStages = flattenStageEntries(childPipeline.stages);
    logger.log(`  sub-pipeline: ${childPipeline.name} (${flatStages.length} stages)`);
    for (const s of flatStages) {
      logger.log(`    - ${s.name} (${s.type})${s.groupId ? ` [${s.groupId}]` : ""}`);
    }

    return { stageName: stage.name, status: "passed", durationMs: 0 };
  }

  // --- Cycle detection ---
  const visited = ctx.visitedPipelines ?? new Set<string>();
  if (visited.has(filePath)) {
    throw new Error(
      `Circular pipeline dependency: ${[...visited, filePath].join(" → ")}`,
    );
  }
  if (visited.size >= MAX_PIPELINE_DEPTH) {
    throw new Error(
      `Pipeline nesting depth exceeded (max ${MAX_PIPELINE_DEPTH}): ${[...visited, filePath].join(" → ")}`,
    );
  }

  // --- Load sub-pipeline ---
  const childPipeline = await loadPipeline(filePath);

  // --- Build child context ---
  const childArtifactDir = stage.artifact_dir
    ? resolve(ctx.projectDir, interpolate(stage.artifact_dir, vars))
    : ctx.artifactDir;

  const childVars: Record<string, string> = {
    project: ctx.project,
    project_dir: ctx.projectDir,
    artifact_dir: childArtifactDir,
    pipeline_name: childPipeline.name,
    ...(childPipeline.variables ?? {}),
    ...(stage.variables ?? {}),
  };

  const childVisited = new Set(visited);
  childVisited.add(resolve(ctx.pipelineFile));

  const childCtx: RunContext = {
    ...ctx,
    pipeline: childPipeline,
    pipelineFile: filePath,
    artifactDir: childArtifactDir,
    variables: childVars,
    visitedPipelines: childVisited,
    // Inherit parent's agent search paths + sub-pipeline's directory.
    agentSearchPaths: [
      resolve(dirname(filePath), "agents"),
      ...ctx.agentSearchPaths,
    ],
    // Bubble child stage events to the parent's event stream.
    parentOnProgress: async (eventType, childStageName, eventData) => {
      await saveStateWithEvent(state, `child_${eventType}`, stage.name, {
        childStage: childStageName,
        childPipeline: childPipeline.name,
        ...eventData,
      });
    },
  };

  // --- Launch scoped dashboard in cmux split (depth-1 only) ---
  if (
    !ctx.headless &&
    isCmuxAvailable() &&
    visited.size <= 1
  ) {
    launchScopedDashboard(state.runId, ctx.projectDir, stage.name).catch(() => {});
  }

  // --- Link child state to parent BEFORE execution ---
  // Pre-create child state so stageState.children is set before runStages().
  // JavaScript pass-by-reference means child mutations inside runStages() are
  // visible through the parent's reference, so parentOnProgress → saveStateWithEvent
  // persists the parent state with up-to-date child progress after each child event.
  // Without this, a crash mid-child leaves children=undefined and resume restarts
  // the sub-pipeline from scratch.
  const stageState = state.stages[stage.name];
  let childState = stageState?.children;

  if (!childState && !ctx.dryRun) {
    childState = createState(
      childPipeline.name,
      ctx.project,
      filePath,
      flattenStageEntries(childPipeline.stages),
      childArtifactDir,
      ctx.projectDir,
    );
    if (stageState) {
      stageState.children = childState;
      await saveState(state);
    }
  }

  const childResult = await runStages(childCtx, childState);

  // Update parent with final child state.
  if (stageState) {
    stageState.children = childResult.state;
  }

  const durationMs = Date.now() - start;
  const result: StageResult = {
    stageName: stage.name,
    status: childResult.pipelineResult.status === "passed" ? "passed" : "failed",
    error: childResult.pipelineResult.status !== "passed"
      ? `Sub-pipeline "${childPipeline.name}" ${childResult.pipelineResult.status}`
      : undefined,
    durationMs,
  };

  // --- Escalation ---
  if (result.status === "failed" && stage.on_fail) {
    if (stage.on_fail === "skip") {
      return { ...result, status: "skipped" };
    }
    if (stage.on_fail === "human_gate" && ctx.gateStrategy) {
      const gate: GateInfo = {
        stageName: stage.name,
        status: "pending",
        prompt: `Sub-pipeline "${childPipeline.name}" failed. Approve to continue, reject to stop.`,
      };
      state.gate = gate;
      await saveState(state);
      const response = await ctx.gateStrategy.waitForGate(gate);
      state.gate = { ...gate, ...response, status: response.approved ? "approved" : "rejected" };
      if (response.approved) {
        return { ...result, status: "skipped" };
      }
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Stage router
// ---------------------------------------------------------------------------

async function runStage(
  stage: Stage,
  ctx: RunContext,
  state: PipelineState,
): Promise<StageResult> {
  switch (stage.type) {
    case "agent":
      return runAgentStage(stage, ctx, state);

    case "pge":
      return runPgeStage(stage, ctx, state);

    case "human_gate":
      return runHumanGateStage(stage, ctx, state);

    case "autoresearch":
      return runAutoresearchStage(stage, ctx, state);

    case "pipeline":
      return runPipelineStage(stage, ctx, state);
  }
}

// ---------------------------------------------------------------------------
// Execution plan — normalizes StageEntry[] into sequential/parallel steps
// ---------------------------------------------------------------------------

interface ExecutionStep {
  kind: "sequential" | "parallel";
  stages: Stage[];
  onFailure?: "fail_fast" | "wait_all";
}

function buildExecutionPlan(entries: StageEntry[]): ExecutionStep[] {
  const plan: ExecutionStep[] = [];
  for (const entry of entries) {
    if (isParallelGroup(entry)) {
      plan.push({
        kind: "parallel",
        stages: entry.parallel.stages,
        onFailure: entry.parallel.on_failure ?? "fail_fast",
      });
    } else {
      plan.push({
        kind: "sequential",
        stages: [entry],
      });
    }
  }
  return plan;
}

/** Compute the total number of stages across all execution steps. */
function countTotalStages(plan: ExecutionStep[]): number {
  return plan.reduce((sum, step) => sum + step.stages.length, 0);
}

// ---------------------------------------------------------------------------
// Core stage execution loop (shared by runPipeline and runPipelineStage)
// ---------------------------------------------------------------------------

interface StagesResult {
  state: PipelineState;
  pipelineResult: PipelineResult;
}

/**
 * Run a single stage with full lifecycle: mark in_progress, dispatch, persist
 * result, and log. Extracted from the main loop so it can be reused in both
 * sequential and parallel execution paths.
 */
async function runStageWithLifecycle(
  stage: Stage,
  ctx: RunContext,
  state: PipelineState,
  stageIndex: number,
  totalStages: number,
): Promise<StageResult> {
  const stageStart = Date.now();

  // Evaluate `when:` conditions before running the stage.
  if (stage.when && !ctx.dryRun) {
    const { met, reason } = evaluateConditions(stage.when, state);
    if (!met) {
      getLogger(ctx).log(`  ⏭ ${stage.name}: skipped (condition not met: ${reason})`);
      updateStageStatus(state, stage.name, "skipped");
      await saveStateWithEvent(state, "stage_skipped", stage.name, { reason });
      ctx.parentOnProgress?.("stage_skipped", stage.name, { reason });
      return { stageName: stage.name, status: "skipped", durationMs: 0 };
    }
  }

  getLogger(ctx).log(`▸ Stage: ${stage.name} (${stage.type})`);

  const stageEventData = {
    type: stage.type,
    ...("agent" in stage ? { agent: (stage as { agent: string }).agent } : {}),
    ...("model" in stage ? { model: (stage as { model?: string }).model } : {}),
    ...("effort" in stage ? { effort: (stage as { effort?: string }).effort } : {}),
    ...("inputs" in stage ? { inputs: (stage as { inputs?: string[] }).inputs } : {}),
    ...("output" in stage ? { output: (stage as { output?: string }).output } : {}),
    ...("operation" in stage ? { operation: (stage as { operation?: string }).operation } : {}),
    pipelineModel: ctx.pipeline.model,
    pipelineEffort: ctx.pipeline.effort,
  };

  if (!ctx.dryRun) {
    updateStageStatus(state, stage.name, "in_progress");
    await saveStateWithEvent(state, "stage_start", stage.name, stageEventData);
    // Bubble to parent pipeline if this is a sub-pipeline stage.
    ctx.parentOnProgress?.("stage_start", stage.name, stageEventData);
    await updatePipelineStatus(stage.name, stageIndex, totalStages);
  }

  try {
    const result = await runStage(stage, ctx, state);

    const completeData = {
      status: result.status,
      durationMs: result.durationMs,
    };

    if (!ctx.dryRun) {
      // Collect structured outputs before finalizing state.
      if (result.status === "passed") {
        await collectStageOutputs(stage, ctx, state);
      }

      updateStageStatus(state, stage.name, result.status as StageStatus, {
        durationMs: result.durationMs,
        error: result.error,
      });
      await saveStateWithEvent(state, "stage_complete", stage.name, completeData);
      // Bubble to parent pipeline.
      ctx.parentOnProgress?.("stage_complete", stage.name, completeData);
    }

    if (result.status === "failed" || result.status === "error") {
      getLogger(ctx).log(`  ✗ ${stage.name}: ${result.status}${result.error ? ` — ${result.error}` : ""}`);
    } else {
      const duration = result.durationMs > 0
        ? ` (${(result.durationMs / 1000).toFixed(1)}s)`
        : "";
      getLogger(ctx).log(`  ✓ ${stage.name}: ${result.status}${duration}`);
    }

    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const result: StageResult = {
      stageName: stage.name,
      status: "error",
      error: message,
      durationMs: Date.now() - stageStart,
    };

    if (!ctx.dryRun) {
      updateStageStatus(state, stage.name, "error", { error: message });
      await saveStateWithEvent(state, "stage_complete", stage.name, {
        status: "error",
        error: message,
        durationMs: result.durationMs,
      });
      ctx.parentOnProgress?.("stage_complete", stage.name, {
        status: "error",
        error: message,
        durationMs: result.durationMs,
      });
    }

    getLogger(ctx).error(`  ✗ ${stage.name}: error — ${message}`);
    return result;
  }
}

/**
 * Run a group of stages in parallel. Returns all results once the group
 * completes (or a failure triggers early exit in fail_fast mode).
 */
async function runParallelGroup(
  step: ExecutionStep,
  ctx: RunContext,
  state: PipelineState,
  completedNames: Set<string>,
  stageIndexOffset: number,
  totalStages: number,
): Promise<StageResult[]> {
  // Filter to only stages that need running (not already completed on resume).
  const toRun = step.stages.filter(s => !completedNames.has(s.name));
  // Collect results for already-completed stages in this group.
  const skippedResults: StageResult[] = step.stages
    .filter(s => completedNames.has(s.name))
    .map(s => {
      const stageState = state.stages[s.name];
      getLogger(ctx).log(`  ⏭ ${s.name}: already ${stageState?.status ?? "passed"}`);
      return {
        stageName: s.name,
        status: (stageState?.status as "passed" | "skipped") ?? "passed",
        durationMs: stageState?.durationMs ?? 0,
      };
    });

  if (toRun.length === 0) return skippedResults;

  const stageNames = toRun.map(s => s.name).join(", ");
  getLogger(ctx).log(`▸ Parallel group: [${stageNames}]`);

  if (step.onFailure === "wait_all") {
    // Wait for all stages regardless of individual failures.
    const settled = await Promise.allSettled(
      toRun.map((stage, i) =>
        runStageWithLifecycle(stage, ctx, state, stageIndexOffset + i, totalStages),
      ),
    );
    const results = settled.map((r, i) =>
      r.status === "fulfilled"
        ? r.value
        : {
            stageName: toRun[i].name,
            status: "error" as const,
            error: r.reason instanceof Error ? r.reason.message : String(r.reason),
            durationMs: 0,
          },
    );
    return [...skippedResults, ...results];
  }

  // fail_fast: use a shared flag so that stages that haven't started their
  // dispatch yet can bail out early. Already-running subprocesses finish
  // naturally (we can't safely kill them mid-file-write).
  let failed = false;
  const promises = toRun.map(async (stage, i) => {
    // Yield to let other stages start concurrently, then check flag.
    await Promise.resolve();
    if (failed) {
      const result: StageResult = {
        stageName: stage.name,
        status: "skipped",
        error: "Sibling stage failed (fail_fast)",
        durationMs: 0,
      };
      if (!ctx.dryRun) {
        updateStageStatus(state, stage.name, "skipped", { error: result.error });
        await saveState(state);
      }
      getLogger(ctx).log(`  ⏭ ${stage.name}: skipped (sibling failed)`);
      return result;
    }

    const result = await runStageWithLifecycle(stage, ctx, state, stageIndexOffset + i, totalStages);
    if (result.status === "failed" || result.status === "error") {
      failed = true;
    }
    return result;
  });

  return [...skippedResults, ...await Promise.all(promises)];
}

/**
 * Execute the stage loop for a pipeline. Used by both top-level `runPipeline()`
 * and nested `runPipelineStage()`. Handles resume, state persistence, and
 * stage routing — but not lifecycle concerns (DB row creation, notifications,
 * gate strategy setup, temp file cleanup).
 *
 * Supports both sequential stages and parallel groups via ExecutionStep plan.
 */
async function runStages(
  ctx: RunContext,
  existingState?: PipelineState,
): Promise<StagesResult> {
  const start = Date.now();
  const results: StageResult[] = [];
  let pipelineStatus: PipelineResult["status"] = "passed";

  // --- State initialization ---
  let state: PipelineState;
  const completedNames = new Set<string>();

  if (existingState) {
    state = existingState;
    state.status = "running";
    const resume = findResumePoint(state);
    if (resume) {
      // Collect names of already-completed stages for skip logic.
      for (let i = 0; i < resume.stageIndex; i++) {
        completedNames.add(state.stageOrder[i]);
      }
      getLogger(ctx).log(`  resuming "${ctx.pipeline.name}" from stage "${resume.stageName}"`);
      // Restore stage outputs from completed stages into variables.
      restoreOutputVariables(state, ctx);
    } else {
      return {
        state,
        pipelineResult: {
          pipeline: ctx.pipeline.name,
          project: ctx.project,
          stages: [],
          status: "passed",
          durationMs: 0,
        },
      };
    }
  } else {
    state = createState(
      ctx.pipeline.name,
      ctx.project,
      ctx.pipelineFile,
      flattenStageEntries(ctx.pipeline.stages),
      ctx.artifactDir,
      ctx.projectDir,
      ctx.sessionId,
    );
  }

  if (!ctx.dryRun) {
    await saveState(state);
  }

  // Build execution plan from pipeline entries.
  const plan = buildExecutionPlan(ctx.pipeline.stages);
  const totalStages = countTotalStages(plan);
  let stageIndexOffset = 0;

  for (const step of plan) {
    // --- Pause check: stop at clean breakpoint if requested ---
    if (!ctx.dryRun) {
      const db = await openDatabase(ctx.projectDir);
      if (db.isPauseRequested(state.runId)) {
        db.setPauseRequested(state.runId, false);
        const nextStage = step.stages[0].name;
        state.status = "paused";
        state.completedAt = new Date().toISOString();
        await saveStateWithEvent(state, "pipeline_paused", undefined, { nextStage });
        getLogger(ctx).log(`\n  \u23F8 Pipeline paused before stage "${nextStage}"`);
        notifyPipelinePaused(ctx.pipeline.name).catch(() => {});
        return {
          state,
          pipelineResult: {
            pipeline: ctx.pipeline.name,
            project: ctx.project,
            stages: results,
            status: "passed",
            durationMs: Date.now() - start,
          },
        };
      }
    }

    if (step.kind === "sequential") {
      const stage = step.stages[0];

      // Skip completed stages on resume.
      if (completedNames.has(stage.name)) {
        const stageState = state.stages[stage.name];
        if (stageState?.status === "passed" || stageState?.status === "skipped") {
          getLogger(ctx).log(`  ⏭ ${stage.name}: already ${stageState.status}`);
          results.push({
            stageName: stage.name,
            status: stageState.status as "passed" | "skipped",
            durationMs: stageState.durationMs ?? 0,
          });
          stageIndexOffset += 1;
          continue;
        }
      }

      const result = await runStageWithLifecycle(stage, ctx, state, stageIndexOffset, totalStages);
      results.push(result);

      if (result.status === "failed" || result.status === "error") {
        pipelineStatus = result.status === "error" ? "error" : "failed";
        break;
      }
    } else {
      // Parallel group
      const groupResults = await runParallelGroup(
        step, ctx, state, completedNames, stageIndexOffset, totalStages,
      );
      results.push(...groupResults);

      const anyFailed = groupResults.some(r => r.status === "failed" || r.status === "error");
      if (anyFailed) {
        const hasError = groupResults.some(r => r.status === "error");
        pipelineStatus = hasError ? "error" : "failed";
        break;
      }
    }

    stageIndexOffset += step.stages.length;
  }

  // Finalize state.
  if (!ctx.dryRun) {
    const finalStatus = pipelineStatus === "passed" ? "passed" : pipelineStatus === "error" ? "error" : "failed";
    finishPipeline(state, finalStatus);
  }

  const durationMs = Date.now() - start;
  return {
    state,
    pipelineResult: {
      pipeline: ctx.pipeline.name,
      project: ctx.project,
      stages: results,
      status: pipelineStatus,
      durationMs,
    },
  };
}

// ---------------------------------------------------------------------------
// Pipeline runner (top-level entry point)
// ---------------------------------------------------------------------------

export interface RunOptions {
  /** Existing state to resume from. If provided, completed stages are skipped. */
  existingState?: PipelineState;
}

/**
 * Run all stages in a pipeline sequentially.
 * Handles top-level lifecycle: state creation, DB persistence, gate strategy,
 * cmux notifications, and temp file cleanup.
 */
export async function runPipeline(
  ctx: RunContext,
  opts?: RunOptions,
): Promise<PipelineResult> {
  // Create gate strategy if not provided.
  if (!ctx.gateStrategy && !ctx.headless && !ctx.dryRun) {
    // Need a runId — use existing state or generate one via createState.
    const tempState = opts?.existingState ?? createState(
      ctx.pipeline.name, ctx.project, ctx.pipelineFile,
      flattenStageEntries(ctx.pipeline.stages),
      ctx.artifactDir, ctx.projectDir, ctx.sessionId,
    );
    ctx.gateStrategy = new FilesystemGateStrategy(tempState.runId, ctx.projectDir, ctx.quiet);
  }

  // Initialize visited pipelines for cycle detection.
  if (!ctx.visitedPipelines) {
    ctx.visitedPipelines = new Set([resolve(ctx.pipelineFile)]);
  }

  if (opts?.existingState) {
    getLogger(ctx).log(`\nCCCP: Resuming pipeline "${ctx.pipeline.name}"\n`);
  } else {
    getLogger(ctx).log(`\nCCCP: Running pipeline "${ctx.pipeline.name}" for project "${ctx.project}"\n`);
  }

  try {
    const { state, pipelineResult } = await runStages(ctx, opts?.existingState);

    // Top-level persistence and notifications.
    if (!ctx.dryRun) {
      await saveStateWithEvent(state, "pipeline_complete", undefined, { status: pipelineResult.status });
      await notifyPipelineComplete(ctx.pipeline.name, pipelineResult.status);
    }

    getLogger(ctx).log(`\nPipeline "${ctx.pipeline.name}": ${pipelineResult.status} (${(pipelineResult.durationMs / 1000).toFixed(1)}s)\n`);

    return pipelineResult;
  } finally {
    await ctx.tempTracker?.cleanup();
  }
}
