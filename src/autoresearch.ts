import { resolve } from "node:path";
import { copyFile, mkdir } from "node:fs/promises";
import { activityBus } from "./activity-bus.js";
import { DefaultAgentDispatcher, type AgentDispatcher } from "./dispatcher.js";
import { parseEvaluation } from "./evaluator.js";
import { AgentCrashError, MissingOutputError } from "./errors.js";
import { ConsoleLogger, type Logger } from "./logger.js";
import {
  interpolate,
  resolveTaskBody,
  buildTaskContext,
  writeSystemPromptFile,
} from "./prompt.js";
import { mergeInputs, resolveAndLoad, resolveModelEffort } from "./stage-helpers.js";
import { updatePgeProgress, setStageArtifact } from "./state.js";
import type { AutoresearchStage, AutoresearchResult, RunContext, PipelineState } from "./types.js";

function getLogger(ctx: RunContext): Logger {
  return ctx.logger ?? new ConsoleLogger();
}

function getDispatcher(ctx: RunContext): AgentDispatcher {
  return ctx.dispatcher ?? new DefaultAgentDispatcher();
}

// ---------------------------------------------------------------------------
// Autoresearch cycle
// ---------------------------------------------------------------------------

/**
 * Execute a full Adjust-Execute-Evaluate cycle for an autoresearch stage.
 *
 * 1. [iter > 1] Dispatch adjuster → modifies the artifact
 * 2. Dispatch executor → produces output using current artifact
 * 3. Dispatch evaluator → compares output against ground truth
 * 4. Parse evaluation (regex on ### Overall: PASS/FAIL)
 * 5. Route: PASS → done, FAIL + max reached → escalate, FAIL → continue
 */
/** Options for retrying an autoresearch cycle with gate feedback. */
export interface AutoresearchCycleOptions {
  /** Path to gate feedback file from a human reviewer. Injected into adjuster prompt. */
  gateFeedbackPath?: string;
}

export async function runAutoresearchCycle(
  stage: AutoresearchStage,
  ctx: RunContext,
  state: PipelineState,
  onProgress?: (eventType?: string, eventData?: Record<string, unknown>) => Promise<void>,
  options?: AutoresearchCycleOptions,
): Promise<AutoresearchResult> {
  const start = Date.now();
  const vars = { ...ctx.variables, ...(stage.variables ?? {}) };
  const maxIter = stage.max_iterations; // undefined = unlimited

  const artifactPath = resolve(ctx.projectDir, interpolate(stage.artifact, vars));
  const groundTruthPath = resolve(ctx.projectDir, interpolate(stage.ground_truth, vars));
  const outputPath = resolve(ctx.projectDir, interpolate(stage.output, vars));
  const stageDir = resolve(ctx.artifactDir, stage.name);

  await mkdir(stageDir, { recursive: true });

  // --- Dry-run ---
  if (ctx.dryRun) {
    const logger = getLogger(ctx);
    logger.log("\n[dry-run] Autoresearch Stage:", stage.name);
    logger.log("  artifact:     ", artifactPath);
    logger.log("  ground_truth: ", groundTruthPath);
    logger.log("  output:       ", outputPath);
    logger.log("  adjuster:     ", stage.adjuster.agent);
    logger.log("  executor:     ", stage.executor.agent);
    logger.log("  evaluator:    ", stage.evaluator.agent);
    logger.log("  max_iters:    ", maxIter ?? "unlimited");
    logger.log("  on_fail:      ", stage.on_fail ?? "stop");
    return {
      outcome: "pass",
      iterations: 0,
      maxIterations: maxIter,
      artifactPath,
      outputPath,
      durationMs: 0,
    };
  }

  // --- Resolve all agents ---
  const adjAgent = await resolveAndLoad(stage.adjuster, ctx, stage.mcp_profile);
  const execAgent = await resolveAndLoad(stage.executor, ctx, stage.mcp_profile);
  const evalAgent = await resolveAndLoad(stage.evaluator, ctx, stage.mcp_profile);

  // Save initial artifact version
  const artifactV0 = resolve(stageDir, "artifact-v0.md");
  await copyFile(artifactPath, artifactV0);
  setStageArtifact(state, stage.name, "artifact-v0", artifactV0);

  await onProgress?.("autoresearch_start", {
    adjuster: stage.adjuster.agent,
    executor: stage.executor.agent,
    evaluator: stage.evaluator.agent,
    artifact: artifactPath,
    groundTruth: groundTruthPath,
    maxIterations: maxIter ?? null,
  });

  // --- Resolve task body (file or inline) ---
  const taskBody = await resolveTaskBody(stage, vars, `Execute the task using the artifact at ${artifactPath}`);

  // --- AEE Iteration loop ---
  let lastEvalPath: string | undefined;

  for (let iter = 1; maxIter === undefined || iter <= maxIter; iter++) {
    getLogger(ctx).log(`    iteration ${iter}${maxIter ? `/${maxIter}` : ""}`);
    const evalPath = resolve(stageDir, `evaluation-${iter}.md`);

    // --- Step 1: Dispatch adjuster (skip on iteration 1) ---
    if (iter > 1) {
      getLogger(ctx).log(`    dispatching adjuster: ${stage.adjuster.agent}`);
      const adjModelEffort = resolveModelEffort(stage.adjuster, stage, ctx.pipeline, "adjuster");
      await onProgress?.("autoresearch_adjuster_start", {
        iteration: iter, maxIterations: maxIter ?? null, agent: stage.adjuster.agent,
        ...adjModelEffort, output: artifactPath,
      });

      const adjSystemFile = await writeSystemPromptFile(adjAgent.markdown, ctx.tempTracker);
      const adjInputs = mergeInputs(stage.inputs, stage.adjuster.inputs, vars, [artifactPath, groundTruthPath]);
      const adjPrompt = buildTaskContext({
        task: `Adjust the artifact to improve results. Original task: ${taskBody}`,
        groundTruthPath,
        inputs: adjInputs.length > 0 ? adjInputs : undefined,
        output: artifactPath,
        previousEvaluation: lastEvalPath,
        gateFeedback: options?.gateFeedbackPath,
        iteration: iter,
        maxIterations: maxIter,
      });

      const adjResult = await getDispatcher(ctx).dispatch({
        userPrompt: adjPrompt,
        systemPromptFile: adjSystemFile,
        mcpConfigFile: adjAgent.mcpFile,
        expectedOutput: artifactPath,
        cwd: ctx.projectDir,
        allowedTools: stage.adjuster.allowed_tools,
        claudeConfigDir: ctx.projectConfig?.claude_config_dir,
        permissionMode: ctx.projectConfig?.permission_mode,
        agentName: `${stage.name}-adjuster`,
        streamLogDir: resolve(ctx.artifactDir, ".cccp"),
        ...resolveModelEffort(stage.adjuster, stage, ctx.pipeline, "adjuster"),
        onActivity: (activity) => activityBus.emit("activity", activity),
        quiet: ctx.quiet,
      });

      if (adjResult.exitCode !== 0) {
        throw new AgentCrashError(stage.adjuster.agent, adjResult.exitCode);
      }
      if (!adjResult.outputExists) {
        throw new MissingOutputError(stage.adjuster.agent, artifactPath);
      }

      // Version the adjusted artifact
      const artifactVersionPath = resolve(stageDir, `artifact-v${iter}.md`);
      await copyFile(artifactPath, artifactVersionPath);
      setStageArtifact(state, stage.name, `artifact-v${iter}`, artifactVersionPath);

      updatePgeProgress(state, stage.name, iter, "adjuster_dispatched");
      await onProgress?.("autoresearch_adjuster_done", {
        iteration: iter, maxIterations: maxIter ?? null,
        agent: stage.adjuster.agent, artifactPath,
        summary: adjResult.summary,
      });
    }

    // --- Step 2: Dispatch executor ---
    getLogger(ctx).log(`    dispatching executor: ${stage.executor.agent}`);
    const execModelEffort = resolveModelEffort(stage.executor, stage, ctx.pipeline, "executor");
    await onProgress?.("autoresearch_executor_start", {
      iteration: iter, maxIterations: maxIter ?? null, agent: stage.executor.agent,
      ...execModelEffort, output: interpolate(stage.output, vars),
    });

    const execSystemFile = await writeSystemPromptFile(execAgent.markdown, ctx.tempTracker);
    const execInputs = mergeInputs(stage.inputs, stage.executor.inputs, vars, [artifactPath]);
    const execPrompt = buildTaskContext({
      task: taskBody,
      inputs: execInputs.length > 0 ? execInputs : undefined,
      output: interpolate(stage.output, vars),
      iteration: iter,
      maxIterations: maxIter,
    });

    const execResult = await getDispatcher(ctx).dispatch({
      userPrompt: execPrompt,
      systemPromptFile: execSystemFile,
      mcpConfigFile: execAgent.mcpFile,
      expectedOutput: outputPath,
      cwd: ctx.projectDir,
      allowedTools: stage.executor.allowed_tools,
      claudeConfigDir: ctx.projectConfig?.claude_config_dir,
      permissionMode: ctx.projectConfig?.permission_mode,
      agentName: `${stage.name}-executor`,
      streamLogDir: resolve(ctx.artifactDir, ".cccp"),
      ...resolveModelEffort(stage.executor, stage, ctx.pipeline, "executor"),
      onActivity: (activity) => activityBus.emit("activity", activity),
      quiet: ctx.quiet,
    });

    if (execResult.exitCode !== 0) {
      throw new AgentCrashError(stage.executor.agent, execResult.exitCode);
    }
    if (!execResult.outputExists) {
      throw new MissingOutputError(stage.executor.agent, interpolate(stage.output, vars));
    }

    updatePgeProgress(state, stage.name, iter, "executor_dispatched");
    setStageArtifact(state, stage.name, "output", outputPath);
    await onProgress?.("autoresearch_executor_done", {
      iteration: iter, maxIterations: maxIter ?? null,
      agent: stage.executor.agent, outputPath,
      summary: execResult.summary,
    });

    // --- Step 3: Dispatch evaluator ---
    getLogger(ctx).log(`    dispatching evaluator: ${stage.evaluator.agent}`);
    const arEvalModelEffort = resolveModelEffort(stage.evaluator, stage, ctx.pipeline, "evaluator");
    await onProgress?.("autoresearch_evaluator_start", {
      iteration: iter, maxIterations: maxIter ?? null, agent: stage.evaluator.agent,
      ...arEvalModelEffort, output: evalPath,
    });

    const evalSystemFile = await writeSystemPromptFile(evalAgent.markdown, ctx.tempTracker);
    const evalInputs = mergeInputs(stage.inputs, stage.evaluator.inputs, vars, [interpolate(stage.output, vars), groundTruthPath]);
    const evalPrompt = buildTaskContext({
      task: `Evaluate the output against the ground truth for: ${stage.name}`,
      groundTruthPath,
      inputs: evalInputs.length > 0 ? evalInputs : undefined,
      output: evalPath,
      iteration: iter,
      maxIterations: maxIter,
      evaluatorFormat: true,
    });

    const evalResult = await getDispatcher(ctx).dispatch({
      userPrompt: evalPrompt,
      systemPromptFile: evalSystemFile,
      mcpConfigFile: evalAgent.mcpFile,
      expectedOutput: evalPath,
      cwd: ctx.projectDir,
      allowedTools: stage.evaluator.allowed_tools,
      claudeConfigDir: ctx.projectConfig?.claude_config_dir,
      permissionMode: ctx.projectConfig?.permission_mode,
      agentName: `${stage.name}-evaluator`,
      streamLogDir: resolve(ctx.artifactDir, ".cccp"),
      ...resolveModelEffort(stage.evaluator, stage, ctx.pipeline, "evaluator"),
      onActivity: (activity) => activityBus.emit("activity", activity),
      quiet: ctx.quiet,
    });

    if (evalResult.exitCode !== 0) {
      throw new AgentCrashError(stage.evaluator.agent, evalResult.exitCode);
    }
    if (!evalResult.outputExists) {
      throw new MissingOutputError(stage.evaluator.agent, evalPath);
    }

    updatePgeProgress(state, stage.name, iter, "evaluator_dispatched");
    setStageArtifact(state, stage.name, `evaluation-${iter}`, evalPath);
    await onProgress?.("autoresearch_evaluator_done", {
      iteration: iter, maxIterations: maxIter ?? null,
      agent: stage.evaluator.agent, evaluationPath: evalPath,
      summary: evalResult.summary,
    });

    // --- Step 4: Parse evaluation ---
    const evaluation = await parseEvaluation(evalPath);

    if (evaluation.outcome === "parse_error") {
      getLogger(ctx).error(`    evaluation parse error: ${evaluation.error}`);
      await onProgress?.("autoresearch_evaluation", {
        iteration: iter, maxIterations: maxIter ?? null,
        outcome: "parse_error", error: evaluation.error,
      });
      return {
        outcome: "error",
        iterations: iter,
        maxIterations: maxIter,
        evaluationPath: evalPath,
        artifactPath,
        outputPath,
        durationMs: Date.now() - start,
      };
    }

    // --- Step 5: Route ---
    updatePgeProgress(state, stage.name, iter, "routed");

    if (evaluation.outcome === "pass") {
      getLogger(ctx).log(`    evaluation: PASS`);
      await onProgress?.("autoresearch_evaluation", {
        iteration: iter, maxIterations: maxIter ?? null,
        outcome: "pass",
        evaluationContent: evaluation.content ?? "",
        evaluationPath: evalPath,
        rawLine: evaluation.rawLine,
      });
      return {
        outcome: "pass",
        iterations: iter,
        maxIterations: maxIter,
        evaluationPath: evalPath,
        artifactPath,
        outputPath,
        durationMs: Date.now() - start,
      };
    }

    // FAIL
    getLogger(ctx).log(`    evaluation: FAIL`);
    lastEvalPath = evalPath;

    if (maxIter !== undefined && iter === maxIter) {
      getLogger(ctx).log(`    max iterations reached — escalating (${stage.on_fail ?? "stop"})`);
      await onProgress?.("autoresearch_evaluation", {
        iteration: iter, maxIterations: maxIter,
        outcome: "fail",
        evaluationContent: evaluation.content ?? "",
        evaluationPath: evalPath,
        rawLine: evaluation.rawLine,
        willRetry: false,
        escalation: stage.on_fail ?? "stop",
      });
      return {
        outcome: "fail",
        iterations: iter,
        maxIterations: maxIter,
        evaluationPath: evalPath,
        artifactPath,
        outputPath,
        durationMs: Date.now() - start,
      };
    }

    getLogger(ctx).log(`    retrying...`);
    await onProgress?.("autoresearch_evaluation", {
      iteration: iter, maxIterations: maxIter ?? null,
      outcome: "fail",
      evaluationContent: evaluation.content ?? "",
      evaluationPath: evalPath,
      rawLine: evaluation.rawLine,
      willRetry: true,
    });
  }

  // Should only reach here if maxIter is set (loop condition handles it),
  // but TypeScript needs the return.
  return {
    outcome: "error",
    iterations: maxIter ?? 0,
    maxIterations: maxIter,
    artifactPath,
    outputPath,
    durationMs: Date.now() - start,
  };
}
