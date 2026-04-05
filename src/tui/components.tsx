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
    // Static icon for human_gate stages — avoids Spinner animation that drives
    // continuous Ink re-renders and yoga-layout WASM memory growth during long waits.
    if (stage.type === "human_gate") {
      return (
        <Text color="blue">
          {"\u23F8"} {name}{gateTag}
        </Text>
      );
    }
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

type StageRow_t =
  | { kind: "stage"; name: string; childLevel?: number; parentName?: string }
  | { kind: "group-start" }
  | { kind: "group-end" };

export function StageList({ state }: StageListProps) {
  // Group consecutive stages by groupId for visual bracketing.
  const rows: StageRow_t[] = [];
  let currentGroupId: string | undefined;

  for (const name of state.stageOrder) {
    const stage = state.stages[name];
    const groupId = stage.groupId;

    if (groupId && groupId !== currentGroupId) {
      if (currentGroupId) rows.push({ kind: "group-end" });
      rows.push({ kind: "group-start" });
      currentGroupId = groupId;
    } else if (!groupId && currentGroupId) {
      rows.push({ kind: "group-end" });
      currentGroupId = undefined;
    }

    rows.push({ kind: "stage", name });

    // Render nested sub-pipeline children inline.
    if (stage.type === "pipeline" && stage.children) {
      for (const childName of stage.children.stageOrder) {
        rows.push({ kind: "stage", name: childName, childLevel: 1, parentName: name });
      }
    }
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

        // Nested sub-pipeline child stage.
        if (row.childLevel && row.parentName) {
          // Look up child stage from the specific parent pipeline stage.
          const parentStage = state.stages[row.parentName];
          const childStage = parentStage?.children?.stages[row.name];
          if (!childStage) return null;
          return (
            <Box key={`child-${row.name}`}>
              <Text dimColor>{"    \u251C\u2500 "}</Text>
              <StageRow name={row.name} stage={childStage} />
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

/** Format a duration in ms as "Xm Ys" or "Xs". */
function formatElapsed(ms: number): string {
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  return `${mins}m ${secs % 60}s`;
}

/** Format token count compactly: 1234 → "1.2k", 500 → "500". */
function fmtTok(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

interface AgentActivityPanelProps {
  activities: Map<string, AgentActivity>;
  stages: Record<string, StageState>;
  dispatchStartTimes: Map<string, number>;
  now: number;
}

function AgentDetailColumn({ activity, elapsed }: { activity: AgentActivity; elapsed: string }) {
  const recentTools = activity.toolHistory?.slice(-5) ?? [];

  return (
    <Box flexDirection="column" flexGrow={1}>
      <Text bold>[{activity.agent}]</Text>
      <Text dimColor>
        {activity.model ? ` ${activity.model}` : ""}
        {" \u00B7 "}{elapsed}
      </Text>

      {recentTools.length > 0 && (
        <Box flexDirection="column">
          {recentTools.map((t, i) => (
            <Box key={`${t.id}-${i}`}>
              <Text color={t.status === "active" ? "cyan" : "gray"}>
                {"  "}{t.status === "active" ? "\u25B6" : "\u2713"}{" "}
                {t.name}
                {t.summary ? (
                  <Text dimColor> {t.summary.length > 40 ? t.summary.slice(0, 37) + "..." : t.summary}</Text>
                ) : null}
              </Text>
            </Box>
          ))}
        </Box>
      )}

      <Text dimColor>
        {"  "}{fmtTok(activity.inputTokens)}/{fmtTok(activity.outputTokens)} tok
        {activity.totalCostUsd > 0 && ` \u00B7 $${activity.totalCostUsd.toFixed(2)}`}
      </Text>
    </Box>
  );
}

function CompactAgentRow({ activity, elapsed }: { activity: AgentActivity; elapsed: string }) {
  const activeTool = activity.toolHistory?.filter(t => t.status === "active").at(-1);
  return (
    <Box>
      <Text bold>[{activity.agent}]</Text>
      <Text dimColor> {activity.model ?? ""} \u00B7 {elapsed}</Text>
      {activeTool && <Text color="cyan">  {"\u25B6"} {activeTool.name}</Text>}
      <Text dimColor>
        {"  "}{fmtTok(activity.inputTokens)}/{fmtTok(activity.outputTokens)} tok
        {activity.totalCostUsd > 0 && ` \u00B7 $${activity.totalCostUsd.toFixed(2)}`}
      </Text>
    </Box>
  );
}

/** Check if an agent key matches any in_progress stage, including sub-pipeline children. */
export function isAgentActive(agentKey: string, stages: Record<string, StageState>): boolean {
  return Object.values(stages).some((s) => {
    if (s.status === "in_progress" && agentKey.startsWith(s.name)) return true;
    // Check sub-pipeline children.
    if (s.type === "pipeline" && s.status === "in_progress" && s.children) {
      return Object.values(s.children.stages).some(
        (cs) => cs.status === "in_progress" && agentKey.startsWith(cs.name),
      );
    }
    return false;
  });
}

export function AgentActivityPanel({ activities, stages, dispatchStartTimes, now }: AgentActivityPanelProps) {
  // Filter to only agents with a corresponding in_progress stage.
  const activeEntries = [...activities.entries()].filter(([agentKey]) => {
    return isAgentActive(agentKey, stages);
  });

  if (activeEntries.length === 0) {
    return (
      <Box flexDirection="column" flexGrow={1} marginLeft={1}>
        <Text bold underline>Agent Activity</Text>
        <Text dimColor>Waiting for agent activity...</Text>
      </Box>
    );
  }

  const count = activeEntries.length;

  // 1-3 agents: horizontal columns
  if (count <= 3) {
    return (
      <Box flexDirection="column" flexGrow={1} marginLeft={1}>
        <Text bold underline>Agent Activity ({count} active)</Text>
        <Box flexDirection="row">
          {activeEntries.map(([key, activity], i) => {
            const startMs = dispatchStartTimes.get(key) ?? now;
            const elapsed = formatElapsed(now - startMs);
            return (
              <React.Fragment key={key}>
                {i > 0 && <Text dimColor> {"\u2502"} </Text>}
                <AgentDetailColumn activity={activity} elapsed={elapsed} />
              </React.Fragment>
            );
          })}
        </Box>
      </Box>
    );
  }

  // 4+ agents: compact stacked rows
  return (
    <Box flexDirection="column" flexGrow={1} marginLeft={1}>
      <Text bold underline>Agent Activity ({count} active)</Text>
      {activeEntries.map(([key, activity]) => {
        const startMs = dispatchStartTimes.get(key) ?? now;
        const elapsed = formatElapsed(now - startMs);
        return <CompactAgentRow key={key} activity={activity} elapsed={elapsed} />;
      })}
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
