import React from "react";
import { Box, Text } from "ink";
import type { PipelineState, StageState } from "../state.js";
import type { AgentActivity } from "../stream.js";

// ---------------------------------------------------------------------------
// Stage list
// ---------------------------------------------------------------------------

function stageIcon(status: StageState["status"]): string {
  switch (status) {
    case "passed":
      return "✓";
    case "failed":
    case "error":
      return "✗";
    case "skipped":
      return "⏭";
    case "in_progress":
      return "⚙";
    case "pending":
    default:
      return "○";
  }
}

function stageColor(
  status: StageState["status"],
): string | undefined {
  switch (status) {
    case "passed":
      return "green";
    case "failed":
    case "error":
      return "red";
    case "skipped":
      return "gray";
    case "in_progress":
      return "yellow";
    default:
      return undefined;
  }
}

interface StageListProps {
  state: PipelineState;
}

export function StageList({ state }: StageListProps) {
  return (
    <Box flexDirection="column">
      {state.stageOrder.map((name) => {
        const stage = state.stages[name];
        const icon = stageIcon(stage.status);
        const color = stageColor(stage.status);
        const iterInfo =
          stage.type === "pge" && stage.iteration
            ? ` (iter ${stage.iteration})`
            : "";
        const duration =
          stage.durationMs != null
            ? ` ${(stage.durationMs / 1000).toFixed(1)}s`
            : "";
        const gateTag = stage.type === "human_gate" ? " (gate)" : "";

        return (
          <Box key={name}>
            <Text color={color}>
              {" "}
              {icon} {name}
              {iterInfo}
              {duration}
              {gateTag}
            </Text>
          </Box>
        );
      })}
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Agent activity panel
// ---------------------------------------------------------------------------

interface AgentActivityPanelProps {
  activity: AgentActivity | null;
}

export function AgentActivityPanel({ activity }: AgentActivityPanelProps) {
  if (!activity) {
    return (
      <Box marginTop={1}>
        <Text dimColor>Waiting for agent activity...</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text bold>[{activity.agent}]</Text>
      {activity.activeTools.length > 0 && (
        <Text color="cyan">
          {"  "}→ {activity.activeTools.join(", ")}
        </Text>
      )}
      {activity.lastText && (
        <Text dimColor>
          {"  "}
          {activity.lastText.slice(0, 80)}
          {activity.lastText.length > 80 ? "..." : ""}
        </Text>
      )}
      <Text dimColor>
        {"  "}Tokens: {activity.inputTokens.toLocaleString()} in /{" "}
        {activity.outputTokens.toLocaleString()} out | Tools:{" "}
        {activity.toolCallCount}
      </Text>
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

interface HeaderProps {
  pipelineName: string;
  project: string;
  elapsed: number;
}

export function Header({ pipelineName, project, elapsed }: HeaderProps) {
  const mins = Math.floor(elapsed / 60000);
  const secs = Math.floor((elapsed % 60000) / 1000);
  const timeStr = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;

  return (
    <Box>
      <Text bold>
        CCCPR: {pipelineName} ({project})
      </Text>
      <Text dimColor>{"  "}Elapsed: {timeStr}</Text>
    </Box>
  );
}
