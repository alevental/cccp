import { describe, it, expect, afterAll } from "vitest";
import { writeFile, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { loadPipeline } from "../src/pipeline.js";
import { runPipeline } from "../src/runner.js";
import { SilentLogger } from "../src/logger.js";
import { TempFileTracker } from "../src/temp-tracker.js";
import type { AgentDispatcher, DispatchOptions } from "../src/dispatcher.js";
import type { AgentResult, RunContext, Pipeline } from "../src/types.js";
import { tmpProjectDir, cleanupAll } from "./helpers.js";

afterAll(async () => {
  await cleanupAll();
});

// ---------------------------------------------------------------------------
// ScriptedDispatcher
// ---------------------------------------------------------------------------

class ScriptedDispatcher implements AgentDispatcher {
  private handlers: Array<(opts: DispatchOptions) => Promise<AgentResult>>;
  private callIndex = 0;
  calls: DispatchOptions[] = [];

  constructor(handlers: Array<(opts: DispatchOptions) => Promise<AgentResult>>) {
    this.handlers = handlers;
  }

  async dispatch(opts: DispatchOptions): Promise<AgentResult> {
    this.calls.push(opts);
    const handler = this.handlers[this.callIndex++];
    if (!handler) throw new Error(`Unexpected dispatch call #${this.callIndex}`);
    return handler(opts);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function writeAgent(dir: string, name: string): Promise<string> {
  const agentsDir = join(dir, "agents");
  await mkdir(agentsDir, { recursive: true });
  await writeFile(join(agentsDir, name), `# ${name}\nYou are a test agent.`, "utf-8");
  return `agents/${name}`;
}

async function writePipeline(dir: string, yaml: string): Promise<Pipeline> {
  const pipelineFile = join(dir, "pipeline.yaml");
  await writeFile(pipelineFile, yaml, "utf-8");
  return loadPipeline(pipelineFile);
}

function buildTestContext(opts: {
  projectDir: string;
  pipeline: Pipeline;
  dispatcher: AgentDispatcher;
}): RunContext {
  const artifactDir = join(opts.projectDir, "artifacts");
  return {
    project: "test-project",
    projectDir: opts.projectDir,
    artifactDir,
    pipelineFile: join(opts.projectDir, "pipeline.yaml"),
    pipeline: opts.pipeline,
    dryRun: false,
    variables: {
      project: "test-project",
      project_dir: opts.projectDir,
      artifact_dir: artifactDir,
      pipeline_name: opts.pipeline.name,
    },
    agentSearchPaths: [join(opts.projectDir, "agents")],
    quiet: true,
    logger: new SilentLogger(),
    dispatcher: opts.dispatcher,
    tempTracker: new TempFileTracker(),
  };
}

// ---------------------------------------------------------------------------
// Pipeline schema validation for when/outputs
// ---------------------------------------------------------------------------

describe("Pipeline schema: when and outputs validation", () => {
  it("accepts valid when conditions", async () => {
    const dir = tmpProjectDir();
    await writeAgent(dir, "agent.md");

    const pipeline = await writePipeline(dir, `
name: valid-when
stages:
  - name: first
    type: agent
    agent: agents/agent.md
    outputs:
      decision: "proceed or abandon"
  - name: second
    type: agent
    agent: agents/agent.md
    when: "first.decision == proceed"
`);

    expect(pipeline.stages).toHaveLength(2);
  });

  it("accepts when as a list (AND semantics)", async () => {
    const dir = tmpProjectDir();
    await writeAgent(dir, "agent.md");

    const pipeline = await writePipeline(dir, `
name: when-list
stages:
  - name: first
    type: agent
    agent: agents/agent.md
    outputs:
      decision: "proceed or abandon"
      risk: "low or high"
  - name: second
    type: agent
    agent: agents/agent.md
    when:
      - "first.decision == proceed"
      - "first.risk != high"
`);

    expect(pipeline.stages).toHaveLength(2);
  });

  it("rejects when referencing non-existent stage", async () => {
    const dir = tmpProjectDir();
    await writeAgent(dir, "agent.md");

    await expect(writePipeline(dir, `
name: bad-when
stages:
  - name: first
    type: agent
    agent: agents/agent.md
  - name: second
    type: agent
    agent: agents/agent.md
    when: "nonexistent.status == passed"
`)).rejects.toThrow("unknown stage");
  });

  it("rejects when referencing a later stage (forward reference)", async () => {
    const dir = tmpProjectDir();
    await writeAgent(dir, "agent.md");

    await expect(writePipeline(dir, `
name: forward-ref
stages:
  - name: first
    type: agent
    agent: agents/agent.md
    when: "second.status == passed"
  - name: second
    type: agent
    agent: agents/agent.md
`)).rejects.toThrow("does not appear before");
  });

  it("rejects outputs key named 'status' (reserved)", async () => {
    const dir = tmpProjectDir();
    await writeAgent(dir, "agent.md");

    await expect(writePipeline(dir, `
name: bad-outputs
stages:
  - name: first
    type: agent
    agent: agents/agent.md
    outputs:
      status: "some value"
`)).rejects.toThrow("reserved");
  });

  it("rejects invalid when condition syntax", async () => {
    const dir = tmpProjectDir();
    await writeAgent(dir, "agent.md");

    await expect(writePipeline(dir, `
name: bad-syntax
stages:
  - name: first
    type: agent
    agent: agents/agent.md
  - name: second
    type: agent
    agent: agents/agent.md
    when: "just some text"
`)).rejects.toThrow("invalid when condition");
  });
});

// ---------------------------------------------------------------------------
// Condition evaluation and output collection integration
// ---------------------------------------------------------------------------

describe("Integration: conditional execution", () => {
  it("skips stage when condition is not met", async () => {
    const dir = tmpProjectDir();
    await writeAgent(dir, "agent.md");

    const pipeline = await writePipeline(dir, `
name: skip-test
stages:
  - name: research
    type: agent
    agent: agents/agent.md
    outputs:
      decision: "proceed or abandon"
  - name: design
    type: agent
    agent: agents/agent.md
    when: "research.decision == proceed"
`);

    const dispatcher = new ScriptedDispatcher([
      // research: writes outputs with decision=abandon
      async (opts) => {
        const stageDir = join(dir, "artifacts", "research");
        await mkdir(stageDir, { recursive: true });
        await writeFile(
          join(stageDir, ".outputs.json"),
          JSON.stringify({ decision: "abandon" }),
          "utf-8",
        );
        return { exitCode: 0, outputExists: false, durationMs: 10 };
      },
      // design: should NOT be called since condition fails
    ]);

    const ctx = buildTestContext({ projectDir: dir, pipeline, dispatcher });
    const result = await runPipeline(ctx);

    expect(result.status).toBe("passed");
    expect(result.stages).toHaveLength(2);
    expect(result.stages[0].status).toBe("passed");
    expect(result.stages[1].status).toBe("skipped");
    // Only one dispatch call (research), design was skipped
    expect(dispatcher.calls).toHaveLength(1);
  });

  it("runs stage when condition is met", async () => {
    const dir = tmpProjectDir();
    await writeAgent(dir, "agent.md");

    const pipeline = await writePipeline(dir, `
name: run-test
stages:
  - name: research
    type: agent
    agent: agents/agent.md
    outputs:
      decision: "proceed or abandon"
  - name: design
    type: agent
    agent: agents/agent.md
    when: "research.decision == proceed"
`);

    const dispatcher = new ScriptedDispatcher([
      // research: outputs decision=proceed
      async () => {
        const stageDir = join(dir, "artifacts", "research");
        await mkdir(stageDir, { recursive: true });
        await writeFile(
          join(stageDir, ".outputs.json"),
          JSON.stringify({ decision: "proceed" }),
          "utf-8",
        );
        return { exitCode: 0, outputExists: false, durationMs: 10 };
      },
      // design: runs because condition is met
      async () => {
        return { exitCode: 0, outputExists: false, durationMs: 10 };
      },
    ]);

    const ctx = buildTestContext({ projectDir: dir, pipeline, dispatcher });
    const result = await runPipeline(ctx);

    expect(result.status).toBe("passed");
    expect(result.stages[0].status).toBe("passed");
    expect(result.stages[1].status).toBe("passed");
    expect(dispatcher.calls).toHaveLength(2);
  });

  it("supports != condition", async () => {
    const dir = tmpProjectDir();
    await writeAgent(dir, "agent.md");

    const pipeline = await writePipeline(dir, `
name: not-equal-test
stages:
  - name: check
    type: agent
    agent: agents/agent.md
    outputs:
      risk: "the risk level"
  - name: proceed
    type: agent
    agent: agents/agent.md
    when: "check.risk != high"
`);

    const dispatcher = new ScriptedDispatcher([
      // check: risk=medium
      async () => {
        const stageDir = join(dir, "artifacts", "check");
        await mkdir(stageDir, { recursive: true });
        await writeFile(
          join(stageDir, ".outputs.json"),
          JSON.stringify({ risk: "medium" }),
          "utf-8",
        );
        return { exitCode: 0, outputExists: false, durationMs: 10 };
      },
      // proceed: runs because risk != high
      async () => {
        return { exitCode: 0, outputExists: false, durationMs: 10 };
      },
    ]);

    const ctx = buildTestContext({ projectDir: dir, pipeline, dispatcher });
    const result = await runPipeline(ctx);

    expect(result.status).toBe("passed");
    expect(result.stages[1].status).toBe("passed");
    expect(dispatcher.calls).toHaveLength(2);
  });

  it("supports status-based conditions", async () => {
    const dir = tmpProjectDir();
    await writeAgent(dir, "agent.md");

    const pipeline = await writePipeline(dir, `
name: status-check
stages:
  - name: first
    type: agent
    agent: agents/agent.md
  - name: second
    type: agent
    agent: agents/agent.md
    when: "first.status == passed"
`);

    const dispatcher = new ScriptedDispatcher([
      async () => ({ exitCode: 0, outputExists: false, durationMs: 10 }),
      async () => ({ exitCode: 0, outputExists: false, durationMs: 10 }),
    ]);

    const ctx = buildTestContext({ projectDir: dir, pipeline, dispatcher });
    const result = await runPipeline(ctx);

    expect(result.status).toBe("passed");
    expect(result.stages[1].status).toBe("passed");
    expect(dispatcher.calls).toHaveLength(2);
  });

  it("AND conditions: all must be true", async () => {
    const dir = tmpProjectDir();
    await writeAgent(dir, "agent.md");

    const pipeline = await writePipeline(dir, `
name: and-conditions
stages:
  - name: check
    type: agent
    agent: agents/agent.md
    outputs:
      decision: "value"
      risk: "value"
  - name: proceed
    type: agent
    agent: agents/agent.md
    when:
      - "check.decision == go"
      - "check.risk == low"
`);

    // Both conditions met
    const dispatcher = new ScriptedDispatcher([
      async () => {
        const stageDir = join(dir, "artifacts", "check");
        await mkdir(stageDir, { recursive: true });
        await writeFile(
          join(stageDir, ".outputs.json"),
          JSON.stringify({ decision: "go", risk: "low" }),
          "utf-8",
        );
        return { exitCode: 0, outputExists: false, durationMs: 10 };
      },
      async () => ({ exitCode: 0, outputExists: false, durationMs: 10 }),
    ]);

    const ctx = buildTestContext({ projectDir: dir, pipeline, dispatcher });
    const result = await runPipeline(ctx);
    expect(result.stages[1].status).toBe("passed");
  });

  it("AND conditions: skips if any condition fails", async () => {
    const dir = tmpProjectDir();
    await writeAgent(dir, "agent.md");

    const pipeline = await writePipeline(dir, `
name: and-fail
stages:
  - name: check
    type: agent
    agent: agents/agent.md
    outputs:
      decision: "value"
      risk: "value"
  - name: proceed
    type: agent
    agent: agents/agent.md
    when:
      - "check.decision == go"
      - "check.risk == low"
`);

    const dispatcher = new ScriptedDispatcher([
      async () => {
        const stageDir = join(dir, "artifacts", "check");
        await mkdir(stageDir, { recursive: true });
        await writeFile(
          join(stageDir, ".outputs.json"),
          JSON.stringify({ decision: "go", risk: "high" }), // risk != low → fail
          "utf-8",
        );
        return { exitCode: 0, outputExists: false, durationMs: 10 };
      },
    ]);

    const ctx = buildTestContext({ projectDir: dir, pipeline, dispatcher });
    const result = await runPipeline(ctx);
    expect(result.stages[1].status).toBe("skipped");
    expect(dispatcher.calls).toHaveLength(1);
  });

  it("cascade skip: downstream condition fails when upstream was skipped", async () => {
    const dir = tmpProjectDir();
    await writeAgent(dir, "agent.md");

    const pipeline = await writePipeline(dir, `
name: cascade
stages:
  - name: gate
    type: agent
    agent: agents/agent.md
    outputs:
      go: "yes or no"
  - name: middle
    type: agent
    agent: agents/agent.md
    when: "gate.go == yes"
    outputs:
      result: "some result"
  - name: final
    type: agent
    agent: agents/agent.md
    when: "middle.result == done"
`);

    const dispatcher = new ScriptedDispatcher([
      // gate: go=no
      async () => {
        const stageDir = join(dir, "artifacts", "gate");
        await mkdir(stageDir, { recursive: true });
        await writeFile(
          join(stageDir, ".outputs.json"),
          JSON.stringify({ go: "no" }),
          "utf-8",
        );
        return { exitCode: 0, outputExists: false, durationMs: 10 };
      },
    ]);

    const ctx = buildTestContext({ projectDir: dir, pipeline, dispatcher });
    const result = await runPipeline(ctx);

    expect(result.status).toBe("passed");
    expect(result.stages[0].status).toBe("passed");
    expect(result.stages[1].status).toBe("skipped"); // gate.go != yes
    expect(result.stages[2].status).toBe("skipped"); // middle.result undefined
    expect(dispatcher.calls).toHaveLength(1);
  });

  it("errors when outputs declared but .outputs.json is missing", async () => {
    const dir = tmpProjectDir();
    await writeAgent(dir, "agent.md");

    const pipeline = await writePipeline(dir, `
name: missing-outputs
stages:
  - name: research
    type: agent
    agent: agents/agent.md
    outputs:
      decision: "value"
`);

    const dispatcher = new ScriptedDispatcher([
      // Agent succeeds but does NOT write .outputs.json
      async () => ({ exitCode: 0, outputExists: false, durationMs: 10 }),
    ]);

    const ctx = buildTestContext({ projectDir: dir, pipeline, dispatcher });
    const result = await runPipeline(ctx);

    // Stage should error because outputs weren't produced
    expect(result.stages[0].status).toBe("error");
    expect(result.status).toBe("error");
  });

  it("errors when .outputs.json is missing a declared key", async () => {
    const dir = tmpProjectDir();
    await writeAgent(dir, "agent.md");

    const pipeline = await writePipeline(dir, `
name: missing-key
stages:
  - name: research
    type: agent
    agent: agents/agent.md
    outputs:
      decision: "value"
      risk: "level"
`);

    const dispatcher = new ScriptedDispatcher([
      async () => {
        const stageDir = join(dir, "artifacts", "research");
        await mkdir(stageDir, { recursive: true });
        await writeFile(
          join(stageDir, ".outputs.json"),
          JSON.stringify({ decision: "proceed" }), // missing "risk"
          "utf-8",
        );
        return { exitCode: 0, outputExists: false, durationMs: 10 };
      },
    ]);

    const ctx = buildTestContext({ projectDir: dir, pipeline, dispatcher });
    const result = await runPipeline(ctx);

    expect(result.stages[0].status).toBe("error");
  });

  it("output values are available as variables in downstream prompts", async () => {
    const dir = tmpProjectDir();
    await writeAgent(dir, "agent.md");

    const pipeline = await writePipeline(dir, `
name: output-vars
stages:
  - name: research
    type: agent
    agent: agents/agent.md
    outputs:
      summary: "a summary"
  - name: design
    type: agent
    agent: agents/agent.md
    task: "Context: {research.summary}"
`);

    const dispatcher = new ScriptedDispatcher([
      async () => {
        const stageDir = join(dir, "artifacts", "research");
        await mkdir(stageDir, { recursive: true });
        await writeFile(
          join(stageDir, ".outputs.json"),
          JSON.stringify({ summary: "Feature is feasible" }),
          "utf-8",
        );
        return { exitCode: 0, outputExists: false, durationMs: 10 };
      },
      async () => ({ exitCode: 0, outputExists: false, durationMs: 10 }),
    ]);

    const ctx = buildTestContext({ projectDir: dir, pipeline, dispatcher });
    await runPipeline(ctx);

    // The second dispatch should have the interpolated summary in its prompt.
    expect(dispatcher.calls[1].userPrompt).toContain("Feature is feasible");
  });

  it("outputs prompt injection tells agent about .outputs.json", async () => {
    const dir = tmpProjectDir();
    await writeAgent(dir, "agent.md");

    const pipeline = await writePipeline(dir, `
name: prompt-test
stages:
  - name: analyze
    type: agent
    agent: agents/agent.md
    outputs:
      decision: "proceed or abort"
`);

    const dispatcher = new ScriptedDispatcher([
      async () => {
        // Write outputs to satisfy collection
        const stageDir = join(dir, "artifacts", "analyze");
        await mkdir(stageDir, { recursive: true });
        await writeFile(
          join(stageDir, ".outputs.json"),
          JSON.stringify({ decision: "proceed" }),
          "utf-8",
        );
        return { exitCode: 0, outputExists: false, durationMs: 10 };
      },
    ]);

    const ctx = buildTestContext({ projectDir: dir, pipeline, dispatcher });
    await runPipeline(ctx);

    // The dispatch prompt should contain structured outputs instructions.
    expect(dispatcher.calls[0].userPrompt).toContain("Structured Outputs");
    expect(dispatcher.calls[0].userPrompt).toContain(".outputs.json");
    expect(dispatcher.calls[0].userPrompt).toContain("decision");
  });
});

// ---------------------------------------------------------------------------
// Interpolation with dot-notation
// ---------------------------------------------------------------------------

describe("interpolate with dot-notation", () => {
  it("resolves {stage.key} variables", async () => {
    const { interpolate } = await import("../src/prompt.js");
    const result = interpolate("Value is {research.decision}", { "research.decision": "proceed" });
    expect(result).toBe("Value is proceed");
  });

  it("leaves unresolved dot variables as-is", async () => {
    const { interpolate } = await import("../src/prompt.js");
    const result = interpolate("Value is {unknown.key}", {});
    expect(result).toBe("Value is {unknown.key}");
  });

  it("still resolves simple variables", async () => {
    const { interpolate } = await import("../src/prompt.js");
    const result = interpolate("Project: {project}", { project: "my-proj" });
    expect(result).toBe("Project: my-proj");
  });
});
