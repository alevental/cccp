import React from "react";
import { Box, Text } from "ink";
import Spinner from "ink-spinner";
import type { PipelineState, StageState, GateInfo, StateEvent } from "../types.js";
import type { AgentActivity } from "../stream/stream.js";

// ---------------------------------------------------------------------------
// Stage list (left pane)
// ---------------------------------------------------------------------------

function stageIcon(status: StageState["status"]): string {
  switch (status) {
    case "passed":
      return "\u2713";
    case "failed":
    case "error":
      return "\u2717";
    case "skipped":
      return "\u23ED";
    case "in_progress":
      return "\u25B6";
    case "pending":
    default:
      return "\u25CB";
  }
}

function stageColor(status: StageState["status"]): string | undefined {
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

function StageRow({ name, stage }: { name: string; stage: StageState }) {
  const icon = stageIcon(stage.status);
  const color = stageColor(stage.status);
  const iterInfo =
    stage.type === "pge" && stage.iteration
      ? ` (${stage.iteration})`
      : "";
  const duration =
    stage.durationMs != null
      ? ` ${(stage.durationMs / 1000).toFixed(1)}s`
      : "";
  const gateTag = stage.type === "human_gate" ? " \u2691" : "";

  if (stage.status === "in_progress") {
    return (
      <Text color="yellow">
        <Spinner type="dots" /> {name}{iterInfo}{gateTag}
      </Text>
    );
  }
  return (
    <Text color={color}>
      {icon} {name}{iterInfo}{duration}{gateTag}
    </Text>
  );
}

export function StageList({ state }: StageListProps) {
  // Group consecutive stages by groupId for visual bracketing.
  const rows: Array<{ kind: "stage"; name: string } | { kind: "group-start" } | { kind: "group-end" }> = [];
  let currentGroupId: string | undefined;

  for (const name of state.stageOrder) {
    const stage = state.stages[name];
    const groupId = stage.groupId;

    if (groupId && groupId !== currentGroupId) {
      // Entering a new parallel group
      if (currentGroupId) rows.push({ kind: "group-end" });
      rows.push({ kind: "group-start" });
      currentGroupId = groupId;
    } else if (!groupId && currentGroupId) {
      // Leaving a parallel group
      rows.push({ kind: "group-end" });
      currentGroupId = undefined;
    }

    rows.push({ kind: "stage", name });
  }
  if (currentGroupId) rows.push({ kind: "group-end" });

  return (
    <Box flexDirection="column" minWidth={24}>
      <Text bold underline>Stages</Text>
      {rows.map((row, i) => {
        if (row.kind === "group-start") {
          return (
            <Box key={`gs-${i}`}>
              <Text dimColor>{" "}{"\u2560"} parallel:</Text>
            </Box>
          );
        }
        if (row.kind === "group-end") {
          return (
            <Box key={`ge-${i}`}>
              <Text dimColor>{" "}{"\u255A"}{"\u2550"}{"\u2550"}</Text>
            </Box>
          );
        }
        const stage = state.stages[row.name];
        const indent = stage.groupId ? " \u2551  " : " ";
        return (
          <Box key={row.name}>
            <Text dimColor>{indent}</Text>
            <StageRow name={row.name} stage={stage} />
          </Box>
        );
      })}
      {state.gate?.status === "pending" && (
        <Box marginTop={1}>
          <Text color="blue" bold>
            {" "}\u23F8 Gate: {state.gate.stageName}
          </Text>
        </Box>
      )}
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Agent activity panel (right pane)
// ---------------------------------------------------------------------------

interface AgentActivityPanelProps {
  activities: Map<string, AgentActivity>;
}

function SingleAgentDetail({ activity }: { activity: AgentActivity }) {
  const recentTools = activity.toolHistory?.slice(-8) ?? [];

  return (
    <Box flexDirection="column">
      {/* Agent name + model */}
      <Box>
        <Text bold>[{activity.agent}]</Text>
        {activity.model && (
          <Text dimColor> {activity.model}</Text>
        )}
      </Box>

      {/* Tool history */}
      {recentTools.length > 0 && (
        <Box flexDirection="column">
          {recentTools.map((t, i) => (
            <Box key={`${t.id}-${i}`}>
              <Text color={t.status === "active" ? "cyan" : "gray"}>
                {"  "}{t.status === "active" ? "\u25B6" : "\u2713"}{" "}
                {t.name}
                {t.summary ? (
                  <Text dimColor> {t.summary.length > 50 ? t.summary.slice(0, 47) + "..." : t.summary}</Text>
                ) : null}
              </Text>
            </Box>
          ))}
        </Box>
      )}

      {/* Thinking preview */}
      {activity.lastThinking && (
        <Text dimColor italic>
          {"  \u{1F4AD} "}
          {activity.lastThinking.slice(0, 80)}
          {activity.lastThinking.length > 80 ? "..." : ""}
        </Text>
      )}

      {/* Sub-agent activity */}
      {activity.lastText && activity.lastText.startsWith("[sub-agent]") && (
        <Text color="magenta">{"  "}{activity.lastText}</Text>
      )}

      {/* Stats */}
      <Box marginTop={1}>
        <Text dimColor>
          {"  "}Tokens: {activity.inputTokens.toLocaleString()} in /{" "}
          {activity.outputTokens.toLocaleString()} out
          {" | "}Tools: {activity.toolCallCount}
          {activity.totalCostUsd > 0 && ` | $${activity.totalCostUsd.toFixed(4)}`}
        </Text>
      </Box>
    </Box>
  );
}

function CompactAgentRow({ activity }: { activity: AgentActivity }) {
  const activeTool = activity.toolHistory?.filter(t => t.status === "active").at(-1);
  return (
    <Box>
      <Text bold>[{activity.agent}]</Text>
      {activeTool && <Text color="cyan"> {"\u25B6"} {activeTool.name}</Text>}
      <Text dimColor>
        {" "}({activity.inputTokens.toLocaleString()}/{activity.outputTokens.toLocaleString()} tok)
      </Text>
    </Box>
  );
}

export function AgentActivityPanel({ activities }: AgentActivityPanelProps) {
  const entries = [...activities.values()];

  if (entries.length === 0) {
    return (
      <Box flexDirection="column" flexGrow={1} marginLeft={1}>
        <Text bold underline>Agent Activity</Text>
        <Text dimColor>Waiting for agent activity...</Text>
      </Box>
    );
  }

  // Single agent: show full detail view (backwards-compatible).
  if (entries.length === 1) {
    return (
      <Box flexDirection="column" flexGrow={1} marginLeft={1}>
        <Text bold underline>Agent Activity</Text>
        <SingleAgentDetail activity={entries[0]} />
      </Box>
    );
  }

  // Multiple agents: compact stacked view.
  return (
    <Box flexDirection="column" flexGrow={1} marginLeft={1}>
      <Text bold underline>Agent Activity ({entries.length} agents)</Text>
      {entries.map((a) => (
        <CompactAgentRow key={a.agent} activity={a} />
      ))}
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Event log (bottom pane)
// ---------------------------------------------------------------------------

interface EventLogProps {
  events: StateEvent[];
}

export function EventLog({ events }: EventLogProps) {
  const recent = events.slice(-8);

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text bold underline>Event Log</Text>
      {recent.length === 0 && (
        <Text dimColor>  No events yet.</Text>
      )}
      {recent.map((e) => {
        const time = e.timestamp.slice(11, 19); // HH:MM:SS
        const stage = e.stageName ? ` ${e.stageName}` : "";
        const detail = e.data ? ` ${formatEventData(e.data)}` : "";
        return (
          <Box key={e.id}>
            <Text dimColor>{time}</Text>
            <Text color={eventColor(e.eventType)}>
              {" "}{formatEventType(e.eventType)}{stage}{detail}
            </Text>
          </Box>
        );
      })}
    </Box>
  );
}

function formatEventType(type: string): string {
  switch (type) {
    case "stage_start": return "\u25B6 Started";
    case "stage_complete": return "\u2713 Completed";
    case "pge_progress": return "\u21BB PGE";
    case "gate_pending": return "\u23F8 Gate pending";
    case "gate_responded": return "\u2713 Gate responded";
    case "pipeline_complete": return "\u2714 Pipeline done";
    default: return type;
  }
}

function eventColor(type: string): string | undefined {
  switch (type) {
    case "stage_start": return "yellow";
    case "stage_complete": return "green";
    case "gate_pending": return "blue";
    case "gate_responded": return "green";
    case "pipeline_complete": return "green";
    default: return undefined;
  }
}

function formatEventData(data: unknown): string {
  if (!data || typeof data !== "object") return "";
  const obj = data as Record<string, unknown>;
  if (obj.status) return `(${obj.status})`;
  if (obj.step) return `(${obj.step})`;
  if (obj.iteration) return `(iter ${obj.iteration})`;
  return "";
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
        CCCP: {pipelineName} ({project})
      </Text>
      <Text dimColor>{"  "}Elapsed: {timeStr}</Text>
    </Box>
  );
}
