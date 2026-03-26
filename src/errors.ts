/** Agent process crashed (non-zero exit code, distinct from evaluation FAIL). */
export class AgentCrashError extends Error {
  constructor(
    public readonly agent: string,
    public readonly exitCode: number,
  ) {
    super(`Agent "${agent}" crashed with exit code ${exitCode}`);
    this.name = "AgentCrashError";
  }
}

/** Agent was expected to produce an output file but didn't. */
export class MissingOutputError extends Error {
  constructor(
    public readonly agent: string,
    public readonly expectedPath: string,
  ) {
    super(
      `Agent "${agent}" did not produce expected output: ${expectedPath}`,
    );
    this.name = "MissingOutputError";
  }
}

/** Pipeline YAML or config validation error. */
export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}
