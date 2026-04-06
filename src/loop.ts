import { resolve } from "node:path";
import { mkdir } from "node:fs/promises";
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
import type { LoopStage, LoopResult, RunContext, PipelineState } from "./types.js";

function getLogger(ctx: RunContext): Logger {
  return ctx.logger ?? new ConsoleLogger();
}

function getDispatcher(ctx: RunContext): AgentDispatcher {
  return ctx.dispatcher ?? new DefaultAgentDispatcher();
}

// ---------------------------------------------------------------------------
// Loop cycle
// ---------------------------------------------------------------------------

/** Options for retrying a loop cycle with gate feedback. */
export interface LoopCycleOptions {
  /** Path to gate feedback file from a human reviewer. Injected into first active body stage prompt. */
  gateFeedbackPath?: string;
}

/**
 * Execute a full loop cycle: dispatch body stages, evaluate, retry on FAIL.
 *
 * 1. For each body stage (skip if skip_first && iter == 1):
 *    - Dispatch body agent (with previousEvaluation on iter > 1)
 * 2. Dispatch evaluator (with evaluatorFormat: true)
 * 3. Parse evaluation → PASS/FAIL/parse_error
 * 4. Route: PASS → done, FAIL + iters left → retry, FAIL + max → escalate
 */
export async function runLoopCycle(
  stage: LoopStage,
  ctx: RunContext,
  state: PipelineState,
  onProgress?: (eventType?: string, eventData?: Record<string, unknown>) => Promise<void>,
  options?: LoopCycleOptions,
): Promise<LoopResult> {
  const start = Date.now();
  const vars = { ...ctx.variables, ...(stage.variables ?? {}) };
  const maxIter = stage.max_iterations;
  const stageDir = resolve(ctx.artifactDir, stage.name);

  await mkdir(stageDir, { recursive: true });

  // --- Dry-run ---
  if (ctx.dryRun) {
    const logger = getLogger(ctx);
    logger.log("\n[dry-run] Loop Stage:", stage.name);
    logger.log("  body stages: ", stage.stages.map((s) => s.name).join(", "));
    logger.log("  evaluator:   ", stage.evaluator.agent);
    logger.log("  max_iters:   ", maxIter);
    logger.log("  on_fail:     ", stage.on_fail ?? "stop");
    return {
      outcome: "pass",
      iterations: 0,
      maxIterations: maxIter,
      durationMs: 0,
    };
  }

  // --- Resolve all agents upfront ---
  const bodyAgents = await Promise.all(
    stage.stages.map((bs) =>
      resolveAndLoad(
        { agent: bs.agent, operation: bs.operation, mcp_profile: bs.mcp_profile, allowed_tools: bs.allowed_tools, inputs: bs.inputs, model: bs.model, effort: bs.effort },
        ctx,
        stage.mcp_profile,
      ),
    ),
  );
  const evalAgent = await resolveAndLoad(stage.evaluator, ctx, stage.mcp_profile);

  // --- Resolve task body (file or inline) ---
  const taskBody = await resolveTaskBody(stage, vars, `Complete the loop task: ${stage.name}`);

  await onProgress?.("loop_start", {
    stages: stage.stages.map((s) => s.name),
    evaluator: stage.evaluator.agent,
    maxIterations: maxIter,
  });

  // --- Iteration loop ---
  let lastEvalPath: string | undefined;

  for (let iter = 1; iter <= maxIter; iter++) {
    getLogger(ctx).log(`    iteration ${iter}/${maxIter}`);

    // --- Dispatch body stages ---
    let firstActiveBody = true;
    for (let bi = 0; bi < stage.stages.length; bi++) {
      const bodyStage = stage.stages[bi];

      // skip_first on iteration 1
      if (bodyStage.skip_first && iter === 1) continue;

      const bodyAgent = bodyAgents[bi];
      const bodyAgentName = `${stage.name}-${bodyStage.name}`;
      const bodyModelEffort = resolveModelEffort(
        { model: bodyStage.model, effort: bodyStage.effort },
        stage,
        ctx.pipeline,
      );

      const bodyOutput = bodyStage.output
        ? resolve(ctx.projectDir, interpolate(bodyStage.output, vars))
        : undefined;

      await onProgress?.("loop_body_start", {
        iteration: iter,
        maxIterations: maxIter,
        bodyName: bodyStage.name,
        agent: bodyStage.agent,
        ...bodyModelEffort,
        output: bodyStage.output ? interpolate(bodyStage.output, vars) : undefined,
      });

      getLogger(ctx).log(`    dispatching body: ${bodyStage.name} [${bodyStage.agent}]`);

      // Resolve body stage task
      const bodyTaskBody = await resolveTaskBody(
        { task: bodyStage.task, task_file: bodyStage.task_file, name: bodyStage.name },
        vars,
        taskBody,
      );

      const bodySystemFile = await writeSystemPromptFile(bodyAgent.markdown, ctx.tempTracker);
      const bodyInputs = mergeInputs(stage.inputs, bodyStage.inputs, vars);
      const bodyPrompt = buildTaskContext({
        task: bodyTaskBody,
        inputs: bodyInputs.length > 0 ? bodyInputs : undefined,
        output: bodyOutput ? interpolate(bodyStage.output!, vars) : undefined,
        previousEvaluation: firstActiveBody ? lastEvalPath : undefined,
        gateFeedback: firstActiveBody ? options?.gateFeedbackPath : undefined,
        iteration: iter,
        maxIterations: maxIter,
      });

      if (bodyOutput) {
        await mkdir(resolve(bodyOutput, ".."), { recursive: true }).catch(() => {});
      }

      const bodyResult = await getDispatcher(ctx).dispatch({
        userPrompt: bodyPrompt,
        systemPromptFile: bodySystemFile,
        mcpConfigFile: bodyAgent.mcpFile,
        expectedOutput: bodyOutput,
        cwd: ctx.projectDir,
        allowedTools: bodyStage.allowed_tools,
        claudeConfigDir: ctx.projectConfig?.claude_config_dir,
        permissionMode: ctx.projectConfig?.permission_mode,
        agentName: bodyAgentName,
        streamLogDir: resolve(ctx.artifactDir, ".cccp"),
        ...bodyModelEffort,
        onActivity: (activity) => activityBus.emit("activity", activity),
        quiet: ctx.quiet,
      });

      if (bodyResult.exitCode !== 0) {
        throw new AgentCrashError(bodyStage.agent, bodyResult.exitCode);
      }
      if (bodyOutput && !bodyResult.outputExists) {
        throw new MissingOutputError(bodyStage.agent, interpolate(bodyStage.output!, vars));
      }

      updatePgeProgress(state, stage.name, iter, `body_${bodyStage.name}_dispatched`);
      await onProgress?.("loop_body_done", {
        iteration: iter,
        maxIterations: maxIter,
        bodyName: bodyStage.name,
        agent: bodyStage.agent,
        summary: bodyResult.summary,
      });

      firstActiveBody = false;
    }

    // --- Dispatch evaluator ---
    const evalPath = resolve(stageDir, `evaluation-${iter}.md`);
    getLogger(ctx).log(`    dispatching evaluator: ${stage.evaluator.agent}`);
    const evalModelEffort = resolveModelEffort(stage.evaluator, stage, ctx.pipeline, "evaluator");

    await onProgress?.("loop_evaluator_start", {
      iteration: iter,
      maxIterations: maxIter,
      agent: stage.evaluator.agent,
      ...evalModelEffort,
    });

    const evalSystemFile = await writeSystemPromptFile(evalAgent.markdown, ctx.tempTracker);
    const evalInputs = mergeInputs(stage.inputs, stage.evaluator.inputs, vars);
    const evalPrompt = buildTaskContext({
      task: `Evaluate the work done for: ${stage.name}. ${taskBody}`,
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
      ...evalModelEffort,
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

    await onProgress?.("loop_evaluator_done", {
      iteration: iter,
      maxIterations: maxIter,
      agent: stage.evaluator.agent,
      evaluationPath: evalPath,
      summary: evalResult.summary,
    });

    // --- Parse evaluation ---
    const evaluation = await parseEvaluation(evalPath);

    if (evaluation.outcome === "parse_error") {
      getLogger(ctx).error(`    evaluation parse error: ${evaluation.error}`);
      await onProgress?.("loop_evaluation", {
        iteration: iter,
        maxIterations: maxIter,
        outcome: "parse_error",
        error: evaluation.error,
      });
      return {
        outcome: "error",
        iterations: iter,
        maxIterations: maxIter,
        evaluationPath: evalPath,
        durationMs: Date.now() - start,
      };
    }

    // --- Route ---
    updatePgeProgress(state, stage.name, iter, "routed");

    if (evaluation.outcome === "pass") {
      getLogger(ctx).log(`    evaluation: PASS`);
      await onProgress?.("loop_evaluation", {
        iteration: iter,
        maxIterations: maxIter,
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
        durationMs: Date.now() - start,
      };
    }

    // FAIL
    getLogger(ctx).log(`    evaluation: FAIL`);
    lastEvalPath = evalPath;

    if (iter === maxIter) {
      getLogger(ctx).log(`    max iterations reached — escalating (${stage.on_fail ?? "stop"})`);
      await onProgress?.("loop_evaluation", {
        iteration: iter,
        maxIterations: maxIter,
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
        durationMs: Date.now() - start,
      };
    }

    getLogger(ctx).log(`    retrying...`);
    await onProgress?.("loop_evaluation", {
      iteration: iter,
      maxIterations: maxIter,
      outcome: "fail",
      evaluationContent: evaluation.content ?? "",
      evaluationPath: evalPath,
      rawLine: evaluation.rawLine,
      willRetry: true,
    });
  }

  // Should not reach here (loop condition handles it), but TypeScript needs the return.
  return {
    outcome: "error",
    iterations: maxIter,
    maxIterations: maxIter,
    durationMs: Date.now() - start,
  };
}
