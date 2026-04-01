import { resolveAgent } from "./agent-resolver.js";
import { loadAgentMarkdown, interpolate } from "./prompt.js";
import { writeMcpConfigFile } from "./mcp/mcp-config.js";
import type { PgeAgentConfig, RunContext } from "./types.js";

// ---------------------------------------------------------------------------
// Input merging — stage-level + agent-level inputs, interpolated
// ---------------------------------------------------------------------------

export function mergeInputs(
  stageInputs: string[] | undefined,
  agentInputs: string[] | undefined,
  vars: Record<string, string>,
  extra?: string[],
): string[] {
  const all = [
    ...(stageInputs ?? []),
    ...(agentInputs ?? []),
    ...(extra ?? []),
  ];
  return all.map((i) => interpolate(i, vars));
}

// ---------------------------------------------------------------------------
// Agent resolution helper
// ---------------------------------------------------------------------------

export async function resolveAndLoad(
  config: PgeAgentConfig,
  ctx: RunContext,
  stageMcpProfile: string | undefined,
) {
  const resolved = await resolveAgent(
    config.agent,
    ctx.agentSearchPaths,
    config.operation,
    ctx.projectDir,
  );
  const markdown = await loadAgentMarkdown(
    resolved.agentPath,
    resolved.operationPath,
  );
  const mcpProfile = config.mcp_profile ?? stageMcpProfile;
  const mcpFile = ctx.projectConfig
    ? await writeMcpConfigFile(mcpProfile, ctx.projectConfig, ctx.tempTracker)
    : undefined;
  return { resolved, markdown, mcpFile };
}
