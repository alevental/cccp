import { resolve } from "node:path";
import { mkdir } from "node:fs/promises";
import { dispatchAgent } from "./agent.js";
import { resolveAgent } from "./agent-resolver.js";
import { writeContract } from "./contract.js";
import { parseEvaluation } from "./evaluator.js";
import { AgentCrashError, MissingOutputError } from "./errors.js";
import { writeMcpConfigFile } from "./mcp-config.js";
import {
  interpolate,
  loadAgentMarkdown,
  buildTaskContext,
  writeSystemPromptFile,
} from "./prompt.js";
import {
  saveState,
  loadState,
  updatePgeProgress,
  setStageArtifact,
} from "./state.js";
import type { PgeStage, PgeResult, RunContext } from "./types.js";

// ---------------------------------------------------------------------------
// PGE cycle
// ---------------------------------------------------------------------------

/**
 * Execute a full Plan-Generate-Evaluate cycle for a PGE stage.
 *
 * 1. Write contract from template + YAML criteria
 * 2. Dispatch generator agent
 * 3. Dispatch evaluator agent
 * 4. Parse evaluation (regex on ### Overall: PASS/FAIL)
 * 5. Route: PASS → done, FAIL + iters left → retry, FAIL + max → escalate
 */
export async function runPgeCycle(
  stage: PgeStage,
  ctx: RunContext,
): Promise<PgeResult> {
  const start = Date.now();
  const vars = { ...ctx.variables, ...(stage.variables ?? {}) };
  const maxIter = stage.contract.max_iterations;

  // Resolve paths for contract, deliverable, and evaluations
  const deliverable = interpolate(stage.contract.deliverable, vars);
  const deliverablePath = resolve(ctx.projectDir, deliverable);
  const stageDir = resolve(ctx.artifactDir, stage.name);
  const contractPath = resolve(stageDir, "contract.md");

  await mkdir(stageDir, { recursive: true });

  // --- Dry-run: show what would happen ---
  if (ctx.dryRun) {
    console.log("\n[dry-run] PGE Stage:", stage.name);
    console.log("  contract:    ", contractPath);
    console.log("  deliverable: ", deliverablePath);
    console.log("  generator:   ", stage.generator.agent);
    if (stage.generator.operation) {
      console.log("  gen operation:", stage.generator.operation);
    }
    console.log("  evaluator:   ", stage.evaluator.agent);
    if (stage.evaluator.operation) {
      console.log("  eval operation:", stage.evaluator.operation);
    }
    console.log("  max iters:   ", maxIter);
    console.log("  on_fail:     ", stage.on_fail ?? "stop");
    console.log("  criteria:");
    for (const c of stage.contract.criteria) {
      console.log(`    - ${c.name}: ${c.description}`);
    }
    return {
      outcome: "pass",
      iterations: 0,
      maxIterations: maxIter,
      contractPath,
      durationMs: 0,
    };
  }

  // --- Step 1: Write contract ---
  await writeContract(contractPath, {
    stageName: stage.name,
    deliverable,
    criteria: stage.contract.criteria,
    maxIterations: maxIter,
    templatePath: stage.contract.template
      ? resolve(ctx.projectDir, stage.contract.template)
      : undefined,
  });
  console.log(`    contract written: ${contractPath}`);

  // Persist contract artifact path to state.
  if (!ctx.dryRun) {
    const state = await loadState(ctx.artifactDir);
    if (state) {
      setStageArtifact(state, stage.name, "contract", contractPath);
      updatePgeProgress(state, stage.name, 0, "contract_written");
      await saveState(ctx.artifactDir, state);
    }
  }

  // --- Resolve agents via search paths ---
  const genResolved = await resolveAgent(
    stage.generator.agent,
    ctx.agentSearchPaths,
    stage.generator.operation,
    ctx.projectDir,
  );
  const genMarkdown = await loadAgentMarkdown(
    genResolved.agentPath,
    genResolved.operationPath,
  );

  const evalResolved = await resolveAgent(
    stage.evaluator.agent,
    ctx.agentSearchPaths,
    stage.evaluator.operation,
    ctx.projectDir,
  );
  const evalMarkdown = await loadAgentMarkdown(
    evalResolved.agentPath,
    evalResolved.operationPath,
  );

  // --- Resolve MCP configs ---
  const genMcpProfile = stage.generator.mcp_profile ?? stage.mcp_profile;
  const evalMcpProfile = stage.evaluator.mcp_profile ?? stage.mcp_profile;
  const genMcpFile = ctx.projectConfig
    ? await writeMcpConfigFile(genMcpProfile, ctx.projectConfig)
    : undefined;
  const evalMcpFile = ctx.projectConfig
    ? await writeMcpConfigFile(evalMcpProfile, ctx.projectConfig)
    : undefined;

  // --- Iteration loop ---
  let lastEvalPath: string | undefined;

  for (let iter = 1; iter <= maxIter; iter++) {
    console.log(`    iteration ${iter}/${maxIter}`);
    const evalPath = resolve(stageDir, `evaluation-${iter}.md`);

    // --- Step 2: Dispatch generator ---
    const genSystemFile = await writeSystemPromptFile(genMarkdown);
    const genPrompt = buildTaskContext({
      task: stage.description ?? `Generate deliverable for: ${stage.name}`,
      contractPath,
      output: deliverable,
      previousEvaluation: lastEvalPath,
      iteration: iter,
      maxIterations: maxIter,
    });

    console.log(`    dispatching generator: ${stage.generator.agent}`);
    const genResult = await dispatchAgent({
      userPrompt: genPrompt,
      systemPromptFile: genSystemFile,
      mcpConfigFile: genMcpFile,
      expectedOutput: deliverablePath,
      cwd: ctx.projectDir,
      allowedTools: stage.generator.allowed_tools,
    });

    if (genResult.exitCode !== 0) {
      throw new AgentCrashError(stage.generator.agent, genResult.exitCode);
    }
    if (!genResult.outputExists) {
      throw new MissingOutputError(stage.generator.agent, deliverable);
    }

    // Persist generator completion.
    if (!ctx.dryRun) {
      const state = await loadState(ctx.artifactDir);
      if (state) {
        updatePgeProgress(state, stage.name, iter, "generator_dispatched");
        setStageArtifact(state, stage.name, "deliverable", deliverablePath);
        await saveState(ctx.artifactDir, state);
      }
    }

    // --- Step 3: Dispatch evaluator ---
    const evalSystemFile = await writeSystemPromptFile(evalMarkdown);
    const evalPrompt = buildTaskContext({
      task: `Evaluate the deliverable against the contract for: ${stage.name}`,
      contractPath,
      inputs: [deliverable],
      output: evalPath,
      iteration: iter,
      maxIterations: maxIter,
    });

    console.log(`    dispatching evaluator: ${stage.evaluator.agent}`);
    const evalResult = await dispatchAgent({
      userPrompt: evalPrompt,
      systemPromptFile: evalSystemFile,
      mcpConfigFile: evalMcpFile,
      expectedOutput: evalPath,
      cwd: ctx.projectDir,
      allowedTools: stage.evaluator.allowed_tools,
    });

    if (evalResult.exitCode !== 0) {
      throw new AgentCrashError(stage.evaluator.agent, evalResult.exitCode);
    }
    if (!evalResult.outputExists) {
      throw new MissingOutputError(stage.evaluator.agent, evalPath);
    }

    // Persist evaluator completion.
    if (!ctx.dryRun) {
      const state = await loadState(ctx.artifactDir);
      if (state) {
        updatePgeProgress(state, stage.name, iter, "evaluator_dispatched");
        setStageArtifact(state, stage.name, `evaluation-${iter}`, evalPath);
        await saveState(ctx.artifactDir, state);
      }
    }

    // --- Step 4: Parse evaluation ---
    const evaluation = await parseEvaluation(evalPath);

    if (evaluation.outcome === "parse_error") {
      console.error(`    evaluation parse error: ${evaluation.error}`);
      return {
        outcome: "error",
        iterations: iter,
        maxIterations: maxIter,
        evaluationPath: evalPath,
        contractPath,
        durationMs: Date.now() - start,
      };
    }

    // --- Step 5: Route ---
    // Persist routing decision.
    if (!ctx.dryRun) {
      const state = await loadState(ctx.artifactDir);
      if (state) {
        updatePgeProgress(state, stage.name, iter, "routed");
        await saveState(ctx.artifactDir, state);
      }
    }

    if (evaluation.outcome === "pass") {
      console.log(`    evaluation: PASS`);
      return {
        outcome: "pass",
        iterations: iter,
        maxIterations: maxIter,
        evaluationPath: evalPath,
        contractPath,
        durationMs: Date.now() - start,
      };
    }

    // FAIL — check if retries remain
    console.log(`    evaluation: FAIL`);
    lastEvalPath = evalPath;

    if (iter === maxIter) {
      // Max iterations reached — escalate
      console.log(`    max iterations reached — escalating (${stage.on_fail ?? "stop"})`);
      return {
        outcome: "fail",
        iterations: iter,
        maxIterations: maxIter,
        evaluationPath: evalPath,
        contractPath,
        durationMs: Date.now() - start,
      };
    }

    console.log(`    retrying...`);
  }

  // Should never reach here, but TypeScript needs it
  return {
    outcome: "error",
    iterations: maxIter,
    maxIterations: maxIter,
    contractPath,
    durationMs: Date.now() - start,
  };
}
