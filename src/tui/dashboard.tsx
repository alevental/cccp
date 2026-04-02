import React, { useState, useEffect, useRef, useCallback } from "react";
import { render, Box, Text, useStdout } from "ink";
import { resolve } from "node:path";
import { loadState } from "../state.js";
import { openDatabase } from "../db.js";
import { activityBus } from "../activity-bus.js";
import { StreamTailer } from "../stream/stream-tail.js";
import type { PipelineState, StateEvent } from "../types.js";
import type { AgentActivity } from "../stream/stream.js";
import { Header, StageList, AgentActivityPanel } from "./components.js";
import { DetailLog } from "./detail-log.js";

// ---------------------------------------------------------------------------
// Dashboard app component
// ---------------------------------------------------------------------------

interface DashboardProps {
  runId: string;
  artifactDir: string;
  projectDir: string;
  initialState: PipelineState;
  useEventBus?: boolean;
  onComplete?: () => void;
}

function Dashboard({ runId, artifactDir, projectDir, initialState, useEventBus, onComplete }: DashboardProps) {
  const { stdout } = useStdout();
  const [state, setState] = useState<PipelineState>(initialState);
  const [activities, setActivities] = useState<Map<string, AgentActivity>>(new Map());
  const [events, setEvents] = useState<StateEvent[]>([]);
  const [startTime] = useState(Date.now());
  const [elapsed, setElapsed] = useState(0);
  const lastEventId = useRef(0);
  // Track last-seen state for change detection without stale closure issues.
  const lastStagesJson = useRef<string>(JSON.stringify(initialState.stages));
  const lastStatus = useRef(initialState.status);
  const lastGateStatus = useRef(initialState.gate?.status);

  // Debounce activity updates.
  const lastActivityTime = useRef(0);
  const pendingActivity = useRef<AgentActivity | null>(null);
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const updateActivity = useCallback((a: AgentActivity) => {
    const now = Date.now();
    const doUpdate = (act: AgentActivity) => {
      setActivities((prev) => {
        const next = new Map(prev);
        next.set(act.agent, act);
        return next;
      });
    };

    if (now - lastActivityTime.current >= 100) {
      lastActivityTime.current = now;
      doUpdate(a);
    } else {
      pendingActivity.current = a;
      if (!debounceTimer.current) {
        debounceTimer.current = setTimeout(() => {
          debounceTimer.current = null;
          if (pendingActivity.current) {
            lastActivityTime.current = Date.now();
            doUpdate(pendingActivity.current);
            pendingActivity.current = null;
          }
        }, 100);
      }
    }
  }, []);

  // Subscribe to in-process activity bus.
  useEffect(() => {
    if (!useEventBus) return;
    const handler = (a: AgentActivity) => updateActivity(a);
    activityBus.on("activity", handler);
    return () => {
      activityBus.off("activity", handler);
      if (debounceTimer.current) clearTimeout(debounceTimer.current);
    };
  }, [useEventBus, updateActivity]);

  // File-tailing mode for standalone dashboard.
  useEffect(() => {
    if (useEventBus) return;
    const cccpDir = resolve(artifactDir, ".cccp");
    const tailer = new StreamTailer(cccpDir);
    tailer.on("activity", (a: AgentActivity) => updateActivity(a));
    tailer.start().catch(() => {});
    return () => { tailer.stop(); };
  }, [artifactDir, useEventBus, updateActivity]);

  // Poll SQLite for state changes + events.
  useEffect(() => {
    const interval = setInterval(async () => {
      try {
        const updated = await loadState(runId, projectDir);
        if (!updated) return;

        const stagesJson = JSON.stringify(updated.stages);
        if (
          updated.status !== lastStatus.current ||
          stagesJson !== lastStagesJson.current ||
          updated.gate?.status !== lastGateStatus.current
        ) {
          lastStatus.current = updated.status;
          lastStagesJson.current = stagesJson;
          lastGateStatus.current = updated.gate?.status;
          setState(updated);

          // Clean up activities for stages that are no longer in_progress.
          setActivities((prev) => {
            const next = new Map(prev);
            let changed = false;
            for (const [agent] of next) {
              // Find if any in_progress stage matches this agent key.
              const stillActive = Object.values(updated.stages).some(
                (s) => s.status === "in_progress",
              );
              if (!stillActive) {
                next.delete(agent);
                changed = true;
              }
            }
            return changed ? next : prev;
          });

          if (
            updated.status === "passed" ||
            updated.status === "failed" ||
            updated.status === "error"
          ) {
            setTimeout(() => onComplete?.(), 500);
          }
        }

        // Poll events incrementally.
        const db = await openDatabase(projectDir);
        const newEvents = db.getEvents(updated.runId, lastEventId.current);
        if (newEvents.length > 0) {
          lastEventId.current = newEvents[newEvents.length - 1].id;
          setEvents((prev) => [...prev, ...newEvents].slice(-200));
        }
      } catch {
        // Ignore — DB may be mid-write.
      }
    }, 300);

    return () => clearInterval(interval);
  }, [runId, projectDir, onComplete]);

  // Tick elapsed timer.
  useEffect(() => {
    const interval = setInterval(() => {
      setElapsed(Date.now() - startTime);
    }, 1000);
    return () => clearInterval(interval);
  }, [startTime]);

  const isComplete =
    state.status === "passed" ||
    state.status === "failed" ||
    state.status === "error";

  const terminalRows = stdout.rows ?? 24;

  return (
    <Box flexDirection="column" height={terminalRows} overflow="hidden">
      {/* Header */}
      <Header
        pipelineName={state.pipeline}
        project={state.project}
        elapsed={elapsed}
      />

      {/* Split pane: Stages (left) | Activity (right)
         Fixed height prevents Ink re-render corruption when content changes. */}
      <Box marginTop={1} flexDirection="row" height={Math.max(state.stageOrder.length + 3, 8)} overflow="hidden">
        <StageList state={state} />
        {!isComplete ? (
          <AgentActivityPanel activities={activities} />
        ) : (
          <Box flexDirection="column" flexGrow={1} marginLeft={1}>
            <Text
              color={state.status === "passed" ? "green" : "red"}
              bold
            >
              Pipeline {state.status}.
            </Text>
            {(() => {
              const totalCost = [...activities.values()].reduce((sum, a) => sum + a.totalCostUsd, 0);
              return totalCost > 0 ? (
                <Text dimColor>Total cost: ${totalCost.toFixed(4)}</Text>
              ) : null;
            })()}
          </Box>
        )}
      </Box>

      {/* Event log (bottom) */}
      <DetailLog events={events} chromeHeight={Math.max(state.stageOrder.length + 3, 8) + 3} />
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Launch dashboard (standalone)
// ---------------------------------------------------------------------------

export async function launchDashboard(
  runId: string,
  projectDir: string,
  initialState: PipelineState,
): Promise<void> {
  return new Promise<void>((resolve) => {
    const { unmount, waitUntilExit } = render(
      <Dashboard
        runId={runId}
        artifactDir={initialState.artifactDir}
        projectDir={projectDir}
        initialState={initialState}
        onComplete={() => {
          unmount();
          resolve();
        }}
      />,
    );

    waitUntilExit().then(() => resolve());
  });
}

// ---------------------------------------------------------------------------
// Inline dashboard (for `cccp run`)
// ---------------------------------------------------------------------------

export interface InlineDashboardHandle {
  unmount: () => void;
}

export function startDashboard(
  runId: string,
  projectDir: string,
  initialState: PipelineState,
): InlineDashboardHandle {
  const { unmount } = render(
    <Dashboard
      runId={runId}
      artifactDir={initialState.artifactDir}
      projectDir={projectDir}
      initialState={initialState}
      useEventBus={true}
    />,
  );

  return { unmount };
}
