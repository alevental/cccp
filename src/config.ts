import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Zod schema for cccpr.yaml
// ---------------------------------------------------------------------------

const McpServerSchema = z.object({
  command: z.string(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string()).optional(),
});

const McpProfileSchema = z.object({
  extends: z.string().optional(),
  servers: z.record(McpServerSchema).optional(),
});

const ProjectConfigSchema = z.object({
  /** Ordered list of directories to search for agent definitions. */
  agent_paths: z.array(z.string()).optional(),
  /** Named MCP server profiles. */
  mcp_profiles: z.record(McpProfileSchema).optional(),
  /** Artifact output directory pattern (supports {project}, {pipeline_name}). */
  artifact_dir: z.string().optional(),
  /** Default MCP profile applied when a stage doesn't specify one. */
  default_mcp_profile: z.string().optional(),
});

export type McpServer = z.infer<typeof McpServerSchema>;
export type McpProfile = z.infer<typeof McpProfileSchema>;
export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Load a cccpr.yaml project config from the given directory.
 * Returns an empty config (all defaults) if the file doesn't exist.
 *
 * Paths in `agent_paths` are resolved relative to the config file's directory.
 */
export async function loadProjectConfig(
  projectDir: string,
): Promise<ProjectConfig> {
  const configPath = resolve(projectDir, "cccpr.yaml");

  let raw: string;
  try {
    raw = await readFile(configPath, "utf-8");
  } catch {
    // No config file — return empty defaults.
    return {};
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (err) {
    throw new Error(`Invalid YAML in config file: ${configPath}`, {
      cause: err,
    });
  }

  if (parsed == null) {
    return {};
  }

  const result = ProjectConfigSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Config validation failed for ${configPath}:\n${issues}`);
  }

  const config = result.data;

  // Resolve agent_paths relative to config file location.
  if (config.agent_paths) {
    config.agent_paths = config.agent_paths.map((p) =>
      resolve(dirname(configPath), p),
    );
  }

  return config;
}
