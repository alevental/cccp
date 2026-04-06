import type { ProjectConfig } from "./config.js";
import type { GateStrategy } from "./gate/gate-strategy.js";

// ---------------------------------------------------------------------------
// Pipeline YAML structure types
// ---------------------------------------------------------------------------

/** Valid effort levels for agent dispatch. */
export type EffortLevel = "low" | "medium" | "high" | "max";

/** Per-phase model/effort defaults (e.g., all planners use medium effort). */
export interface PhaseModelEffort {
  model?: string;
  effort?: EffortLevel;
}

/** Pipeline-level defaults keyed by PGE/autoresearch phase name. */
export interface PhaseDefaults {
  planner?: PhaseModelEffort;
  generator?: PhaseModelEffort;
  evaluator?: PhaseModelEffort;
  adjuster?: PhaseModelEffort;
  executor?: PhaseModelEffort;
}

/** Top-level pipeline definition loaded from YAML. */
export interface Pipeline {
  name: string;
  description?: string;
  /** Default variables available to all stages. */
  variables?: Record<string, string>;
  /** Pipeline-level default model (inherited by stages unless overridden). */
  model?: string;
  /** Pipeline-level default effort (inherited by stages unless overridden). */
  effort?: EffortLevel;
  /** Per-phase model/effort defaults. Resolution: agent > stage > phase_defaults > pipeline. */
  phase_defaults?: PhaseDefaults;
  stages: StageEntry[];
}

/** A single stage in a pipeline. Discriminated on `type`. */
export type Stage = AgentStage | PgeStage | HumanGateStage | AutoresearchStage | PipelineStage | LoopStage;

/** Base fields shared by every stage type. */
export interface StageBase {
  name: string;
  /** Task instructions passed to the agent as the primary directive. */
  task?: string;
  /** Path to a file whose contents are used as the task body (mutually exclusive with `task`). */
  task_file?: string;
  /** Named MCP profile (resolved from project cccp.yaml). */
  mcp_profile?: string;
  /** Stage-level variable overrides. */
  variables?: Record<string, string>;
  /** Declared structured outputs — keys are variable names, values are descriptions for the agent prompt. */
  outputs?: Record<string, string>;
  /** Condition(s) for running this stage. If not met, stage is skipped. */
  when?: string | string[];
}

/** Simple stage: dispatch one agent, collect output. */
export interface AgentStage extends StageBase {
  type: "agent";
  agent: string;
  operation?: string;
  inputs?: string[];
  output?: string;
  allowed_tools?: string[];
  /** Fire a human review gate after successful completion. */
  human_review?: boolean;
  /** Model override for this agent dispatch. */
  model?: string;
  /** Effort level override for this agent dispatch. */
  effort?: EffortLevel;
}

/** Shared agent config for planner, generator, and evaluator in PGE stages. */
export interface PgeAgentConfig {
  agent: string;
  operation?: string;
  mcp_profile?: string;
  allowed_tools?: string[];
  /** Agent-specific input files (merged with stage-level inputs at dispatch). */
  inputs?: string[];
  /** Model override for this agent dispatch. */
  model?: string;
  /** Effort level override for this agent dispatch. */
  effort?: EffortLevel;
}

/** Plan-Generate-Evaluate stage with retry loop. */
export interface PgeStage extends StageBase {
  type: "pge";
  /** Path to the plan document containing the task reference. */
  plan?: string;
  /** Stage-level inputs shared across all agents (planner, generator, evaluator). */
  inputs?: string[];
  /** Stage-level default model (inherited by sub-agents unless overridden). */
  model?: string;
  /** Stage-level default effort (inherited by sub-agents unless overridden). */
  effort?: EffortLevel;
  /** Planner agent — reads plan + codebase, writes task-plan.md. */
  planner: PgeAgentConfig;
  /** Generator agent — reads contract + task plan, produces deliverable. */
  generator: PgeAgentConfig;
  /** Evaluator agent — writes contract, then evaluates deliverable on each iteration. */
  evaluator: PgeAgentConfig;
  contract: {
    deliverable: string;
    /** Structural template for the contract writer to follow. */
    template?: string;
    /** Free-form guidance for the planner and contract writer. */
    guidance?: string;
    max_iterations: number;
  };
  /** What to do when max iterations reached with FAIL. */
  on_fail?: EscalationStrategy;
  /** Fire a human review gate after successful completion. */
  human_review?: boolean;
}

/** A single success criterion in a PGE contract. @deprecated Used by contract.ts only. */
export interface ContractCriterion {
  name: string;
  description: string;
}

/** Human approval gate — blocks pipeline until approved/rejected. */
export interface HumanGateStage extends StageBase {
  type: "human_gate";
  /** Artifact paths the reviewer should inspect. */
  artifacts?: string[];
  /** What the reviewer is being asked to approve. */
  prompt?: string;
  /** What to do if the gate is rejected. */
  on_reject?: "retry" | "stop";
}

/** Autoresearch stage: iterative artifact optimization against ground truth. */
export interface AutoresearchStage extends StageBase {
  type: "autoresearch";
  /** Path to the artifact being tuned (modified by adjuster on each iteration). */
  artifact: string;
  /** Path to the known correct output (ground truth for comparison). */
  ground_truth: string;
  /** Path where the executor writes its output. */
  output: string;
  /** Stage-level inputs shared across all agents. */
  inputs?: string[];
  /** Stage-level default model (inherited by sub-agents unless overridden). */
  model?: string;
  /** Stage-level default effort (inherited by sub-agents unless overridden). */
  effort?: EffortLevel;
  /** Adjuster agent — reads evaluation feedback, modifies the artifact. */
  adjuster: PgeAgentConfig;
  /** Executor agent — runs the task using the current artifact. */
  executor: PgeAgentConfig;
  /** Evaluator agent — compares executor output against ground truth. */
  evaluator: PgeAgentConfig;
  /** Max iterations (optional — omit for unlimited). */
  max_iterations?: number;
  /** What to do when max iterations reached with FAIL. */
  on_fail?: EscalationStrategy;
}

/** A single body stage inside a loop. */
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

/** Loop stage: run N body stages, evaluate, retry on FAIL. */
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

/** Sub-pipeline stage — invokes another pipeline YAML inline. */
export interface PipelineStage extends StageBase {
  type: "pipeline";
  /** Path to the sub-pipeline YAML file (supports variable interpolation). */
  file: string;
  /** Override artifact directory for the sub-pipeline. */
  artifact_dir?: string;
  /** What to do if the sub-pipeline fails. */
  on_fail?: EscalationStrategy;
}

export type EscalationStrategy = "stop" | "human_gate" | "skip";

// ---------------------------------------------------------------------------
// Parallel execution groups
// ---------------------------------------------------------------------------

/** A group of stages that execute concurrently. */
export interface ParallelGroup {
  parallel: {
    /** Failure handling: fail_fast cancels pending siblings, wait_all lets all finish. Default: fail_fast. */
    on_failure?: "fail_fast" | "wait_all";
    stages: Stage[];
  };
}

/** An entry in the top-level stages array: either a single stage or a parallel group. */
export type StageEntry = Stage | ParallelGroup;

/** Type guard: is this StageEntry a ParallelGroup? */
export function isParallelGroup(entry: StageEntry): entry is ParallelGroup {
  return "parallel" in entry && !("type" in entry);
}

// ---------------------------------------------------------------------------
// State types
// ---------------------------------------------------------------------------

export type StageStatus =
  | "pending"
  | "in_progress"
  | "passed"
  | "failed"
  | "skipped"
  | "error";

export type PgeStep =
  | "planner_dispatched"
  | "contract_dispatched"
  | "generator_dispatched"
  | "evaluator_dispatched"
  | "routed";

export type AutoresearchStep =
  | "adjuster_dispatched"
  | "executor_dispatched"
  | "evaluator_dispatched"
  | "routed";

export type LoopStep =
  | `body_${string}_dispatched`
  | "evaluator_dispatched"
  | "routed";

export interface StageState {
  name: string;
  type: string;
  status: StageStatus;
  /** Current PGE iteration (1-based). Only for type: pge. */
  iteration?: number;
  /** Last completed sub-step within the current iteration (PGE, autoresearch, or loop). */
  pgeStep?: PgeStep | AutoresearchStep | LoopStep;
  /** Paths to artifacts produced by this stage. */
  artifacts?: Record<string, string>;
  /** Duration in ms (set on completion). */
  durationMs?: number;
  /** Error message if status is error/failed. */
  error?: string;
  /** Collected structured output values (key → value) from .outputs.json. */
  outputs?: Record<string, string>;
  /** Nested pipeline state for type: pipeline stages. */
  children?: PipelineState;
  /** Group ID for stages in a parallel group (e.g. "parallel-0"). Informational for TUI display. */
  groupId?: string;
}

export interface GateInfo {
  stageName: string;
  status: "pending" | "approved" | "rejected";
  prompt?: string;
  feedback?: string;
  /** Path to structured feedback markdown artifact. */
  feedbackPath?: string;
  respondedAt?: string;
}

export interface PipelineState {
  /** Unique run ID. */
  runId: string;
  /** Pipeline name. */
  pipeline: string;
  /** Project name. */
  project: string;
  /** Pipeline YAML file path. */
  pipelineFile: string;
  /** ISO timestamp when the run started. */
  startedAt: string;
  /** ISO timestamp when the run completed (set on finish). */
  completedAt?: string;
  /** Overall status. */
  status: "running" | "passed" | "failed" | "error" | "interrupted" | "paused";
  /** Per-stage state, keyed by stage name. */
  stages: Record<string, StageState>;
  /** Stage execution order (preserves YAML order). */
  stageOrder: string[];
  /** Active gate info, if any. */
  gate?: GateInfo;
  /** Artifact output directory for this run. */
  artifactDir: string;
  /** Project root directory. Used to locate the database. */
  projectDir?: string;
  /** MCP session that was active when this run started. Used for gate notification routing. */
  sessionId?: string;
}

export interface ResumePoint {
  /** Index into stageOrder to resume from. */
  stageIndex: number;
  /** Stage name to resume from. */
  stageName: string;
  /** For PGE stages: which iteration to resume at. */
  resumeIteration?: number;
  /** For PGE/autoresearch/loop stages: which sub-step to resume at within the iteration. */
  resumeStep?: PgeStep | AutoresearchStep | LoopStep;
}

/** Event in the state audit log. */
export interface StateEvent {
  id: number;
  runId: string;
  timestamp: string;
  eventType: string;
  stageName?: string;
  data?: unknown;
}

/** A discovered pipeline run (returned by listRuns). */
export interface DiscoveredRun {
  artifactDir: string;
  state: PipelineState;
}

// ---------------------------------------------------------------------------
// Runtime types
// ---------------------------------------------------------------------------

/** Runtime context passed through the runner and into agent dispatch. */
export interface RunContext {
  /** Name of the project (from --project CLI arg). */
  project: string;
  /** Absolute path to the project directory (cwd or --project-dir). */
  projectDir: string;
  /** Resolved artifact output directory. */
  artifactDir: string;
  /** Path to the pipeline YAML file. */
  pipelineFile: string;
  /** The loaded pipeline definition. */
  pipeline: Pipeline;
  /** Whether to show commands without executing them. */
  dryRun: boolean;
  /** Resolved variables (pipeline defaults + CLI overrides). */
  variables: Record<string, string>;
  /** Ordered directories to search for agent definitions. */
  agentSearchPaths: string[];
  /** Project config (from cccp.yaml), if loaded. */
  projectConfig?: ProjectConfig;
  /** Gate strategy for human_gate stages. Created lazily by runner if not provided. */
  gateStrategy?: GateStrategy;
  /** Whether running in headless mode (auto-approve gates). */
  headless?: boolean;
  /** Suppress console output (when TUI dashboard is rendering). */
  quiet?: boolean;
  /** Logger for pipeline output. */
  logger?: import("./logger.js").Logger;
  /** Agent dispatcher (injectable for testing). */
  dispatcher?: import("./dispatcher.js").AgentDispatcher;
  /** Tracks temp files for cleanup. */
  tempTracker?: import("./temp-tracker.js").TempFileTracker;
  /** Pipeline file paths visited in the current execution chain (cycle detection). */
  visitedPipelines?: Set<string>;
  /** MCP session ID for gate notification routing. Passed via --session-id on cccp run. */
  sessionId?: string;
  /** Callback to bubble child stage events to a parent pipeline's event stream. */
  parentOnProgress?: (eventType: string, stageName: string, eventData?: Record<string, unknown>) => Promise<void>;
}

/** Result of dispatching a single agent. */
export interface AgentResult {
  /** Process exit code (0 = success). */
  exitCode: number;
  /** Path to the output file, if the agent was expected to produce one. */
  outputPath?: string;
  /** Whether the output file exists on disk after the agent finished. */
  outputExists: boolean;
  /** Duration in milliseconds. */
  durationMs: number;
  /** Last task_progress description from the agent (narrative step summary). */
  summary?: string;
}

/** Result of a full PGE cycle (may span multiple iterations). */
export interface PgeResult {
  /** Final evaluation outcome. */
  outcome: "pass" | "fail" | "error";
  /** Number of iterations executed. */
  iterations: number;
  /** Max iterations allowed. */
  maxIterations: number;
  /** Path to the final evaluation file. */
  evaluationPath?: string;
  /** Path to the contract file. */
  contractPath?: string;
  /** Path to the task plan file (produced by planner). */
  taskPlanPath?: string;
  /** Duration in milliseconds (total across all iterations). */
  durationMs: number;
}

/** Result of a full autoresearch cycle. */
export interface AutoresearchResult {
  /** Final evaluation outcome. */
  outcome: "pass" | "fail" | "error";
  /** Number of iterations executed. */
  iterations: number;
  /** Max iterations allowed (undefined = unlimited). */
  maxIterations?: number;
  /** Path to the final evaluation file. */
  evaluationPath?: string;
  /** Path to the final tuned artifact. */
  artifactPath?: string;
  /** Path to the executor's final output. */
  outputPath?: string;
  /** Duration in milliseconds (total across all iterations). */
  durationMs: number;
}

/** Result of a full loop cycle. */
export interface LoopResult {
  /** Final evaluation outcome. */
  outcome: "pass" | "fail" | "error";
  /** Number of iterations executed. */
  iterations: number;
  /** Max iterations allowed. */
  maxIterations: number;
  /** Path to the final evaluation file. */
  evaluationPath?: string;
  /** Duration in milliseconds (total across all iterations). */
  durationMs: number;
}

/** Result of a single stage execution. */
export interface StageResult {
  stageName: string;
  status: "passed" | "failed" | "skipped" | "error";
  result?: AgentResult | PgeResult | AutoresearchResult | LoopResult;
  error?: string;
  durationMs: number;
}

/** Overall pipeline run result. */
export interface PipelineResult {
  pipeline: string;
  project: string;
  stages: StageResult[];
  status: "passed" | "failed" | "error";
  durationMs: number;
}
