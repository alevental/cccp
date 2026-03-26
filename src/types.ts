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
  description?: string;
  /** Named MCP profile (resolved from project cccpr.yaml). */
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

/** Plan-Generate-Evaluate stage with retry loop. */
export interface PgeStage extends StageBase {
  type: "pge";
  generator: {
    agent: string;
    operation?: string;
    mcp_profile?: string;
    allowed_tools?: string[];
  };
  evaluator: {
    agent: string;
    operation?: string;
    mcp_profile?: string;
    allowed_tools?: string[];
  };
  contract: {
    deliverable: string;
    criteria: ContractCriterion[];
    max_iterations: number;
    template?: string;
  };
  /** What to do when max iterations reached with FAIL. */
  on_fail?: EscalationStrategy;
}

/** A single success criterion in a PGE contract. */
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
  /** Project config (from cccpr.yaml), if loaded. */
  projectConfig?: import("./config.js").ProjectConfig;
  /** Gate strategy for human_gate stages. */
  gateStrategy?: import("./gate/gate-strategy.js").GateStrategy;
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
