import { readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import type { Pipeline, Stage } from "./types.js";
import { isParallelGroup } from "./types.js";

// ---------------------------------------------------------------------------
// Zod schemas — validate raw YAML into typed Pipeline objects
// ---------------------------------------------------------------------------

const ModelSchema = z.string().optional();
const EffortSchema = z.enum(["low", "medium", "high", "xhigh", "max"]).optional();
const WhenSchema = z.union([z.string(), z.array(z.string())]).optional();
const OutputsSchema = z.record(z.string()).optional();

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
  human_review: z.boolean().optional(),
  model: ModelSchema,
  effort: EffortSchema,
  variables: z.record(z.string()).optional(),
  outputs: OutputsSchema,
  when: WhenSchema,
});

const PgeAgentConfigSchema = z.object({
  agent: z.string(),
  operation: z.string().optional(),
  mcp_profile: z.string().optional(),
  allowed_tools: z.array(z.string()).optional(),
  inputs: z.array(z.string()).optional(),
  model: ModelSchema,
  effort: EffortSchema,
});

const PgeStageSchema = z.object({
  name: z.string(),
  task: z.string().optional(),
  task_file: z.string().optional(),
  type: z.literal("pge"),
  mcp_profile: z.string().optional(),
  model: ModelSchema,
  effort: EffortSchema,
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
  human_review: z.boolean().optional(),
  variables: z.record(z.string()).optional(),
  outputs: OutputsSchema,
  when: WhenSchema,
});

const GeStageSchema = z.object({
  name: z.string(),
  task: z.string().optional(),
  task_file: z.string().optional(),
  type: z.literal("ge"),
  mcp_profile: z.string().optional(),
  model: ModelSchema,
  effort: EffortSchema,
  inputs: z.array(z.string()).optional(),
  generator: PgeAgentConfigSchema,
  evaluator: PgeAgentConfigSchema,
  contract: z.object({
    deliverable: z.string(),
    template: z.string().optional(),
    guidance: z.string().optional(),
    max_iterations: z.number().int().min(1).max(10),
  }),
  on_fail: z.enum(["stop", "human_gate", "skip"]).optional(),
  human_review: z.boolean().optional(),
  variables: z.record(z.string()).optional(),
  outputs: OutputsSchema,
  when: WhenSchema,
});

const AutoresearchStageSchema = z.object({
  name: z.string(),
  task: z.string().optional(),
  task_file: z.string().optional(),
  type: z.literal("autoresearch"),
  mcp_profile: z.string().optional(),
  model: ModelSchema,
  effort: EffortSchema,
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
  outputs: OutputsSchema,
  when: WhenSchema,
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
  outputs: OutputsSchema,
  when: WhenSchema,
});

const AgentGateStageSchema = z.object({
  name: z.string(),
  task: z.string().optional(),
  task_file: z.string().optional(),
  type: z.literal("agent_gate"),
  mcp_profile: z.string().optional(),
  artifacts: z.array(z.string()).optional(),
  prompt: z.string().optional(),
  on_reject: z.enum(["retry", "stop"]).optional(),
  variables: z.record(z.string()).optional(),
  outputs: OutputsSchema,
  when: WhenSchema,
});

const HandoffNextSchema = z.object({
  file: z.string(),
  project: z.string().optional(),
  variables: z.record(z.string()).optional(),
  session_id: z.string().optional(),
});

const HandoffCmuxSchema = z.object({
  target: z.string().optional(),
  workspace: z.string().optional(),
  surface: z.string().optional(),
  label: z.string().optional(),
}).optional();

const PipelineHandoffStageSchema = z.object({
  name: z.string(),
  task: z.string().optional(),
  task_file: z.string().optional(),
  type: z.literal("pipeline_handoff"),
  mcp_profile: z.string().optional(),
  prompt: z.string().optional(),
  next: HandoffNextSchema,
  cmux: HandoffCmuxSchema,
  on_timeout: z.enum(["stop", "skip"]).optional(),
  timeout_ms: z.number().int().positive().optional(),
  variables: z.record(z.string()).optional(),
  outputs: OutputsSchema,
  when: WhenSchema,
});

const LoopBodyStageSchema = z.object({
  name: z.string(),
  agent: z.string(),
  operation: z.string().optional(),
  mcp_profile: z.string().optional(),
  allowed_tools: z.array(z.string()).optional(),
  inputs: z.array(z.string()).optional(),
  task: z.string().optional(),
  task_file: z.string().optional(),
  output: z.string().optional(),
  skip_first: z.boolean().optional(),
  model: ModelSchema,
  effort: EffortSchema,
});

const LoopStageSchema = z.object({
  name: z.string(),
  task: z.string().optional(),
  task_file: z.string().optional(),
  type: z.literal("loop"),
  mcp_profile: z.string().optional(),
  model: ModelSchema,
  effort: EffortSchema,
  inputs: z.array(z.string()).optional(),
  stages: z.array(LoopBodyStageSchema).min(1),
  evaluator: PgeAgentConfigSchema,
  max_iterations: z.number().int().min(1).max(20),
  on_fail: z.enum(["stop", "human_gate", "skip"]).optional(),
  human_review: z.boolean().optional(),
  variables: z.record(z.string()).optional(),
  outputs: OutputsSchema,
  when: WhenSchema,
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
  outputs: OutputsSchema,
  when: WhenSchema,
});

const StageSchema = z.discriminatedUnion("type", [
  AgentStageSchema,
  PgeStageSchema,
  GeStageSchema,
  HumanGateStageSchema,
  AgentGateStageSchema,
  PipelineHandoffStageSchema,
  AutoresearchStageSchema,
  PipelineStageSchema,
  LoopStageSchema,
]);

const ParallelGroupSchema = z.object({
  parallel: z.object({
    on_failure: z.enum(["fail_fast", "wait_all"]).optional(),
    stages: z.array(StageSchema).min(2, "Parallel groups must contain at least 2 stages"),
  }),
});

const StageEntrySchema = z.union([StageSchema, ParallelGroupSchema]);

const PhaseModelEffortSchema = z.object({
  model: ModelSchema,
  effort: EffortSchema,
}).optional();

const PhaseDefaultsSchema = z.object({
  planner: PhaseModelEffortSchema,
  generator: PhaseModelEffortSchema,
  evaluator: PhaseModelEffortSchema,
  adjuster: PhaseModelEffortSchema,
  executor: PhaseModelEffortSchema,
}).optional();

const PipelineSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  variables: z.record(z.string()).optional(),
  model: ModelSchema,
  effort: EffortSchema,
  phase_defaults: PhaseDefaultsSchema,
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
        // No agent_gate inside parallel groups (blocks like human_gate)
        if (stage.type === "agent_gate") {
          issues.push(`Stage '${stage.name}' is type agent_gate and cannot be inside a parallel group (gates block execution)`);
        }
        // No pipeline_handoff inside parallel groups (must be last stage)
        if (stage.type === "pipeline_handoff") {
          issues.push(`Stage '${stage.name}' is type pipeline_handoff and cannot be inside a parallel group (must be the final stage)`);
        }
        // No pipeline stages inside parallel groups
        if (stage.type === "pipeline") {
          issues.push(`Stage '${stage.name}' is type pipeline and cannot be inside a parallel group`);
        }
        // No loop stages inside parallel groups
        if (stage.type === "loop") {
          issues.push(`Stage '${stage.name}' is type loop and cannot be inside a parallel group`);
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
          stage.type === "ge" ? stage.contract?.deliverable :
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

  // pipeline_handoff must be the final top-level stage entry — it transfers
  // control to the orchestrator and anything after it would race the child run.
  for (let i = 0; i < pipeline.stages.length; i++) {
    const entry = pipeline.stages[i];
    if ("parallel" in entry && !("type" in entry)) continue;
    const stage = entry as z.infer<typeof StageSchema>;
    if (stage.type === "pipeline_handoff" && i !== pipeline.stages.length - 1) {
      issues.push(`Stage '${stage.name}' is type pipeline_handoff and must be the final stage in the pipeline`);
    }
  }

  // Validate `when:` conditions reference stages that exist and appear earlier.
  // Also validate `outputs:` keys are valid identifiers and not the reserved word "status".
  const orderedNames: string[] = []; // tracks execution order for forward-reference detection
  const parallelGroupMembers = new Map<string, Set<string>>(); // stageName → set of group peers

  // Build ordered names list and parallel group membership.
  for (const entry of pipeline.stages) {
    if ("parallel" in entry && !("type" in entry)) {
      const group = entry as z.infer<typeof ParallelGroupSchema>;
      const groupPeers = new Set(group.parallel.stages.map((s) => s.name));
      for (const stage of group.parallel.stages) {
        parallelGroupMembers.set(stage.name, groupPeers);
        orderedNames.push(stage.name);
      }
    } else {
      const stage = entry as z.infer<typeof StageSchema>;
      orderedNames.push(stage.name);
    }
  }

  // Validate each stage's when and outputs.
  const conditionPattern = /^([\w-]+)\.([\w]+)\s+(==|!=)\s+(.+)$/;

  function validateStage(stage: z.infer<typeof StageSchema>) {
    // Validate outputs keys.
    if (stage.outputs) {
      for (const key of Object.keys(stage.outputs)) {
        if (key === "status") {
          issues.push(`Stage '${stage.name}': outputs key 'status' is reserved`);
        }
        if (!/^[a-z][a-z0-9_]*$/.test(key)) {
          issues.push(`Stage '${stage.name}': outputs key '${key}' must be a lowercase identifier (a-z, 0-9, _)`);
        }
      }
    }

    // Validate when conditions.
    const conditions = stage.when
      ? (Array.isArray(stage.when) ? stage.when : [stage.when])
      : [];
    const stageIdx = orderedNames.indexOf(stage.name);

    for (const cond of conditions) {
      const match = conditionPattern.exec(cond);
      if (!match) {
        issues.push(`Stage '${stage.name}': invalid when condition '${cond}' — expected 'stageName.key == value' or 'stageName.key != value'`);
        continue;
      }
      const refStage = match[1];
      if (!allNames.has(refStage)) {
        issues.push(`Stage '${stage.name}': when references unknown stage '${refStage}'`);
      } else {
        const refIdx = orderedNames.indexOf(refStage);
        if (refIdx >= stageIdx) {
          issues.push(`Stage '${stage.name}': when references stage '${refStage}' which does not appear before it`);
        }
        const peers = parallelGroupMembers.get(stage.name);
        if (peers?.has(refStage)) {
          issues.push(`Stage '${stage.name}': when references stage '${refStage}' in the same parallel group`);
        }
      }
    }

    // Validate loop-specific constraints.
    if (stage.type === "loop") {
      const bodyNames = new Set<string>();
      let allSkipFirst = true;
      for (const bodyStage of stage.stages) {
        if (bodyNames.has(bodyStage.name)) {
          issues.push(`Stage '${stage.name}': duplicate body stage name '${bodyStage.name}'`);
        }
        if (bodyStage.name === stage.name) {
          issues.push(`Stage '${stage.name}': body stage name cannot match the loop stage name`);
        }
        if (bodyStage.task && bodyStage.task_file) {
          issues.push(`Stage '${stage.name}': body stage '${bodyStage.name}' cannot specify both 'task' and 'task_file'`);
        }
        bodyNames.add(bodyStage.name);
        if (!bodyStage.skip_first) allSkipFirst = false;
      }
      if (allSkipFirst) {
        issues.push(`Stage '${stage.name}': at least one body stage must not have skip_first: true`);
      }
    }
  }

  for (const entry of pipeline.stages) {
    if ("parallel" in entry && !("type" in entry)) {
      const group = entry as z.infer<typeof ParallelGroupSchema>;
      for (const stage of group.parallel.stages) validateStage(stage);
    } else {
      validateStage(entry as z.infer<typeof StageSchema>);
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
