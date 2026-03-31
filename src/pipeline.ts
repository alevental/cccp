import { readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import type { Pipeline } from "./types.js";

// ---------------------------------------------------------------------------
// Zod schemas — validate raw YAML into typed Pipeline objects
// ---------------------------------------------------------------------------

const AgentStageSchema = z.object({
  name: z.string(),
  task: z.string().optional(),
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

const HumanGateStageSchema = z.object({
  name: z.string(),
  task: z.string().optional(),
  type: z.literal("human_gate"),
  mcp_profile: z.string().optional(),
  artifacts: z.array(z.string()).optional(),
  prompt: z.string().optional(),
  on_reject: z.enum(["retry", "stop"]).optional(),
  variables: z.record(z.string()).optional(),
});

const StageSchema = z.discriminatedUnion("type", [
  AgentStageSchema,
  PgeStageSchema,
  HumanGateStageSchema,
]);

const PipelineSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  variables: z.record(z.string()).optional(),
  stages: z.array(StageSchema).min(1),
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
