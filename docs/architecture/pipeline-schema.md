# Pipeline Schema

This document provides the complete type and schema reference for CCCP pipeline YAML files.

**Source files:**
- [`src/pipeline.ts`](../../src/pipeline.ts) -- Zod validation schemas
- [`src/types.ts`](../../src/types.ts) -- TypeScript type definitions

## Zod Schemas

The pipeline YAML is validated at load time using Zod schemas. Invalid files produce clear error messages listing each validation issue.

### PipelineSchema

```typescript
const PipelineSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  variables: z.record(z.string()).optional(),
  stages: z.array(StageSchema).min(1),
});
```

### StageSchema (discriminated union)

```typescript
const StageSchema = z.discriminatedUnion("type", [
  AgentStageSchema,
  PgeStageSchema,
  HumanGateStageSchema,
  AutoresearchStageSchema,
]);
```

The `type` field is the discriminator. Valid values: `"agent"`, `"pge"`, `"human_gate"`, `"autoresearch"`.

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
  variables: z.record(z.string()).optional(),
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
});
```

### PgeStageSchema

```typescript
const PgeStageSchema = z.object({
  name: z.string(),
  task: z.string().optional(),
  task_file: z.string().optional(),
  type: z.literal("pge"),
  plan: z.string().optional(),
  inputs: z.array(z.string()).optional(),
  mcp_profile: z.string().optional(),
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

## TypeScript Types

### Pipeline

```typescript
export interface Pipeline {
  name: string;
  description?: string;
  /** Default variables available to all stages. */
  variables?: Record<string, string>;
  stages: Stage[];
}
```

### Stage (discriminated union)

```typescript
export type Stage = AgentStage | PgeStage | HumanGateStage;
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

### PgeAgentConfig

Shared type for planner, generator, and evaluator agent configurations:

```typescript
export interface PgeAgentConfig {
  agent: string;
  operation?: string;
  mcp_profile?: string;
  allowed_tools?: string[];
  inputs?: string[];
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `agent` | `string` | Yes | Agent name or path |
| `operation` | `string` | No | Operation for directory-style agents |
| `mcp_profile` | `string` | No | MCP profile override (takes precedence over stage-level) |
| `allowed_tools` | `string[]` | No | Tool allowlist |
| `inputs` | `string[]` | No | Agent-specific input files (merged with stage-level `inputs`) |

### PgeStage

```typescript
export interface PgeStage extends StageBase {
  type: "pge";
  plan?: string;
  inputs?: string[];
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
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | `"pge"` | Yes | Stage type discriminator |
| `plan` | `string` | No | Path to plan document containing the task reference |
| `inputs` | `string[]` | No | Stage-level input files shared across all agents |
| `planner` | `PgeAgentConfig` | Yes | Planner agent configuration |
| `generator` | `PgeAgentConfig` | Yes | Generator agent configuration |
| `evaluator` | `PgeAgentConfig` | Yes | Evaluator agent configuration |
| `contract` | object | Yes | Contract specification |
| `on_fail` | `EscalationStrategy` | No | What to do when max iterations fail (default: `"stop"`) |

#### Contract fields

| Field | Type | Required | Constraints | Description |
|-------|------|----------|-------------|-------------|
| `deliverable` | `string` | Yes | -- | Path where generator writes output |
| `max_iterations` | `number` | Yes | 1-10, integer | Maximum retry iterations |
| `template` | `string` | No | -- | Structural guide for the evaluator when writing the contract |
| `guidance` | `string` | No | -- | Free-form guidance for planner and contract writer |

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

### StageResult

Returned by a single stage execution:

```typescript
export interface StageResult {
  stageName: string;
  status: "passed" | "failed" | "skipped" | "error";
  result?: AgentResult | PgeResult;
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
  iteration?: number;        // PGE iteration (1-based)
  pgeStep?: PgeStep;         // Sub-step within PGE iteration
  artifacts?: Record<string, string>;
  durationMs?: number;
  error?: string;
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

## Related Documentation

- [Pipeline Authoring](../guides/pipeline-authoring.md) -- practical YAML writing guide
- [PGE Cycle](../patterns/pge-cycle.md) -- PGE stage execution details
- [Gate System](gate-system.md) -- `GateInfo` lifecycle
- [Configuration](../api/configuration.md) -- `ProjectConfig` schema
