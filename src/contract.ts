import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { ContractCriterion } from "./types.js";

// ---------------------------------------------------------------------------
// Contract generation
// ---------------------------------------------------------------------------

export interface ContractOptions {
  /** Sub-stage / stage name. */
  stageName: string;
  /** Path where the deliverable will be written. */
  deliverable: string;
  /** Success criteria from the pipeline YAML. */
  criteria: ContractCriterion[];
  /** Maximum PGE iterations. */
  maxIterations: number;
  /** Optional path to a custom contract template. */
  templatePath?: string;
}

/**
 * Generate a contract markdown file from criteria.
 *
 * If `templatePath` is provided, reads and uses that template (must contain
 * `{stage_name}`, `{deliverable}`, `{criteria_table}`, `{max_iterations}`
 * placeholders). Otherwise uses the built-in default.
 */
export async function generateContract(
  opts: ContractOptions,
): Promise<string> {
  if (opts.templatePath) {
    const template = await readFile(opts.templatePath, "utf-8");
    return applyTemplate(template, opts);
  }

  return buildDefaultContract(opts);
}

/**
 * Generate and write a contract file to disk.
 * Creates parent directories as needed.
 */
export async function writeContract(
  contractPath: string,
  opts: ContractOptions,
): Promise<void> {
  const content = await generateContract(opts);
  await mkdir(dirname(contractPath), { recursive: true });
  await writeFile(contractPath, content, "utf-8");
}

// ---------------------------------------------------------------------------
// Default contract format (matches squatlypowers contract template)
// ---------------------------------------------------------------------------

function buildDefaultContract(opts: ContractOptions): string {
  const criteriaRows = opts.criteria
    .map((c, i) => `| ${i + 1} | ${c.name} | ${c.description} |`)
    .join("\n");

  return `## Contract: ${opts.stageName}

### Deliverable

${opts.deliverable}

### Success Criteria

| # | Criterion | Description |
|---|-----------|-------------|
${criteriaRows}

### Pass Rule

ALL criteria must pass. Any single failure = overall FAIL.

### Max Iterations: ${opts.maxIterations}
`;
}

// ---------------------------------------------------------------------------
// Custom template support
// ---------------------------------------------------------------------------

function applyTemplate(template: string, opts: ContractOptions): string {
  const criteriaRows = opts.criteria
    .map((c, i) => `| ${i + 1} | ${c.name} | ${c.description} |`)
    .join("\n");

  return template
    .replace(/\{stage_name\}/g, opts.stageName)
    .replace(/\{deliverable\}/g, opts.deliverable)
    .replace(/\{criteria_table\}/g, criteriaRows)
    .replace(/\{max_iterations\}/g, String(opts.maxIterations));
}
