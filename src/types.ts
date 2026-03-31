import type { ProjectConfig } from "./config.js";
import type { GateStrategy } from "./gate/gate-strategy.js";

// ---------------------------------------------------------------------------
// Pipeline YAML structure types
// ---------------------------------------------------------------------------

/** Top-level pipeline definition loaded from YAML. */
export interface Pipeline {
  name: string;
  description?: string;
  /** Default variables available to all stages. */
  variables?: Record<string, string>;
  stages: Stage[];
}

/** A single stage in a pipeline. Discriminated on `type`. */
export type Stage = AgentStage | PgeStage | HumanGateStage;

/** Base fields shared by every stage type. */
export interface StageBase {
  name: string;
  /** Task instructions passed to the agent as the primary directive. */
  task?: string;
  /** Named MCP profile (resolved from project cccp.yaml). */
  mcp_profile?: string;
  /** Stage-level variable overrides. */
  variables?: Record<string, string>;
}

/** Simple stage: dispatch one agent, collect output. */
export interface AgentStage extends StageBase {
  type: "agent";
  agent: string;
  operation?: string;
  inputs?: string[];
  output?: string;
  allowed_tools?: string[];
}

/** Shared agent config for planner, generator, and evaluator in PGE stages. */
export interface PgeAgentConfig {
  agent: string;
  operation?: string;
  mcp_profile?: string;
  allowed_tools?: string[];
  /** Agent-specific input files (merged with stage-level inputs at dispatch). */
  inputs?: string[];
}

/** Plan-Generate-Evaluate stage with retry loop. */
export interface PgeStage extends StageBase {
  type: "pge";
  /** Path to the plan document containing the task reference. */
  plan?: string;
  /** Stage-level inputs shared across all agents (planner, generator, evaluator). */
  inputs?: string[];
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

export type EscalationStrategy = "stop" | "human_gate" | "skip";

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

export interface StageState {
  name: string;
  type: string;
  status: StageStatus;
  /** Current PGE iteration (1-based). Only for type: pge. */
  iteration?: number;
  /** Last completed PGE sub-step within the current iteration. */
  pgeStep?: PgeStep;
  /** Paths to artifacts produced by this stage. */
  artifacts?: Record<string, string>;
  /** Duration in ms (set on completion). */
  durationMs?: number;
  /** Error message if status is error/failed. */
  error?: string;
}

export interface GateInfo {
  stageName: string;
  status: "pending" | "approved" | "rejected";
  prompt?: string;
  feedback?: string;
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
  status: "running" | "passed" | "failed" | "error" | "interrupted";
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
}

export interface ResumePoint {
  /** Index into stageOrder to resume from. */
  stageIndex: number;
  /** Stage name to resume from. */
  stageName: string;
  /** For PGE stages: which iteration to resume at. */
  resumeIteration?: number;
  /** For PGE stages: which sub-step to resume at within the iteration. */
  resumeStep?: PgeStep;
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

/** Result of a single stage execution. */
export interface StageResult {
  stageName: string;
  status: "passed" | "failed" | "skipped" | "error";
  result?: AgentResult | PgeResult;
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
