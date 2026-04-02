import { resolveAgent } from "./agent-resolver.js";
import { loadAgentMarkdown, interpolate } from "./prompt.js";
import { writeMcpConfigFile } from "./mcp/mcp-config.js";
import type { PgeAgentConfig, PhaseDefaults, RunContext } from "./types.js";

// ---------------------------------------------------------------------------
// Model/effort resolution — agent config > stage > phase defaults > pipeline
// ---------------------------------------------------------------------------

/** Phase names that can appear in phase_defaults. */
export type PhaseName = keyof PhaseDefaults;

/**
 * Resolve model/effort for a single agent dispatch.
 * Resolution order: agent config > stage > phase_defaults > pipeline.
 */
export function resolveModelEffort(
  agentConfig: { model?: string; effort?: string },
  stage: { model?: string; effort?: string },
  pipeline: { model?: string; effort?: string; phase_defaults?: PhaseDefaults },
  phase?: PhaseName,
): { model?: string; effort?: string } {
  const phaseDefault = phase ? pipeline.phase_defaults?.[phase] : undefined;
  return {
    model: agentConfig.model ?? stage.model ?? phaseDefault?.model ?? pipeline.model,
    effort: agentConfig.effort ?? stage.effort ?? phaseDefault?.effort ?? pipeline.effort,
  };
}

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
