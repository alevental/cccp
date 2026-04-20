# Pipeline Schema

This document provides the complete type and schema reference for CCCP pipeline YAML files.

**Source files:**
- [`src/pipeline.ts`](../../src/pipeline.ts) -- Zod validation schemas
- [`src/types.ts`](../../src/types.ts) -- TypeScript type definitions

## Zod Schemas

The pipeline YAML is validated at load time using Zod schemas. Invalid files produce clear error messages listing each validation issue.

### PipelineSchema

```typescript
const ModelSchema = z.string().optional();
const EffortSchema = z.enum(["low", "medium", "high", "xhigh", "max"]).optional();
const WhenSchema = z.union([z.string(), z.array(z.string())]).optional();
const OutputsSchema = z.record(z.string()).optional();

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
});
```

### StageEntrySchema (union)

Each entry in `stages` is either a regular stage or a parallel group:

```typescript
const StageEntrySchema = z.union([StageSchema, ParallelGroupSchema]);
```

### StageSchema (discriminated union)

```typescript
const StageSchema = z.discriminatedUnion("type", [
  AgentStageSchema,
  PgeStageSchema,
  GeStageSchema,
  HumanGateStageSchema,
  AutoresearchStageSchema,
  PipelineStageSchema,
  LoopStageSchema,
]);
```

The `type` field is the discriminator. Valid values: `"agent"`, `"pge"`, `"ge"`, `"human_gate"`, `"autoresearch"`, `"pipeline"`, `"loop"`.

### ParallelGroupSchema

```typescript
const ParallelGroupSchema = z.object({
  parallel: z.object({
    on_failure: z.enum(["fail_fast", "wait_all"]).optional(),
    stages: z.array(StageSchema).min(2),
  }),
});
```

Validation rules (via `superRefine` on `PipelineSchema`):
- No `human_gate` stages inside parallel groups (gates block execution)
- No `pipeline` stages inside parallel groups (complex state interactions)
- Unique stage names across the entire pipeline (including inside groups)
- No conflicting `output` or `contract.deliverable` paths within a group

### AgentStageSchema

```typescript
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
```

### PgeAgentConfigSchema

Shared schema for planner, generator, and evaluator agent configurations:

```typescript
const PgeAgentConfigSchema = z.object({
  agent: z.string(),
  operation: z.string().optional(),
  mcp_profile: z.string().optional(),
  allowed_tools: z.array(z.string()).optional(),
  inputs: z.array(z.string()).optional(),
  model: ModelSchema,
  effort: EffortSchema,
});
```

### PgeStageSchema

```typescript
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
    max_iterations: z.number().int().min(1).max(10),
    template: z.string().optional(),
    guidance: z.string().optional(),
  }),
  on_fail: z.enum(["stop", "human_gate", "skip"]).optional(),
  variables: z.record(z.string()).optional(),
});
```

### GeStageSchema

```typescript
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
```

### HumanGateStageSchema

```typescript
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
```

### AutoresearchStageSchema

_See existing definition in source._

### PipelineStageSchema

```typescript
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
```

### LoopBodyStageSchema

```typescript
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
```

### LoopStageSchema

```typescript
const LoopStageSchema = z.object({
  name: z.string(),
  task: z.string().optional(),
  task_file: z.string().optional(),
  type: z.literal("loop"),
  mcp_profile: z.string().optional(),
  inputs: z.array(z.string()).optional(),
  model: ModelSchema,
  effort: EffortSchema,
  stages: z.array(LoopBodyStageSchema).min(1),
  evaluator: PgeAgentConfigSchema,
  max_iterations: z.number().int().min(1).max(20),
  on_fail: z.enum(["stop", "human_gate", "skip"]).optional(),
  human_review: z.boolean().optional(),
  variables: z.record(z.string()).optional(),
  outputs: OutputsSchema,
  when: WhenSchema,
});
```

## TypeScript Types

### Pipeline

```typescript
export type EffortLevel = "low" | "medium" | "high" | "xhigh" | "max";

export interface PhaseModelEffort {
  model?: string;
  effort?: EffortLevel;
}

export interface PhaseDefaults {
  planner?: PhaseModelEffort;
  generator?: PhaseModelEffort;
  evaluator?: PhaseModelEffort;
  adjuster?: PhaseModelEffort;
  executor?: PhaseModelEffort;
}

export interface Pipeline {
  name: string;
  description?: string;
  variables?: Record<string, string>;
  model?: string;
  effort?: EffortLevel;
  phase_defaults?: PhaseDefaults;
  stages: StageEntry[];
}
```

### StageEntry and ParallelGroup

```typescript
export type StageEntry = Stage | ParallelGroup;

export interface ParallelGroup {
  parallel: {
    on_failure?: "fail_fast" | "wait_all";
    stages: Stage[];
  };
}

export function isParallelGroup(entry: StageEntry): entry is ParallelGroup;
```

### Stage (discriminated union)

```typescript
export type Stage = AgentStage | PgeStage | GeStage | HumanGateStage | AutoresearchStage | PipelineStage | LoopStage;
```

### StageBase (shared fields)

```typescript
export interface StageBase {
  name: string;
  task?: string;
  /** Path to file containing task body (mutually exclusive with task). */
  task_file?: string;
  /** Named MCP profile (resolved from project cccp.yaml). */
  mcp_profile?: string;
  /** Stage-level variable overrides. */
  variables?: Record<string, string>;
  /** Declared structured outputs — keys are variable names, values are descriptions for the agent prompt.
   *  For agent stages, the agent receives outputsPath/outputKeys in its prompt.
   *  For PGE stages, the generator receives the outputs instructions and the evaluator
   *  receives guidance to verify .outputs.json exists with all declared keys. */
  outputs?: Record<string, string>;
  /** Condition(s) for running this stage. If not met, stage is skipped. */
  when?: string | string[];
}
```

### AgentStage

```typescript
export interface AgentStage extends StageBase {
  type: "agent";
  agent: string;
  operation?: string;
  inputs?: string[];
  output?: string;
  allowed_tools?: string[];
  human_review?: boolean;
  model?: string;
  effort?: EffortLevel;
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | `"agent"` | Yes | Stage type discriminator |
| `task_file` | `string` | No | Path to file containing task (mutually exclusive with `task`) |
| `agent` | `string` | Yes | Agent name or path |
| `operation` | `string` | No | Operation for directory-style agents |
| `inputs` | `string[]` | No | Input file paths (support variable interpolation) |
| `output` | `string` | No | Expected output path (verified after execution) |
| `allowed_tools` | `string[]` | No | Tool allowlist for the agent |
| `human_review` | `boolean` | No | Fire a human review gate after completion |
| `model` | `string` | No | Model override (`haiku`, `sonnet`, `opus`, or full model name such as `claude-opus-4-7` / `claude-sonnet-4-6` / `claude-haiku-4-5`) |
| `effort` | `EffortLevel` | No | Effort level override (`low`, `medium`, `high`, `xhigh`, `max`) |

### PgeAgentConfig

Shared type for planner, generator, and evaluator agent configurations:

```typescript
export interface PgeAgentConfig {
  agent: string;
  operation?: string;
  mcp_profile?: string;
  allowed_tools?: string[];
  inputs?: string[];
  model?: string;
  effort?: EffortLevel;
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `agent` | `string` | Yes | Agent name or path |
| `operation` | `string` | No | Operation for directory-style agents |
| `mcp_profile` | `string` | No | MCP profile override (takes precedence over stage-level) |
| `allowed_tools` | `string[]` | No | Tool allowlist |
| `inputs` | `string[]` | No | Agent-specific input files (merged with stage-level `inputs`) |
| `model` | `string` | No | Model override for this agent (highest priority) |
| `effort` | `EffortLevel` | No | Effort override for this agent (highest priority) |

### PgeStage

```typescript
export interface PgeStage extends StageBase {
  type: "pge";
  plan?: string;
  inputs?: string[];
  model?: string;
  effort?: EffortLevel;
  planner: PgeAgentConfig;
  generator: PgeAgentConfig;
  evaluator: PgeAgentConfig;
  contract: {
    deliverable: string;
    max_iterations: number;
    template?: string;
    guidance?: string;
  };
  on_fail?: EscalationStrategy;
  human_review?: boolean;
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | `"pge"` | Yes | Stage type discriminator |
| `plan` | `string` | No | Path to plan document containing the task reference |
| `inputs` | `string[]` | No | Stage-level input files shared across all agents |
| `model` | `string` | No | Stage-level model default (inherited by sub-agents unless overridden) |
| `effort` | `EffortLevel` | No | Stage-level effort default (inherited by sub-agents unless overridden) |
| `planner` | `PgeAgentConfig` | Yes | Planner agent configuration |
| `generator` | `PgeAgentConfig` | Yes | Generator agent configuration |
| `evaluator` | `PgeAgentConfig` | Yes | Evaluator agent configuration |
| `contract` | object | Yes | Contract specification |
| `on_fail` | `EscalationStrategy` | No | What to do when max iterations fail (default: `"stop"`) |
| `human_review` | `boolean` | No | Fire a human review gate after completion |

#### Contract fields

| Field | Type | Required | Constraints | Description |
|-------|------|----------|-------------|-------------|
| `deliverable` | `string` | Yes | -- | Path where generator writes output |
| `max_iterations` | `number` | Yes | 1-10, integer | Maximum retry iterations |
| `template` | `string` | No | -- | Structural guide for the evaluator when writing the contract |
| `guidance` | `string` | No | -- | Free-form guidance for planner and contract writer |

### GeStage

```typescript
export interface GeStage extends StageBase {
  type: "ge";
  inputs?: string[];
  model?: string;
  effort?: EffortLevel;
  generator: PgeAgentConfig;
  evaluator: PgeAgentConfig;
  contract: {
    deliverable: string;
    template?: string;
    guidance?: string;
    max_iterations: number;
  };
  on_fail?: EscalationStrategy;
  human_review?: boolean;
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | `"ge"` | Yes | Stage type discriminator |
| `inputs` | `string[]` | No | Stage-level input files shared across all agents |
| `model` | `string` | No | Stage-level model default (inherited by sub-agents unless overridden) |
| `effort` | `EffortLevel` | No | Stage-level effort default (inherited by sub-agents unless overridden) |
| `generator` | `PgeAgentConfig` | Yes | Generator agent configuration |
| `evaluator` | `PgeAgentConfig` | Yes | Evaluator agent configuration |
| `contract` | object | Yes | Contract specification (same fields as PGE) |
| `on_fail` | `EscalationStrategy` | No | What to do when max iterations fail (default: `"stop"`) |
| `human_review` | `boolean` | No | Fire a human review gate after completion |

#### Contract fields

| Field | Type | Required | Constraints | Description |
|-------|------|----------|-------------|-------------|
| `deliverable` | `string` | Yes | -- | Path where generator writes output |
| `max_iterations` | `number` | Yes | 1-10, integer | Maximum retry iterations |
| `template` | `string` | No | -- | Structural guide for the evaluator when writing the contract |
| `guidance` | `string` | No | -- | Free-form guidance for contract writer |

### HumanGateStage

```typescript
export interface HumanGateStage extends StageBase {
  type: "human_gate";
  artifacts?: string[];
  prompt?: string;
  on_reject?: "retry" | "stop";
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | `"human_gate"` | Yes | Stage type discriminator |
| `artifacts` | `string[]` | No | File paths the reviewer should inspect |
| `prompt` | `string` | No | Instructions for the reviewer |
| `on_reject` | `"retry" \| "stop"` | No | Behavior on rejection (default: `"stop"`) |

### PipelineStage

```typescript
export interface PipelineStage extends StageBase {
  type: "pipeline";
  file: string;
  artifact_dir?: string;
  on_fail?: EscalationStrategy;
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | `"pipeline"` | Yes | Stage type discriminator |
| `file` | `string` | Yes | Path to sub-pipeline YAML |
| `artifact_dir` | `string` | No | Override artifact directory for child |
| `on_fail` | `EscalationStrategy` | No | Behavior on sub-pipeline failure (default: `"stop"`) |

### LoopBodyStage

```typescript
export interface LoopBodyStage {
  name: string;
  agent: string;
  operation?: string;
  mcp_profile?: string;
  allowed_tools?: string[];
  inputs?: string[];
  task?: string;
  task_file?: string;
  output?: string;
  skip_first?: boolean;
  model?: string;
  effort?: EffortLevel;
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | `string` | Yes | Body stage name |
| `agent` | `string` | Yes | Agent name or path |
| `operation` | `string` | No | Operation for directory-style agents |
| `mcp_profile` | `string` | No | MCP profile override |
| `allowed_tools` | `string[]` | No | Tool allowlist for the agent |
| `inputs` | `string[]` | No | Input file paths (support variable interpolation) |
| `task` | `string` | No | Inline task description |
| `task_file` | `string` | No | Path to file containing task (mutually exclusive with `task`) |
| `output` | `string` | No | Expected output path |
| `skip_first` | `boolean` | No | Skip this body stage on the first iteration |
| `model` | `string` | No | Model override |
| `effort` | `EffortLevel` | No | Effort level override |

### LoopStage

```typescript
export interface LoopStage extends StageBase {
  type: "loop";
  inputs?: string[];
  model?: string;
  effort?: EffortLevel;
  stages: LoopBodyStage[];
  evaluator: PgeAgentConfig;
  max_iterations: number;
  on_fail?: EscalationStrategy;
  human_review?: boolean;
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | `"loop"` | Yes | Stage type discriminator |
| `inputs` | `string[]` | No | Stage-level input files shared across body stages and evaluator |
| `model` | `string` | No | Stage-level model default (inherited by body stages/evaluator unless overridden) |
| `effort` | `EffortLevel` | No | Stage-level effort default (inherited by body stages/evaluator unless overridden) |
| `stages` | `LoopBodyStage[]` | Yes | Body stages executed sequentially each iteration |
| `evaluator` | `PgeAgentConfig` | Yes | Evaluator agent configuration (uses same `### Overall: PASS/FAIL` routing as PGE) |
| `max_iterations` | `number` | Yes | Maximum retry iterations (1-20, integer) |
| `on_fail` | `EscalationStrategy` | No | What to do when max iterations fail (default: `"stop"`) |
| `human_review` | `boolean` | No | Fire a human review gate after completion |

### EscalationStrategy

```typescript
export type EscalationStrategy = "stop" | "human_gate" | "skip";
```

## Runtime Types

### RunContext

Passed through the runner and into agent dispatch:

```typescript
export interface RunContext {
  project: string;
  projectDir: string;
  artifactDir: string;
  pipelineFile: string;
  pipeline: Pipeline;
  dryRun: boolean;
  variables: Record<string, string>;
  agentSearchPaths: string[];
  projectConfig?: ProjectConfig;
  gateStrategy?: GateStrategy;
  headless?: boolean;
  quiet?: boolean;
  logger?: Logger;
  dispatcher?: AgentDispatcher;
  tempTracker?: TempFileTracker;
}
```

### AgentResult

Returned by a single agent dispatch:

```typescript
export interface AgentResult {
  exitCode: number;
  outputPath?: string;
  outputExists: boolean;
  durationMs: number;
}
```

### PgeResult

Returned by a full PGE cycle:

```typescript
export interface PgeResult {
  outcome: "pass" | "fail" | "error";
  iterations: number;
  maxIterations: number;
  evaluationPath?: string;
  contractPath?: string;
  taskPlanPath?: string;
  durationMs: number;
}
```

### LoopResult

Returned by a full loop cycle:

```typescript
export interface LoopResult {
  outcome: "pass" | "fail" | "error";
  iterations: number;
  maxIterations: number;
  evaluationPath?: string;
  durationMs: number;
}
```

### GeResult

Returned by a full GE cycle:

```typescript
export interface GeResult {
  outcome: "pass" | "fail" | "error";
  iterations: number;
  maxIterations: number;
  evaluationPath?: string;
  contractPath?: string;
  durationMs: number;
}
```

### StageResult

Returned by a single stage execution:

```typescript
export interface StageResult {
  stageName: string;
  status: "passed" | "failed" | "skipped" | "error";
  result?: AgentResult | PgeResult | GeResult | LoopResult;
  error?: string;
  durationMs: number;
}
```

### PipelineResult

Overall pipeline run result:

```typescript
export interface PipelineResult {
  pipeline: string;
  project: string;
  stages: StageResult[];
  status: "passed" | "failed" | "error";
  durationMs: number;
}
```

## State Types

### PipelineState

Persisted to the SQLite database:

```typescript
export interface PipelineState {
  runId: string;
  pipeline: string;
  project: string;
  pipelineFile: string;
  startedAt: string;
  completedAt?: string;
  status: "running" | "passed" | "failed" | "error" | "interrupted";
  stages: Record<string, StageState>;
  stageOrder: string[];
  gate?: GateInfo;
  artifactDir: string;
  projectDir?: string;
}
```

### StageState

```typescript
export interface StageState {
  name: string;
  type: string;
  status: StageStatus;
  iteration?: number;        // PGE/GE iteration (1-based)
  pgeStep?: PgeStep | GeStep; // Sub-step within PGE/GE iteration
  artifacts?: Record<string, string>;
  outputs?: Record<string, string>;  // Collected structured outputs (key → value)
  children?: PipelineState;
  durationMs?: number;
  error?: string;
  groupId?: string;          // Parallel group ID (e.g. "parallel-0")
}
```

### StageStatus

```typescript
export type StageStatus =
  | "pending"
  | "in_progress"
  | "passed"
  | "failed"
  | "skipped"
  | "error";
```

### PgeStep

```typescript
export type PgeStep =
  | "planner_dispatched"
  | "contract_dispatched"
  | "generator_dispatched"
  | "evaluator_dispatched"
  | "routed";
```

### GeStep

```typescript
export type GeStep =
  | "contract_dispatched"
  | "generator_dispatched"
  | "evaluator_dispatched"
  | "routed";
```

### GateInfo

```typescript
export interface GateInfo {
  stageName: string;
  status: "pending" | "approved" | "rejected";
  prompt?: string;
  feedback?: string;
  respondedAt?: string;
}
```

## Validation Example

```typescript
import { loadPipeline } from "./pipeline.js";

// Throws with detailed errors on invalid YAML:
// Pipeline validation failed for pipelines/bad.yaml:
//   - stages.0.type: Invalid discriminator value
//   - stages.1.contract.max_iterations: Number must be less than or equal to 10
const pipeline = await loadPipeline("pipelines/my-pipeline.yaml");
```

## Model and Effort Resolution

Model and effort can be set at four levels. Resolution order (highest priority first):

1. **Agent config** -- `planner.effort`, `generator.model`, etc.
2. **Stage level** -- `effort` or `model` on the stage itself
3. **Phase defaults** -- `phase_defaults.planner.effort`, etc. at pipeline level
4. **Pipeline level** -- `model` or `effort` at the top of the YAML

At dispatch time, `resolveModelEffort()` in `src/stage-helpers.ts` walks this chain and passes the resolved values as `--model` and `--effort` flags to the `claude` CLI.

```yaml
name: my-pipeline
effort: high                      # 4. pipeline default
phase_defaults:                   # 3. per-phase defaults
  planner:
    effort: medium
  evaluator:
    model: haiku
    effort: low

stages:
  - name: spec
    type: pge
    effort: high                  # 2. stage default (redundant here)
    planner:
      agent: architect
      effort: low                 # 1. agent override (wins)
    generator:
      agent: implementer          # inherits effort: high from stage
    evaluator:
      agent: reviewer             # inherits model: haiku, effort: low from phase_defaults
```

## Related Documentation

- [Pipeline Authoring](../guides/pipeline-authoring.md) -- practical YAML writing guide
- [PGE Cycle](../patterns/pge-cycle.md) -- PGE stage execution details
- [Gate System](gate-system.md) -- `GateInfo` lifecycle
- [Configuration](../api/configuration.md) -- `ProjectConfig` schema
