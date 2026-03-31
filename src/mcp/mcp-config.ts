import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { McpProfile, McpServer, ProjectConfig } from "../config.js";
import type { TempFileTracker } from "../temp-tracker.js";

// ---------------------------------------------------------------------------
// MCP config JSON format (what claude --mcp-config expects)
// ---------------------------------------------------------------------------

export interface McpConfigJson {
  mcpServers: Record<
    string,
    {
      command: string;
      args?: string[];
      env?: Record<string, string>;
    }
  >;
}

// ---------------------------------------------------------------------------
// Profile resolution with inheritance
// ---------------------------------------------------------------------------

/**
 * Resolve a named MCP profile from the project config, following `extends` chains.
 * Returns the merged set of MCP servers.
 */
export function resolveProfile(
  profileName: string,
  profiles: Record<string, McpProfile>,
  visited: Set<string> = new Set(),
): Record<string, McpServer> {
  if (visited.has(profileName)) {
    throw new Error(
      `Circular MCP profile inheritance: ${[...visited, profileName].join(" → ")}`,
    );
  }
  visited.add(profileName);

  const profile = profiles[profileName];
  if (!profile) {
    throw new Error(
      `MCP profile "${profileName}" not found. Available: ${Object.keys(profiles).join(", ")}`,
    );
  }

  // Start with parent servers if extending.
  let servers: Record<string, McpServer> = {};
  if (profile.extends) {
    servers = resolveProfile(profile.extends, profiles, visited);
  }

  // Merge this profile's servers (child overrides parent on name collision).
  if (profile.servers) {
    servers = { ...servers, ...profile.servers };
  }

  return servers;
}

// ---------------------------------------------------------------------------
// Config file generation
// ---------------------------------------------------------------------------

/**
 * Build the MCP config JSON object for a given profile.
 */
export function buildMcpConfig(
  profileName: string,
  config: ProjectConfig,
): McpConfigJson {
  const profiles = config.mcp_profiles ?? {};
  const servers = resolveProfile(profileName, profiles);

  const mcpServers: McpConfigJson["mcpServers"] = {};
  for (const [name, server] of Object.entries(servers)) {
    mcpServers[name] = {
      command: server.command,
      ...(server.args?.length ? { args: server.args } : {}),
      ...(server.env && Object.keys(server.env).length > 0
        ? { env: server.env }
        : {}),
    };
  }

  return { mcpServers };
}

/**
 * Write an MCP config JSON file to a temp location and return the path.
 * Returns `undefined` if no profile is specified and no default exists.
 * If a {@link TempFileTracker} is provided the path is registered for
 * automatic cleanup.
 */
export async function writeMcpConfigFile(
  profileName: string | undefined,
  config: ProjectConfig,
  tracker?: TempFileTracker,
): Promise<string | undefined> {
  const name = profileName ?? config.default_mcp_profile;
  if (!name) return undefined;

  if (!config.mcp_profiles || !config.mcp_profiles[name]) {
    // Profile referenced but not defined — only warn if explicitly requested.
    if (profileName) {
      throw new Error(
        `MCP profile "${profileName}" not found in project config`,
      );
    }
    return undefined;
  }

  const mcpConfig = buildMcpConfig(name, config);

  // Don't write a file if there are no servers.
  if (Object.keys(mcpConfig.mcpServers).length === 0) {
    return undefined;
  }

  const filePath = join(tmpdir(), `cccp-mcp-${randomUUID()}.json`);
  await writeFile(filePath, JSON.stringify(mcpConfig, null, 2), "utf-8");
  tracker?.track(filePath);
  return filePath;
}
