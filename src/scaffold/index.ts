import { resolve, dirname } from "node:path";
import { writeFile, mkdir, readdir, readFile, access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  cccpYaml,
  // Agents used by scaffoldExamples
  researcherAgent,
  writerAgent,
  reviewerAgent,
  architectBase,
  // Remaining flat agents
  implementerAgent,
  codeReviewerAgent,
  analystAgent,
  copywriterAgent,
  growthStrategistAgent,
  execReviewerAgent,
  devopsAgent,
  opsManagerAgent,
  // Directory agent: architect (operations)
  architectDesign,
  architectPlanAuthoring,
  architectTaskPlanning,
  architectHealthAssessment,
  architectSprintBrief,
  architectSprintReview,
  // Directory agent: qa-engineer
  qaEngineerBase,
  qaEngineerTestPlanning,
  qaEngineerTestAuthoring,
  // Directory agent: product-manager
  productManagerBase,
  productManagerSpecWriting,
  productManagerPrioritization,
  productManagerUserResearch,
  // Directory agent: marketer
  marketerBase,
  marketerPositioning,
  marketerLaunchPlan,
  marketerContent,
  // Directory agent: strategist
  strategistBase,
  strategistCompetitiveAnalysis,
  strategistBusinessCase,
  strategistQuarterlyPlanning,
  // Directory agent: designer
  designerBase,
  designerUxResearch,
  designerDesignSpec,
  designerDesignReview,
  // Directory agent: customer-success
  customerSuccessBase,
  customerSuccessSupportContent,
  customerSuccessOnboarding,
  customerSuccessFeedbackSynthesis,
} from "./templates.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** Write a file only if it doesn't already exist. Returns true if written. */
async function writeIfMissing(path: string, content: string): Promise<boolean> {
  if (await fileExists(path)) return false;
  await writeFile(path, content, "utf-8");
  return true;
}

/** Resolve the package root from the compiled module location. */
function packageRoot(): string {
  const thisFile = fileURLToPath(import.meta.url);
  // thisFile = <pkg>/dist/scaffold/index.js → <pkg>/
  return resolve(dirname(thisFile), "..", "..");
}

/** Resolve the package's `examples/` directory. */
function packageExamplesDir(): string {
  return resolve(packageRoot(), "examples");
}

/** Resolve the package's `.claude/skills/` directory. */
function packageSkillsDir(): string {
  return resolve(packageRoot(), ".claude", "skills");
}

/**
 * Copy skill directories from the package into the target project.
 * Each skill is a directory with a SKILL.md file.
 * Skills are always overwritten — they are package-owned, not user-customized.
 * Returns the number of skills written or updated.
 */
export async function scaffoldSkills(targetDir: string): Promise<number> {
  const srcSkillsDir = packageSkillsDir();
  const destSkillsDir = resolve(targetDir, ".claude", "skills");
  let count = 0;

  try {
    const skillDirs = await readdir(srcSkillsDir);
    for (const skillName of skillDirs) {
      if (skillName.startsWith(".")) continue;
      const srcSkillDir = resolve(srcSkillsDir, skillName);
      const srcSkillFile = resolve(srcSkillDir, "SKILL.md");
      if (!(await fileExists(srcSkillFile))) continue;

      const destSkillDir = resolve(destSkillsDir, skillName);
      await mkdir(destSkillDir, { recursive: true });
      const content = await readFile(srcSkillFile, "utf-8");
      const destPath = resolve(destSkillDir, "SKILL.md");
      // Always overwrite skills — they ship with the package and should stay current.
      await writeFile(destPath, content, "utf-8");
      count++;
    }
  } catch {
    // .claude/skills/ may not exist in all installations
  }

  return count;
}

// ---------------------------------------------------------------------------
// MCP server registration
// ---------------------------------------------------------------------------

/**
 * Ensure the cccp MCP server is registered in `.mcp.json`.
 * Creates the file if it doesn't exist. Adds the entry if missing.
 * Returns true if the file was created or modified.
 */
async function ensureMcpServer(dir: string): Promise<boolean> {
  const mcpPath = resolve(dir, ".mcp.json");
  const entry = { command: "npx", args: ["@alevental/cccp", "mcp-server"] };

  let config: Record<string, unknown>;
  try {
    const raw = await readFile(mcpPath, "utf-8");
    config = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    config = {};
  }

  if (!config.mcpServers || typeof config.mcpServers !== "object") {
    config.mcpServers = {};
  }

  const servers = config.mcpServers as Record<string, unknown>;
  if (servers.cccp) return false; // already registered

  servers.cccp = entry;
  await writeFile(mcpPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
  return true;
}

// ---------------------------------------------------------------------------
// cccp init — minimal scaffold
// ---------------------------------------------------------------------------

/**
 * Scaffold a CCCP project: cccp.yaml, skills, and MCP server registration.
 * Agents and pipelines are scaffolded separately via `cccp examples`.
 */
export async function scaffoldProject(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });

  // Config (write only if missing — user may have customized it)
  await writeIfMissing(resolve(dir, "cccp.yaml"), cccpYaml);

  // Skills
  const skillCount = await scaffoldSkills(dir);

  // MCP server registration
  const mcpUpdated = await ensureMcpServer(dir);

  console.log(`Scaffolded CCCP project in ${dir}:\n`);
  console.log(`  cccp.yaml                               — project configuration`);
  if (skillCount > 0) {
    console.log(`  .claude/skills/cccp-run/SKILL.md         — /cccp-run skill`);
    console.log(`  .claude/skills/cccp-pipeline/SKILL.md    — /cccp-pipeline skill`);
  }
  if (mcpUpdated) {
    console.log(`  .mcp.json                                — MCP server (cccp) registered`);
  }
  console.log(`\nFor agents and example pipelines: npx @alevental/cccp examples`);
}

// ---------------------------------------------------------------------------
// cccp examples — full agent + pipeline scaffold
// ---------------------------------------------------------------------------

export interface ExamplesOptions {
  agentsOnly?: boolean;
  pipelinesOnly?: boolean;
}

/**
 * Scaffold the full set of template agents and example pipelines.
 * Skips files that already exist.
 */
export async function scaffoldExamples(
  dir: string,
  opts: ExamplesOptions = {},
): Promise<void> {
  const agentsDir = resolve(dir, ".claude", "agents");
  const pipelinesDir = resolve(dir, "pipelines");

  let agentCount = 0;
  let pipelineCount = 0;

  // --- Agents ---
  if (!opts.pipelinesOnly) {
    // Directory agent directories
    const architectDir = resolve(agentsDir, "architect");
    const qaEngineerDir = resolve(agentsDir, "qa-engineer");
    const productManagerDir = resolve(agentsDir, "product-manager");
    const marketerDir = resolve(agentsDir, "marketer");
    const strategistDir = resolve(agentsDir, "strategist");
    const designerDir = resolve(agentsDir, "designer");
    const customerSuccessDir = resolve(agentsDir, "customer-success");

    await mkdir(architectDir, { recursive: true });
    await mkdir(qaEngineerDir, { recursive: true });
    await mkdir(productManagerDir, { recursive: true });
    await mkdir(marketerDir, { recursive: true });
    await mkdir(strategistDir, { recursive: true });
    await mkdir(designerDir, { recursive: true });
    await mkdir(customerSuccessDir, { recursive: true });

    // Flat agents
    const flatAgents: [string, string][] = [
      ["researcher.md", researcherAgent],
      ["implementer.md", implementerAgent],
      ["code-reviewer.md", codeReviewerAgent],
      ["writer.md", writerAgent],
      ["reviewer.md", reviewerAgent],
      ["analyst.md", analystAgent],
      ["copywriter.md", copywriterAgent],
      ["growth-strategist.md", growthStrategistAgent],
      ["exec-reviewer.md", execReviewerAgent],
      ["devops.md", devopsAgent],
      ["ops-manager.md", opsManagerAgent],
    ];

    for (const [name, content] of flatAgents) {
      if (await writeIfMissing(resolve(agentsDir, name), content)) agentCount++;
    }

    // Directory agents
    const dirAgents: [string, string, string][] = [
      // architect
      ["architect", "agent.md", architectBase],
      ["architect", "design.md", architectDesign],
      ["architect", "plan-authoring.md", architectPlanAuthoring],
      ["architect", "task-planning.md", architectTaskPlanning],
      ["architect", "health-assessment.md", architectHealthAssessment],
      ["architect", "sprint-brief.md", architectSprintBrief],
      ["architect", "sprint-review.md", architectSprintReview],
      // qa-engineer
      ["qa-engineer", "agent.md", qaEngineerBase],
      ["qa-engineer", "test-planning.md", qaEngineerTestPlanning],
      ["qa-engineer", "test-authoring.md", qaEngineerTestAuthoring],
      // product-manager
      ["product-manager", "agent.md", productManagerBase],
      ["product-manager", "spec-writing.md", productManagerSpecWriting],
      ["product-manager", "prioritization.md", productManagerPrioritization],
      ["product-manager", "user-research.md", productManagerUserResearch],
      // marketer
      ["marketer", "agent.md", marketerBase],
      ["marketer", "positioning.md", marketerPositioning],
      ["marketer", "launch-plan.md", marketerLaunchPlan],
      ["marketer", "content.md", marketerContent],
      // strategist
      ["strategist", "agent.md", strategistBase],
      ["strategist", "competitive-analysis.md", strategistCompetitiveAnalysis],
      ["strategist", "business-case.md", strategistBusinessCase],
      ["strategist", "quarterly-planning.md", strategistQuarterlyPlanning],
      // designer
      ["designer", "agent.md", designerBase],
      ["designer", "ux-research.md", designerUxResearch],
      ["designer", "design-spec.md", designerDesignSpec],
      ["designer", "design-review.md", designerDesignReview],
      // customer-success
      ["customer-success", "agent.md", customerSuccessBase],
      ["customer-success", "support-content.md", customerSuccessSupportContent],
      ["customer-success", "onboarding.md", customerSuccessOnboarding],
      ["customer-success", "feedback-synthesis.md", customerSuccessFeedbackSynthesis],
    ];

    for (const [agentDir, name, content] of dirAgents) {
      if (await writeIfMissing(resolve(agentsDir, agentDir, name), content)) agentCount++;
    }

    // Example-specific agents (from examples/agents/)
    const examplesDir = packageExamplesDir();
    const exampleAgentsDir = resolve(examplesDir, "agents");
    try {
      const exampleAgentFiles = await readdir(exampleAgentsDir);
      for (const file of exampleAgentFiles) {
        if (!file.endsWith(".md")) continue;
        const content = await readFile(resolve(exampleAgentsDir, file), "utf-8");
        if (await writeIfMissing(resolve(agentsDir, file), content)) agentCount++;
      }
    } catch {
      // examples/agents/ may not exist in all installations
    }
  }

  // --- Pipelines ---
  if (!opts.agentsOnly) {
    await mkdir(pipelinesDir, { recursive: true });

    const examplesDir = packageExamplesDir();
    try {
      const files = await readdir(examplesDir);
      for (const file of files) {
        if (!file.endsWith(".yaml") || file === "cccp.yaml") continue;
        const content = await readFile(resolve(examplesDir, file), "utf-8");
        if (await writeIfMissing(resolve(pipelinesDir, file), content)) pipelineCount++;
      }
    } catch {
      // examples/ may not exist in all installations
    }
  }

  // --- Skills (always included) ---
  const skillCount = await scaffoldSkills(dir);

  console.log(`Scaffolded examples in ${dir}:\n`);
  if (!opts.pipelinesOnly) {
    console.log(`  ${agentCount} agent file(s) written to .claude/agents/`);
  }
  if (!opts.agentsOnly) {
    console.log(`  ${pipelineCount} pipeline(s) written to pipelines/`);
  }
  if (skillCount > 0) {
    console.log(`  ${skillCount} skill(s) written to .claude/skills/`);
  }
  console.log(`\n  (existing files were skipped)`);
}
