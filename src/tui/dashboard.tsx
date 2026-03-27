import React, { useState, useEffect, useRef, useCallback } from "react";
import { render, Box, Text } from "ink";
import { resolve } from "node:path";
import { loadState } from "../state.js";
import { openDatabase, type StateEvent } from "../db.js";
import { activityBus } from "../activity-bus.js";
import { StreamTailer } from "../stream-tail.js";
import type { PipelineState } from "../state.js";
import type { AgentActivity } from "../stream.js";
import { Header, StageList, AgentActivityPanel, EventLog } from "./components.js";

// ---------------------------------------------------------------------------
// Dashboard app component
// ---------------------------------------------------------------------------

interface DashboardProps {
  artifactDir: string;
  projectDir: string;
  initialState: PipelineState;
  useEventBus?: boolean;
  onComplete?: () => void;
}

function Dashboard({ artifactDir, projectDir, initialState, useEventBus, onComplete }: DashboardProps) {
  const [state, setState] = useState<PipelineState>(initialState);
  const [activity, setActivity] = useState<AgentActivity | null>(null);
  const [events, setEvents] = useState<StateEvent[]>([]);
  const [startTime] = useState(Date.now());
  const [elapsed, setElapsed] = useState(0);
  const lastEventId = useRef(0);

  // Debounce activity updates.
  const lastActivityTime = useRef(0);
  const pendingActivity = useRef<AgentActivity | null>(null);
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const updateActivity = useCallback((a: AgentActivity) => {
    const now = Date.now();
    if (now - lastActivityTime.current >= 100) {
      lastActivityTime.current = now;
      setActivity(a);
    } else {
      pendingActivity.current = a;
      if (!debounceTimer.current) {
        debounceTimer.current = setTimeout(() => {
          debounceTimer.current = null;
          if (pendingActivity.current) {
            lastActivityTime.current = Date.now();
            setActivity(pendingActivity.current);
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
        const updated = await loadState(artifactDir, projectDir);
        if (!updated) return;

        if (
          updated.status !== state.status ||
          JSON.stringify(updated.stages) !== JSON.stringify(state.stages) ||
          updated.gate?.status !== state.gate?.status
        ) {
          setState(updated);

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
          setEvents((prev) => [...prev, ...newEvents].slice(-50));
        }
      } catch {
        // Ignore — DB may be mid-write.
      }
    }, 300);

    return () => clearInterval(interval);
  }, [artifactDir, projectDir, onComplete]);

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

  return (
    <Box flexDirection="column">
      {/* Header */}
      <Header
        pipelineName={state.pipeline}
        project={state.project}
        elapsed={elapsed}
      />

      {/* Split pane: Stages (left) | Activity (right) */}
      <Box marginTop={1} flexDirection="row">
        <StageList state={state} />
        {!isComplete ? (
          <AgentActivityPanel activity={activity} />
        ) : (
          <Box flexDirection="column" flexGrow={1} marginLeft={1}>
            <Text
              color={state.status === "passed" ? "green" : "red"}
              bold
            >
              Pipeline {state.status}.
            </Text>
            {activity && activity.totalCostUsd > 0 && (
              <Text dimColor>
                Total cost: ${activity.totalCostUsd.toFixed(4)}
              </Text>
            )}
          </Box>
        )}
      </Box>

      {/* Event log (bottom) */}
      <EventLog events={events} />
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Launch dashboard (standalone)
// ---------------------------------------------------------------------------

export async function launchDashboard(
  artifactDir: string,
  projectDir: string,
  initialState: PipelineState,
): Promise<void> {
  return new Promise<void>((resolve) => {
    const { unmount, waitUntilExit } = render(
      <Dashboard
        artifactDir={artifactDir}
        projectDir={projectDir}
        initialState={initialState}
        onComplete={() => {
          unmount();
          resolve();
        }}
      />,
    );

    waitUntilExit().then(resolve);
  });
}

// ---------------------------------------------------------------------------
// Inline dashboard (for `cccp run`)
// ---------------------------------------------------------------------------

export interface InlineDashboardHandle {
  unmount: () => void;
}

export function startDashboard(
  artifactDir: string,
  projectDir: string,
  initialState: PipelineState,
): InlineDashboardHandle {
  const { unmount } = render(
    <Dashboard
      artifactDir={artifactDir}
      projectDir={projectDir}
      initialState={initialState}
      useEventBus={true}
    />,
  );

  return { unmount };
}
