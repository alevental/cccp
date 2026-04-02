import { readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import type { Pipeline, Stage } from "./types.js";
import { isParallelGroup } from "./types.js";

// ---------------------------------------------------------------------------
// Zod schemas — validate raw YAML into typed Pipeline objects
// ---------------------------------------------------------------------------

const AgentStageSchema = z.object({
  name: z.string(),
  task: z.string().optional(),
  task_file: z.string().optional(),
  type: z.literal("agent"),
  agent: z.string(),
  operation: z.string().optional(),
  mcp_profile: z.string().optional(),
  inputs: z.array(z.string()).optional(),
  output: z.string().optional(),
  allowed_tools: z.array(z.string()).optional(),
  variables: z.record(z.string()).optional(),
});

const PgeAgentConfigSchema = z.object({
  agent: z.string(),
  operation: z.string().optional(),
  mcp_profile: z.string().optional(),
  allowed_tools: z.array(z.string()).optional(),
  inputs: z.array(z.string()).optional(),
});

const PgeStageSchema = z.object({
  name: z.string(),
  task: z.string().optional(),
  task_file: z.string().optional(),
  type: z.literal("pge"),
  mcp_profile: z.string().optional(),
  plan: z.string().optional(),
  inputs: z.array(z.string()).optional(),
  planner: PgeAgentConfigSchema,
  generator: PgeAgentConfigSchema,
  evaluator: PgeAgentConfigSchema,
  contract: z.object({
    deliverable: z.string(),
    template: z.string().optional(),
    guidance: z.string().optional(),
    max_iterations: z.number().int().min(1).max(10),
  }),
  on_fail: z.enum(["stop", "human_gate", "skip"]).optional(),
  variables: z.record(z.string()).optional(),
});

const AutoresearchStageSchema = z.object({
  name: z.string(),
  task: z.string().optional(),
  task_file: z.string().optional(),
  type: z.literal("autoresearch"),
  mcp_profile: z.string().optional(),
  artifact: z.string(),
  ground_truth: z.string(),
  output: z.string(),
  inputs: z.array(z.string()).optional(),
  adjuster: PgeAgentConfigSchema,
  executor: PgeAgentConfigSchema,
  evaluator: PgeAgentConfigSchema,
  max_iterations: z.number().int().min(1).optional(),
  on_fail: z.enum(["stop", "human_gate", "skip"]).optional(),
  variables: z.record(z.string()).optional(),
});

const HumanGateStageSchema = z.object({
  name: z.string(),
  task: z.string().optional(),
  task_file: z.string().optional(),
  type: z.literal("human_gate"),
  mcp_profile: z.string().optional(),
  artifacts: z.array(z.string()).optional(),
  prompt: z.string().optional(),
  on_reject: z.enum(["retry", "stop"]).optional(),
  variables: z.record(z.string()).optional(),
});

const PipelineStageSchema = z.object({
  name: z.string(),
  task: z.string().optional(),
  task_file: z.string().optional(),
  type: z.literal("pipeline"),
  file: z.string(),
  artifact_dir: z.string().optional(),
  on_fail: z.enum(["stop", "human_gate", "skip"]).optional(),
  variables: z.record(z.string()).optional(),
});

const StageSchema = z.discriminatedUnion("type", [
  AgentStageSchema,
  PgeStageSchema,
  HumanGateStageSchema,
  AutoresearchStageSchema,
  PipelineStageSchema,
]);

const ParallelGroupSchema = z.object({
  parallel: z.object({
    on_failure: z.enum(["fail_fast", "wait_all"]).optional(),
    stages: z.array(StageSchema).min(2, "Parallel groups must contain at least 2 stages"),
  }),
});

const StageEntrySchema = z.union([StageSchema, ParallelGroupSchema]);

const PipelineSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  variables: z.record(z.string()).optional(),
  stages: z.array(StageEntrySchema).min(1),
}).superRefine((pipeline, ctx) => {
  // Collect all stage names and validate parallel group constraints.
  const allNames = new Set<string>();
  const issues: string[] = [];

  for (const entry of pipeline.stages) {
    if ("parallel" in entry && !("type" in entry)) {
      // Parallel group — validate inner stages
      const group = entry as z.infer<typeof ParallelGroupSchema>;
      const groupOutputs = new Map<string, string>(); // output path → stage name

      for (const stage of group.parallel.stages) {
        // No human_gate inside parallel groups
        if (stage.type === "human_gate") {
          issues.push(`Stage '${stage.name}' is type human_gate and cannot be inside a parallel group (gates block execution)`);
        }
        // No pipeline stages inside parallel groups
        if (stage.type === "pipeline") {
          issues.push(`Stage '${stage.name}' is type pipeline and cannot be inside a parallel group`);
        }
        // Duplicate name check
        if (allNames.has(stage.name)) {
          issues.push(`Duplicate stage name '${stage.name}'`);
        }
        allNames.add(stage.name);

        // Conflicting output paths within group
        const outputPath =
          stage.type === "agent" ? stage.output :
          stage.type === "pge" ? stage.contract?.deliverable :
          stage.type === "autoresearch" ? stage.output :
          undefined;
        if (outputPath) {
          const existing = groupOutputs.get(outputPath);
          if (existing) {
            issues.push(`Stages '${existing}' and '${stage.name}' in the same parallel group both write to '${outputPath}'`);
          }
          groupOutputs.set(outputPath, stage.name);
        }
      }
    } else {
      // Regular stage
      const stage = entry as z.infer<typeof StageSchema>;
      if (allNames.has(stage.name)) {
        issues.push(`Duplicate stage name '${stage.name}'`);
      }
      allNames.add(stage.name);
    }
  }

  for (const issue of issues) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: issue });
  }
});

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Load and validate a pipeline YAML file.
 * Throws with a clear message if the file is missing or the schema is invalid.
 */
export async function loadPipeline(filePath: string): Promise<Pipeline> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf-8");
  } catch (err) {
    throw new Error(`Cannot read pipeline file: ${filePath}`, { cause: err });
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (err) {
    throw new Error(`Invalid YAML in pipeline file: ${filePath}`, {
      cause: err,
    });
  }

  const result = PipelineSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(
      `Pipeline validation failed for ${filePath}:\n${issues}`,
    );
  }

  return result.data as Pipeline;
}
