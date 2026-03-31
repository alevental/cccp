import { resolve } from "node:path";
import { writeFile, mkdir } from "node:fs/promises";
import {
  cccpYaml,
  examplePipeline,
  researcherAgent,
  plannerAgent,
  writerAgent,
  reviewerAgent,
} from "./templates.js";

/**
 * Scaffold a new CCCP project in the given directory.
 *
 * Creates:
 *   cccp.yaml              — project configuration
 *   pipelines/example.yaml — example pipeline
 *   agents/researcher.md   — example research agent
 *   agents/planner.md      — example planner agent
 *   agents/writer.md       — example writer agent
 *   agents/reviewer.md     — example reviewer/evaluator agent
 */
export async function scaffoldProject(dir: string): Promise<void> {
  const pipelinesDir = resolve(dir, "pipelines");
  const agentsDir = resolve(dir, "agents");

  await mkdir(pipelinesDir, { recursive: true });
  await mkdir(agentsDir, { recursive: true });

  await writeFile(resolve(dir, "cccp.yaml"), cccpYaml, "utf-8");
  await writeFile(resolve(pipelinesDir, "example.yaml"), examplePipeline, "utf-8");
  await writeFile(resolve(agentsDir, "researcher.md"), researcherAgent, "utf-8");
  await writeFile(resolve(agentsDir, "planner.md"), plannerAgent, "utf-8");
  await writeFile(resolve(agentsDir, "writer.md"), writerAgent, "utf-8");
  await writeFile(resolve(agentsDir, "reviewer.md"), reviewerAgent, "utf-8");

  console.log(`Scaffolded CCCP project in ${dir}:`);
  console.log(`  cccp.yaml              — project configuration`);
  console.log(`  pipelines/example.yaml — example pipeline`);
  console.log(`  agents/researcher.md   — example research agent`);
  console.log(`  agents/planner.md      — example planner agent`);
  console.log(`  agents/writer.md       — example writer agent`);
  console.log(`  agents/reviewer.md     — example reviewer/evaluator agent`);
  console.log(`\nRun with: cccp run -f pipelines/example.yaml -p my-project --dry-run`);
}
