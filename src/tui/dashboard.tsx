import React, { useState, useEffect } from "react";
import { render, Box, Text } from "ink";
import { watch } from "node:fs";
import { readFile } from "node:fs/promises";
import { statePath } from "../state.js";
import type { PipelineState } from "../state.js";
import type { AgentActivity } from "../stream.js";
import { Header, StageList, AgentActivityPanel } from "./components.js";

// ---------------------------------------------------------------------------
// Dashboard app component
// ---------------------------------------------------------------------------

interface DashboardProps {
  artifactDir: string;
  initialState: PipelineState;
}

function Dashboard({ artifactDir, initialState }: DashboardProps) {
  const [state, setState] = useState<PipelineState>(initialState);
  const [activity, setActivity] = useState<AgentActivity | null>(null);
  const [startTime] = useState(Date.now());
  const [elapsed, setElapsed] = useState(0);

  // Watch state.json for changes.
  useEffect(() => {
    const stateFile = statePath(artifactDir);
    let fsWatcher: ReturnType<typeof watch> | null = null;

    try {
      fsWatcher = watch(stateFile, async () => {
        try {
          const raw = await readFile(stateFile, "utf-8");
          const updated = JSON.parse(raw) as PipelineState;
          setState(updated);
        } catch {
          // File may be mid-write — ignore.
        }
      });
    } catch {
      // File doesn't exist yet — will be created soon.
    }

    return () => {
      fsWatcher?.close();
    };
  }, [artifactDir]);

  // Tick elapsed timer every second.
  useEffect(() => {
    const interval = setInterval(() => {
      setElapsed(Date.now() - startTime);
    }, 1000);
    return () => clearInterval(interval);
  }, [startTime]);

  // Find current in-progress stage for activity display.
  const activeStage = state.stageOrder.find(
    (name) => state.stages[name].status === "in_progress",
  );

  const isComplete =
    state.status === "passed" ||
    state.status === "failed" ||
    state.status === "error";

  return (
    <Box flexDirection="column">
      <Header
        pipelineName={state.pipeline}
        project={state.project}
        elapsed={elapsed}
      />
      <Box marginTop={1}>
        <StageList state={state} />
      </Box>
      {!isComplete && <AgentActivityPanel activity={activity} />}
      {isComplete && (
        <Box marginTop={1}>
          <Text
            color={state.status === "passed" ? "green" : "red"}
            bold
          >
            Pipeline {state.status}.
          </Text>
        </Box>
      )}
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Launch dashboard
// ---------------------------------------------------------------------------

/**
 * Render the dashboard TUI. Blocks until the pipeline completes or the user
 * exits with Ctrl+C.
 */
export async function launchDashboard(
  artifactDir: string,
  initialState: PipelineState,
): Promise<void> {
  const { waitUntilExit } = render(
    <Dashboard artifactDir={artifactDir} initialState={initialState} />,
  );

  // Watch for pipeline completion.
  const stateFile = statePath(artifactDir);
  const completionWatcher = watch(stateFile, async () => {
    try {
      const raw = await readFile(stateFile, "utf-8");
      const state = JSON.parse(raw) as PipelineState;
      if (
        state.status === "passed" ||
        state.status === "failed" ||
        state.status === "error"
      ) {
        // Give it a moment for the final render, then exit.
        setTimeout(() => process.exit(0), 1000);
      }
    } catch {
      // ignore
    }
  });

  try {
    await waitUntilExit();
  } finally {
    completionWatcher.close();
  }
}
