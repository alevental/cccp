import { join, resolve } from "node:path";
import { mkdir, readFile } from "node:fs/promises";
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
import type { GeStage, GeResult, RunContext, PipelineState } from "./types.js";

function getLogger(ctx: RunContext): Logger {
  return ctx.logger ?? new ConsoleLogger();
}

function getDispatcher(ctx: RunContext): AgentDispatcher {
  return ctx.dispatcher ?? new DefaultAgentDispatcher();
}

// ---------------------------------------------------------------------------
// GE cycle
// ---------------------------------------------------------------------------

/** Options for retrying a GE cycle with existing artifacts and/or gate feedback. */
export interface GeCycleOptions {
  /** Path to gate feedback file from a human reviewer. Injected into generator prompt. */
  gateFeedbackPath?: string;
  /** Reuse an existing contract (skip contract writer). */
  existingContractPath?: string;
}

/**
 * Execute a Generate-Evaluate cycle for a GE stage (PGE without the planner).
 *
 * 0. Dispatch evaluator agent (contract mode) → contract.md
 * 1. Dispatch generator agent → deliverable
 * 2. Dispatch evaluator agent (evaluation mode) → evaluation-N.md
 * 3. Parse evaluation (regex on ### Overall: PASS/FAIL)
 * 4. Route: PASS → done, FAIL + iters left → retry, FAIL + max → escalate
 *
 * When `options.existingContractPath` is set, step 0 is skipped (used on
 * gate feedback retry to avoid regenerating the contract).
 */
export async function runGeCycle(
  stage: GeStage,
  ctx: RunContext,
  state: PipelineState,
  onProgress?: (eventType?: string, eventData?: Record<string, unknown>) => Promise<void>,
  options?: GeCycleOptions,
): Promise<GeResult> {
  const start = Date.now();
  const vars = { ...ctx.variables, ...(stage.variables ?? {}) };
  const maxIter = stage.contract.max_iterations;

  // Resolve paths for contract, deliverable, and evaluations
  const deliverable = interpolate(stage.contract.deliverable, vars);
  const deliverablePath = resolve(ctx.projectDir, deliverable);
  const stageDir = resolve(ctx.artifactDir, stage.name);
  const contractPath = resolve(stageDir, "contract.md");

  // Compute outputs path if this stage declares structured outputs.
  const outputsPath = stage.outputs && Object.keys(stage.outputs).length > 0
    ? join(stageDir, ".outputs.json")
    : undefined;

  await mkdir(stageDir, { recursive: true });

  // --- Dry-run: show what would happen ---
  if (ctx.dryRun) {
    const logger = getLogger(ctx);
    logger.log("\n[dry-run] GE Stage:", stage.name);
    logger.log("  contract:    ", contractPath);
    logger.log("  deliverable: ", deliverablePath);
    logger.log("  generator:   ", stage.generator.agent);
    if (stage.generator.operation) {
      logger.log("  gen operation:", stage.generator.operation);
    }
    logger.log("  evaluator:   ", stage.evaluator.agent);
    if (stage.evaluator.operation) {
      logger.log("  eval operation:", stage.evaluator.operation);
    }
    logger.log("  max iters:   ", maxIter);
    logger.log("  on_fail:     ", stage.on_fail ?? "stop");
    if (stage.contract.guidance) {
      logger.log("  guidance:     (present)");
    }
    if (stage.contract.template) {
      logger.log("  template:    ", stage.contract.template);
    }
    return {
      outcome: "pass",
      iterations: 0,
      maxIterations: maxIter,
      contractPath,
      durationMs: 0,
    };
  }

  // --- Resolve task body (file or inline) ---
  const taskBody = await resolveTaskBody(stage, vars, `Generate deliverable for: ${stage.name}`);

  // --- Resolve all agents via search paths ---
  const genAgent = await resolveAndLoad(stage.generator, ctx, stage.mcp_profile);
  const evalAgent = await resolveAndLoad(stage.evaluator, ctx, stage.mcp_profile);

  // --- Contract phase: skip when reusing existing contract (gate feedback retry) ---
  let effectiveContractPath = contractPath;
  let contractSummary: string | undefined;

  if (options?.existingContractPath) {
    effectiveContractPath = options.existingContractPath;
    getLogger(ctx).log(`    reusing existing contract (gate feedback retry)`);
  } else {
    // --- Step 0: Dispatch evaluator for contract writing ---
    // The contract writer receives the same context the generator will get
    // (task + inputs), but is explicitly told to write acceptance criteria.
    getLogger(ctx).log(`    dispatching contract writer: ${stage.evaluator.agent}`);
    const contractModelEffort = resolveModelEffort(stage.evaluator, stage, ctx.pipeline, "evaluator");
    await onProgress?.("ge_contract_start", {
      agent: stage.evaluator.agent,
      ...contractModelEffort,
      output: contractPath,
    });

    // Merge all inputs that the generator will see so the contract writer
    // has full context for writing criteria.
    const contractInputs = mergeInputs(stage.inputs, stage.evaluator.inputs, vars);
    const genInputsForContext = mergeInputs(stage.inputs, stage.generator.inputs, vars);
    const allContractInputs = [...new Set([...contractInputs, ...genInputsForContext])];

    const templatePath = stage.contract.template
      ? resolve(ctx.projectDir, interpolate(stage.contract.template, vars))
      : undefined;
    const contractPrompt = buildTaskContext({
      task: `Write the acceptance criteria contract for: ${stage.name}`,
      inputs: allContractInputs.length > 0 ? allContractInputs : undefined,
      output: contractPath,
      contractTemplate: templatePath,
      guidance: stage.contract.guidance,
      deliverableInfo: `The generator will produce: ${deliverable}\nWrite your contract criteria to verify this deliverable.\nMax iterations: ${maxIter}`,
    });

    const contractSystemFile = await writeSystemPromptFile(evalAgent.markdown, ctx.tempTracker);
    const contractResult = await getDispatcher(ctx).dispatch({
      userPrompt: contractPrompt,
      systemPromptFile: contractSystemFile,
      mcpConfigFile: evalAgent.mcpFile,
      expectedOutput: contractPath,
      cwd: ctx.projectDir,
      allowedTools: stage.evaluator.allowed_tools,
      claudeConfigDir: ctx.projectConfig?.claude_config_dir,
      permissionMode: ctx.projectConfig?.permission_mode,
      agentName: `${stage.name}-contract`,
      streamLogDir: resolve(ctx.artifactDir, ".cccp"),
      ...contractModelEffort,
      onActivity: (activity) => activityBus.emit("activity", activity),
      quiet: ctx.quiet,
    });

    if (contractResult.exitCode !== 0) {
      throw new AgentCrashError(stage.evaluator.agent, contractResult.exitCode);
    }
    if (!contractResult.outputExists) {
      throw new MissingOutputError(stage.evaluator.agent, contractPath);
    }

    setStageArtifact(state, stage.name, "contract", contractPath);
    updatePgeProgress(state, stage.name, 0, "contract_dispatched");
    contractSummary = contractResult.summary;
    getLogger(ctx).log(`    contract written: ${contractPath}`);
  }

  let contractContent = "";
  try { contractContent = await readFile(effectiveContractPath, "utf-8"); } catch { /* ignore */ }

  if (!options?.existingContractPath) {
    await onProgress?.("ge_contract_done", {
      agent: stage.evaluator.agent, contractPath: effectiveContractPath, contractContent,
      summary: contractSummary,
    });
  }

  // Emit ge_start to signal the GE loop is beginning.
  await onProgress?.("ge_start", {
    generator: stage.generator.agent,
    evaluator: stage.evaluator.agent,
    deliverable,
    maxIterations: maxIter,
    contractPath: effectiveContractPath,
    contractContent,
  });

  // --- GE Iteration loop ---
  let lastEvalPath: string | undefined;

  for (let iter = 1; iter <= maxIter; iter++) {
    getLogger(ctx).log(`    iteration ${iter}/${maxIter}`);
    const evalPath = resolve(stageDir, `evaluation-${iter}.md`);

    // --- Step 1: Dispatch generator ---
    const genSystemFile = await writeSystemPromptFile(genAgent.markdown, ctx.tempTracker);
    const genInputs = mergeInputs(stage.inputs, stage.generator.inputs, vars);
    const genPrompt = buildTaskContext({
      task: taskBody,
      contractPath: effectiveContractPath,
      inputs: genInputs.length > 0 ? genInputs : undefined,
      output: deliverable,
      previousEvaluation: lastEvalPath,
      gateFeedback: options?.gateFeedbackPath,
      iteration: iter,
      maxIterations: maxIter,
      outputsPath,
      outputKeys: stage.outputs,
    });

    getLogger(ctx).log(`    dispatching generator: ${stage.generator.agent}`);
    const genModelEffort = resolveModelEffort(stage.generator, stage, ctx.pipeline, "generator");
    await onProgress?.("ge_generator_start", {
      iteration: iter, maxIterations: maxIter, agent: stage.generator.agent,
      ...genModelEffort,
      inputs: genInputs, output: deliverable,
    });
    const genResult = await getDispatcher(ctx).dispatch({
      userPrompt: genPrompt,
      systemPromptFile: genSystemFile,
      mcpConfigFile: genAgent.mcpFile,
      expectedOutput: deliverablePath,
      cwd: ctx.projectDir,
      allowedTools: stage.generator.allowed_tools,
      claudeConfigDir: ctx.projectConfig?.claude_config_dir,
      permissionMode: ctx.projectConfig?.permission_mode,
      agentName: `${stage.name}-generator`,
      streamLogDir: resolve(ctx.artifactDir, ".cccp"),
      ...genModelEffort,
      onActivity: (activity) => activityBus.emit("activity", activity),
      quiet: ctx.quiet,
    });

    if (genResult.exitCode !== 0) {
      throw new AgentCrashError(stage.generator.agent, genResult.exitCode);
    }
    if (!genResult.outputExists) {
      throw new MissingOutputError(stage.generator.agent, deliverable);
    }

    // Persist generator completion.
    updatePgeProgress(state, stage.name, iter, "generator_dispatched");
    setStageArtifact(state, stage.name, "deliverable", deliverablePath);
    await onProgress?.("ge_generator_done", {
      iteration: iter, maxIterations: maxIter,
      agent: stage.generator.agent, deliverablePath,
      summary: genResult.summary,
    });

    // --- Step 2: Dispatch evaluator ---
    const evalSystemFile = await writeSystemPromptFile(evalAgent.markdown, ctx.tempTracker);
    const evalInputs = mergeInputs(stage.inputs, stage.evaluator.inputs, vars, [deliverable]);

    // If the stage declares structured outputs, instruct the evaluator to verify
    // that .outputs.json exists and contains the required keys.
    let evalOutputsGuidance: string | undefined;
    if (outputsPath && stage.outputs && Object.keys(stage.outputs).length > 0) {
      const keys = Object.keys(stage.outputs);
      evalOutputsGuidance = [
        `**Structured Outputs Check (REQUIRED):** This stage declares structured outputs.`,
        `The generator must have written a JSON file at: ${outputsPath}`,
        `The file must be a flat JSON object containing these keys: ${keys.map(k => `"${k}"`).join(", ")}.`,
        `If the file does not exist or is missing required keys, the evaluation MUST FAIL regardless of other criteria.`,
      ].join("\n");
    }

    const evalPrompt = buildTaskContext({
      task: `Evaluate the deliverable against the contract for: ${stage.name}`,
      contractPath: effectiveContractPath,
      inputs: evalInputs.length > 0 ? evalInputs : undefined,
      output: evalPath,
      iteration: iter,
      maxIterations: maxIter,
      evaluatorFormat: true,
      guidance: evalOutputsGuidance,
    });

    getLogger(ctx).log(`    dispatching evaluator: ${stage.evaluator.agent}`);
    const evalModelEffort = resolveModelEffort(stage.evaluator, stage, ctx.pipeline, "evaluator");
    await onProgress?.("ge_evaluator_start", {
      iteration: iter, maxIterations: maxIter, agent: stage.evaluator.agent,
      ...evalModelEffort,
      inputs: evalInputs, output: evalPath,
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

    // Persist evaluator completion.
    updatePgeProgress(state, stage.name, iter, "evaluator_dispatched");
    setStageArtifact(state, stage.name, `evaluation-${iter}`, evalPath);
    await onProgress?.("ge_evaluator_done", {
      iteration: iter, maxIterations: maxIter,
      agent: stage.evaluator.agent, evaluationPath: evalPath,
      summary: evalResult.summary,
    });

    // --- Step 3: Parse evaluation ---
    const evaluation = await parseEvaluation(evalPath);

    if (evaluation.outcome === "parse_error") {
      getLogger(ctx).error(`    evaluation parse error: ${evaluation.error}`);
      await onProgress?.("ge_evaluation", {
        iteration: iter, maxIterations: maxIter,
        outcome: "parse_error", error: evaluation.error,
      });
      return {
        outcome: "error",
        iterations: iter,
        maxIterations: maxIter,
        evaluationPath: evalPath,
        contractPath: effectiveContractPath,
        durationMs: Date.now() - start,
      };
    }

    // --- Step 4: Route ---
    updatePgeProgress(state, stage.name, iter, "routed");

    if (evaluation.outcome === "pass") {
      getLogger(ctx).log(`    evaluation: PASS`);
      await onProgress?.("ge_evaluation", {
        iteration: iter, maxIterations: maxIter,
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
        contractPath: effectiveContractPath,
        durationMs: Date.now() - start,
      };
    }

    // FAIL — check if retries remain
    getLogger(ctx).log(`    evaluation: FAIL`);
    lastEvalPath = evalPath;

    if (iter === maxIter) {
      getLogger(ctx).log(`    max iterations reached — escalating (${stage.on_fail ?? "stop"})`);
      await onProgress?.("ge_evaluation", {
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
        contractPath: effectiveContractPath,
        durationMs: Date.now() - start,
      };
    }

    getLogger(ctx).log(`    retrying...`);
    await onProgress?.("ge_evaluation", {
      iteration: iter, maxIterations: maxIter,
      outcome: "fail",
      evaluationContent: evaluation.content ?? "",
      evaluationPath: evalPath,
      rawLine: evaluation.rawLine,
      willRetry: true,
    });
  }

  // Should never reach here, but TypeScript needs it
  return {
    outcome: "error",
    iterations: maxIter,
    maxIterations: maxIter,
    contractPath: effectiveContractPath,
    durationMs: Date.now() - start,
  };
}

// ---------------------------------------------------------------------------
// Dispatch evaluator with human gate feedback (for human_review retry)
// ---------------------------------------------------------------------------

/**
 * Dispatch the evaluator agent with a human reviewer's feedback file.
 * The evaluator incorporates the feedback into a structured FAIL evaluation
 * that the generator can consume on retry via `previousEvaluation`.
 *
 * Returns the path to the evaluation file.
 */
export async function dispatchGeEvaluatorWithFeedback(
  stage: GeStage,
  ctx: RunContext,
  state: PipelineState,
  geResult: GeResult,
  feedbackPath: string,
  onProgress?: (eventType?: string, eventData?: Record<string, unknown>) => Promise<void>,
): Promise<string> {
  const vars = { ...ctx.variables, ...(stage.variables ?? {}) };
  const deliverable = interpolate(stage.contract.deliverable, vars);
  const stageDir = resolve(ctx.artifactDir, stage.name);
  const evalAgent = await resolveAndLoad(stage.evaluator, ctx, stage.mcp_profile);

  // Use a dedicated evaluation filename to avoid colliding with normal evaluations.
  const evalPath = resolve(stageDir, `evaluation-human-review-${Date.now()}.md`);

  const evalSystemFile = await writeSystemPromptFile(evalAgent.markdown, ctx.tempTracker);
  const evalInputs = mergeInputs(stage.inputs, stage.evaluator.inputs, vars, [deliverable, feedbackPath]);
  const evalPrompt = buildTaskContext({
    task: `A human reviewer has rejected the deliverable for: ${stage.name}. Read their feedback and incorporate their concerns into your evaluation. Your evaluation MUST result in FAIL with specific criteria addressing the reviewer's feedback.`,
    contractPath: geResult.contractPath,
    inputs: evalInputs.length > 0 ? evalInputs : undefined,
    output: evalPath,
    gateFeedback: feedbackPath,
    evaluatorFormat: true,
  });

  getLogger(ctx).log(`    dispatching evaluator with human feedback`);
  await onProgress?.("ge_evaluator_start", {
    iteration: 0, maxIterations: stage.contract.max_iterations,
    agent: stage.evaluator.agent, humanReview: true,
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
    agentName: `${stage.name}-evaluator-review`,
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

  setStageArtifact(state, stage.name, "evaluation-human-review", evalPath);
  await onProgress?.("ge_evaluator_done", {
    iteration: 0, maxIterations: stage.contract.max_iterations,
    agent: stage.evaluator.agent, evaluationPath: evalPath, humanReview: true,
    summary: evalResult.summary,
  });

  return evalPath;
}
