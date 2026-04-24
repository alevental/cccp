import React, { useState, useEffect, useRef, useCallback } from "react";
import { render, Box, Text, useStdout, useInput } from "ink";
import { resolve } from "node:path";
import { loadState } from "../state.js";
import { openDatabase } from "../db.js";
import { activityBus } from "../activity-bus.js";
import { DbService } from "../db-service.js";
import { StreamTailer } from "../stream/stream-tail.js";
import type { PipelineState, StateEvent } from "../types.js";
import type { AgentActivity } from "../stream/stream.js";
import { getGitInfo, type GitInfo } from "../git.js";
import { Header, StageList, AgentActivityPanel, isAgentActive } from "./components.js";
import { DetailLog } from "./detail-log.js";
import { MemoryView, MemorySampleRing } from "./memory-view.js";
import {
  MemoryLogger,
  isMemoryLogEnabled,
  memoryLogPath,
  stateJsonPath as stateJsonPathFor,
} from "../diagnostics/memory-log.js";
import {
  installHeapSnapshotHandlers,
  ThresholdSnapshotter,
  writeSnapshot,
} from "../diagnostics/heap-snapshot.js";
import {
  registerActivityMap,
  registerDispatchMap,
  registerEventHistory,
  registerEventHistoryBytes,
  registerMaxEventBytes,
  registerStateBytes,
} from "../diagnostics/runtime-registry.js";
import { trackObject } from "../diagnostics/object-tracker.js";
import { installPerfMeasureSink } from "../diagnostics/perf-measure-sink.js";
import { debug as logDebug } from "../logger.js";

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
  /** Pipeline start time (preserved across remounts). */
  startTime?: number;
  /** Scope display to a sub-pipeline stage's children. */
  scopeStage?: string;
  /** Centralized DB service (standalone mode). Handles reload + WASM reclaim. */
  dbService?: DbService;
  /** Shared memory sample ring — lives outside the Ink tree so history survives the 15-min remount. */
  memSamples?: MemorySampleRing;
  /** Persistent memory JSONL logger — shared across remount cycles. */
  memLogger?: MemoryLogger;
  /** Auto-snapshot on RSS/heap threshold crossings. */
  snapshotter?: ThresholdSnapshotter;
}

function Dashboard({ runId, artifactDir, projectDir, initialState, useEventBus, onComplete, startTime: startTimeProp, scopeStage, dbService, memSamples, memLogger, snapshotter }: DashboardProps) {
  const { stdout } = useStdout();
  const [state, setState] = useState<PipelineState>(initialState);
  const [activities, setActivities] = useState<Map<string, AgentActivity>>(new Map());
  const [events, setEvents] = useState<StateEvent[]>([]);
  const [startTime] = useState(startTimeProp ?? Date.now());
  const [elapsed, setElapsed] = useState(0);
  const [now, setNow] = useState(Date.now());
  const [memUsage, setMemUsage] = useState(process.memoryUsage());
  const [viewMode, setViewMode] = useState<"events" | "memory">("events");
  const [dispatchStartTimes, setDispatchStartTimes] = useState<Map<string, number>>(new Map());
  // Git info: null = loading, undefined = unavailable (not a git repo).
  const [gitInfo, setGitInfo] = useState<GitInfo | null | undefined>(null);
  useEffect(() => {
    getGitInfo(projectDir).then((info) => setGitInfo(info ?? undefined));
  }, []);

  // Expose current Map sizes to the diagnostics registry so memory.jsonl
  // samples can detect unbounded growth. These are refs so the registry
  // reads the latest sizes without triggering re-renders.
  const activitiesRef = useRef<Map<string, AgentActivity>>(new Map());
  activitiesRef.current = activities;
  const dispatchRef = useRef<Map<string, number>>(new Map());
  dispatchRef.current = dispatchStartTimes;
  const eventsRef = useRef<StateEvent[]>([]);
  eventsRef.current = events;
  const stateRef = useRef<PipelineState>(initialState);
  stateRef.current = state;

  // Cached byte-size getters. Computing JSON.stringify on every registry
  // snapshot would be O(eventCount) per read — instead we memoise on a
  // 2-second clock and expose the cached value. The dashboard polls every
  // 500ms, so worst-case staleness is 2s.
  const byteCacheRef = useRef<{
    ts: number;
    eventsBytes: number;
    maxEventBytes: number;
    stateBytes: number;
  }>({ ts: 0, eventsBytes: 0, maxEventBytes: 0, stateBytes: 0 });
  const computeByteSizes = () => {
    const now = Date.now();
    if (now - byteCacheRef.current.ts < 2000) return;
    let total = 0;
    let max = 0;
    for (const ev of eventsRef.current) {
      const n = ev.data ? JSON.stringify(ev.data).length : 0;
      total += n;
      if (n > max) max = n;
    }
    byteCacheRef.current = {
      ts: now,
      eventsBytes: total,
      maxEventBytes: max,
      stateBytes: JSON.stringify(stateRef.current).length,
    };
  };

  useEffect(() => {
    const releaseA = registerActivityMap(() => activitiesRef.current.size);
    const releaseD = registerDispatchMap(() => dispatchRef.current.size);
    const releaseE = registerEventHistory(() => eventsRef.current.length);
    const releaseEB = registerEventHistoryBytes(() => {
      computeByteSizes();
      return byteCacheRef.current.eventsBytes;
    });
    const releaseMB = registerMaxEventBytes(() => {
      computeByteSizes();
      return byteCacheRef.current.maxEventBytes;
    });
    const releaseSB = registerStateBytes(() => {
      computeByteSizes();
      return byteCacheRef.current.stateBytes;
    });
    return () => {
      releaseA();
      releaseD();
      releaseE();
      releaseEB();
      releaseMB();
      releaseSB();
    };
  }, []);
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
    trackObject("AgentActivity", a);
    const doUpdate = (act: AgentActivity) => {
      setActivities((prev) => {
        const next = new Map(prev);
        next.set(act.agent, act);
        return next;
      });
      // Track when we first see an agent key (dispatch start time).
      setDispatchStartTimes((prev) => {
        if (prev.has(act.agent)) return prev;
        const next = new Map(prev);
        next.set(act.agent, Date.now());
        return next;
      });
    };

    // Compare against wall clock, not React state — the callback is memoised
    // with empty deps, so a captured `now` would freeze at mount time and
    // break the 100ms throttle after the first update.
    const ts = Date.now();
    if (ts - lastActivityTime.current >= 100) {
      lastActivityTime.current = ts;
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

  // File-tailing mode for standalone dashboard. Depends on `state.artifactDir`
  // so scoped dashboards switch to the sub-pipeline's .cccp directory once the
  // child state loads (child agents write their .stream.jsonl there, not the
  // parent's artifact dir).
  useEffect(() => {
    if (useEventBus) return;
    const cccpDir = resolve(state.artifactDir, ".cccp");
    const tailer = new StreamTailer(cccpDir);
    tailer.on("activity", (a: AgentActivity) => updateActivity(a));
    tailer.start().catch(() => {});
    return () => { tailer.stop(); };
  }, [state.artifactDir, useEventBus, updateActivity]);

  // Transient status message surfaced by diagnostic keybinds ([g], [h]).
  // Shown for a few seconds then cleared.
  const [diagMsg, setDiagMsg] = useState<string | null>(null);
  const flashDiag = (msg: string) => {
    setDiagMsg(msg);
    setTimeout(() => setDiagMsg((m) => (m === msg ? null : m)), 5000);
  };

  // Pause request + diagnostic keybinds via keyboard.
  const [pauseRequested, setPauseRequested] = useState(false);
  useInput((input) => {
    if ((input === "p" || input === "P") && state.status === "running" && !pauseRequested) {
      setPauseRequested(true);
      try {
        const db = openDatabase(projectDir);
        db.setPauseRequested(state.runId, true);
      } catch {
        // ignore — pause is best-effort from the UI.
      }
    } else if (input === "m" || input === "M") {
      setViewMode((v) => (v === "memory" ? "events" : "memory"));
    } else if (input === "g" || input === "G") {
      // Force a full GC if node was started with --expose-gc. Diffing the
      // before/after numbers tells us whether we're seeing retention or
      // just GC lag.
      const gc = (globalThis as unknown as { gc?: () => void }).gc;
      if (!gc) {
        flashDiag("GC unavailable — start node with --expose-gc");
        return;
      }
      const before = process.memoryUsage();
      gc();
      const after = process.memoryUsage();
      const dRss = (before.rss - after.rss) / 1024 / 1024;
      const dHeap = (before.heapUsed - after.heapUsed) / 1024 / 1024;
      flashDiag(
        `forced GC — reclaimed RSS ${dRss.toFixed(1)}MB, heap ${dHeap.toFixed(1)}MB`,
      );
    } else if (input === "h" || input === "H") {
      // On-demand heap snapshot — opens in Chrome DevTools → Memory.
      try {
        const file = writeSnapshot(artifactDir, runId, "keybind");
        flashDiag(`heap snapshot: ${file}`);
      } catch (err) {
        flashDiag(`snapshot failed: ${(err as Error).message}`);
      }
    }
  });

  // Unified poll: state, events, and elapsed timer via setTimeout chain.
  // Adaptive interval: 500ms when active, 5s when idle (gate pending).
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    let polling = false;
    let cancelled = false;

    const poll = async () => {
      if (polling || cancelled) return;
      polling = true;

      // Tick elapsed timer, current time (for agent elapsed), and memory usage.
      const currentTime = Date.now();
      setElapsed(currentTime - startTime);
      setNow(currentTime);
      setMemUsage(process.memoryUsage());
      memSamples?.record();

      // Check heap/RSS thresholds before the logger sees the sample — that
      // way the auto-snapshot call site matches the value we persist.
      const muNow = process.memoryUsage();
      snapshotter?.maybeSnapshot(muNow.rss, muNow.heapUsed);

      // Persist a memory sample to JSONL. eventCountTotal is filled in from
      // the DB below; use the best-available value from the previous tick.
      try {
        const db = openDatabase(projectDir);
        memLogger?.record(db.countEvents(runId));
      } catch {
        memLogger?.record(0);
      }

      try {
        // Standalone dashboard (no event bus) reads a DB that the runner
        // writes from a different process. Recycle the cached connection
        // so the reader picks up committed WAL frames — long-lived
        // DatabaseSync handles can otherwise pin a stale snapshot.
        const parentState = await loadState(runId, projectDir, !useEventBus);
        if (parentState) {
          // When scoped, extract the child pipeline state from the parent.
          const displayState = scopeStage
            ? parentState.stages[scopeStage]?.children ?? null
            : parentState;

          if (displayState) {
            const stagesJson = JSON.stringify(displayState.stages);
            if (
              displayState.status !== lastStatus.current ||
              stagesJson !== lastStagesJson.current ||
              displayState.gate?.status !== lastGateStatus.current
            ) {
              lastStatus.current = displayState.status;
              lastStagesJson.current = stagesJson;
              lastGateStatus.current = displayState.gate?.status;
              trackObject("PipelineState", displayState);
              setState(displayState);

              // Clean up activities and dispatch times for agents whose stage is no longer in_progress.
              setActivities((prev) => {
                const next = new Map(prev);
                const before = next.size;
                let changed = false;
                const orphans: string[] = [];
                for (const [agentKey] of next) {
                  if (!isAgentActive(agentKey, displayState.stages)) {
                    next.delete(agentKey);
                    orphans.push(agentKey);
                    changed = true;
                  }
                }
                if (changed) {
                  logDebug("leak", "activities-cleanup", { before, after: next.size, orphans });
                }
                return changed ? next : prev;
              });
              setDispatchStartTimes((prev) => {
                const next = new Map(prev);
                const before = next.size;
                let changed = false;
                for (const key of next.keys()) {
                  if (!isAgentActive(key, displayState.stages)) {
                    next.delete(key);
                    changed = true;
                  }
                }
                if (changed) {
                  logDebug("leak", "dispatch-cleanup", { before, after: next.size });
                }
                return changed ? next : prev;
              });

              if (
                displayState.status === "passed" ||
                displayState.status === "failed" ||
                displayState.status === "error" ||
                displayState.status === "paused"
              ) {
                // Stop polling — pipeline has reached a terminal state.
                cancelled = true;
                setTimeout(() => onComplete?.(), 500);
              }
            }
          }

          // Poll events incrementally. When scoped, filter to child events for this stage.
          const db = dbService ? dbService.db() : openDatabase(projectDir);
          const newEvents = db.getEvents(parentState.runId, lastEventId.current);
          if (newEvents.length > 0) {
            lastEventId.current = newEvents[newEvents.length - 1].id;
            const filtered = scopeStage
              ? newEvents
                  .filter((e) => e.stageName === scopeStage && e.eventType.startsWith("child_"))
                  .map((e) => ({
                    ...e,
                    eventType: e.eventType.replace(/^child_/, ""),
                    stageName: (e.data as Record<string, unknown>)?.childStage as string ?? e.stageName,
                  }))
              : newEvents;
            if (filtered.length > 0) {
              for (const ev of filtered) trackObject("StateEvent", ev);
              setEvents((prev) => [...prev, ...filtered].slice(-500));
            }
          }
        }
      } catch {
        // Ignore — DB may be mid-write.
      }

      polling = false;

      // Schedule next poll: 5s when gate is pending (idle), 500ms when active.
      if (!cancelled) {
        const delay = lastGateStatus.current === "pending" ? 5000 : 500;
        timer = setTimeout(poll, delay);
      }
    };

    timer = setTimeout(poll, 500);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [runId, projectDir, startTime, onComplete, useEventBus, scopeStage, dbService, memSamples, memLogger, snapshotter]);

  const isComplete =
    state.status === "passed" ||
    state.status === "failed" ||
    state.status === "error" ||
    state.status === "paused";

  const terminalRows = stdout.rows ?? 24;

  // Compute visible row count including sub-pipeline children and parallel group markers.
  let stageListRows = state.stageOrder.length;
  const groupIds = new Set<string>();
  for (const name of state.stageOrder) {
    const stage = state.stages[name];
    if (stage.type === "pipeline" && stage.children) {
      stageListRows += stage.children.stageOrder.length;
    }
    if (stage.groupId) groupIds.add(stage.groupId);
  }
  stageListRows += groupIds.size * 2; // group start + end markers

  return (
    <Box flexDirection="column" height={terminalRows} overflow="hidden">
      {/* Header */}
      <Header
        pipelineName={state.pipeline}
        project={state.project}
        runId={state.runId}
        elapsed={elapsed}
        memUsage={memUsage}
        gitInfo={gitInfo}
      />

      {/* Split pane: Stages (left) | Activity (right)
         Fixed height prevents Ink re-render corruption when content changes. */}
      <Box marginTop={1} flexDirection="row" height={Math.max(stageListRows + 3, 8)} overflow="hidden">
        <StageList state={state} />
        {!isComplete ? (
          <Box flexDirection="column" flexGrow={1}>
            <AgentActivityPanel activities={activities} stages={state.stages} dispatchStartTimes={dispatchStartTimes} now={now} />
            {pauseRequested && (
              <Text color="blue"> {"\u23F8"} Pause requested {"\u2014"} will pause after current stage</Text>
            )}
            {!pauseRequested && (
              <Text dimColor> [p] pause {"\u00B7"} [m] {viewMode === "memory" ? "events" : "memory"} {"\u00B7"} [g] force-gc {"\u00B7"} [h] heap snapshot</Text>
            )}
            {diagMsg && (
              <Text color="cyan"> {"\u25CF"} {diagMsg}</Text>
            )}
          </Box>
        ) : (
          <Box flexDirection="column" flexGrow={1} marginLeft={1}>
            <Text
              color={state.status === "passed" ? "green" : state.status === "paused" ? "blue" : "red"}
              bold
            >
              Pipeline {state.status}.{state.status === "paused" ? " Resume with: cccp resume" : ""}
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

      {/* Bottom pane: event log or memory diagnostics, toggled with `m`. */}
      {viewMode === "memory" ? (
        <MemoryView
          samples={memSamples}
          events={events.length}
          activities={activities.size}
          dispatches={dispatchStartTimes.size}
          chromeHeight={Math.max(stageListRows + 3, 8) + (gitInfo ? 4 : 3)}
        />
      ) : (
        <DetailLog events={events} chromeHeight={Math.max(stageListRows + 3, 8) + (gitInfo ? 4 : 3)} />
      )}
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
  scopeStage?: string,
): Promise<void> {
  // Drain react-reconciler's PerformanceMeasure emissions — the default
  // perf_hooks buffer is unbounded and Ink re-renders at 10 FPS produce
  // hundreds of measures per tick. Must be installed before Ink mounts.
  // This path is used for the standalone dashboard (`cccp dashboard`) AND
  // for scoped sub-pipeline panes auto-launched in cmux — without this
  // install, scoped dashboards leaked the same 426k-measure retention
  // pattern we fixed in the inline dashboard in v0.17.5.
  const uninstallPerfSink = installPerfMeasureSink();
  const svc = new DbService({ projectDir });
  svc.start();
  const memSamples = new MemorySampleRing();
  const memLogger = isMemoryLogEnabled()
    ? new MemoryLogger(
        memoryLogPath(initialState.artifactDir),
        runId,
        stateJsonPathFor(initialState.artifactDir),
        true,
      )
    : undefined;
  const snapshotter = new ThresholdSnapshotter(initialState.artifactDir, runId);
  const uninstallHeap = installHeapSnapshotHandlers({
    artifactDir: initialState.artifactDir,
    runId,
  });

  return new Promise<void>((resolve) => {
    const { unmount, waitUntilExit } = render(
      <Dashboard
        runId={runId}
        artifactDir={initialState.artifactDir}
        projectDir={projectDir}
        initialState={initialState}
        scopeStage={scopeStage}
        dbService={svc}
        memSamples={memSamples}
        memLogger={memLogger}
        snapshotter={snapshotter}
        onComplete={() => {
          svc.stop();
          memLogger?.close();
          uninstallHeap();
          uninstallPerfSink();
          unmount();
          resolve();
        }}
      />,
      { maxFps: 10 },
    );

    waitUntilExit().then(() => {
      svc.stop();
      memLogger?.close();
      uninstallHeap();
      uninstallPerfSink();
      resolve();
    });
  });
}

// ---------------------------------------------------------------------------
// Inline dashboard (for `cccp run`)
// ---------------------------------------------------------------------------

export interface InlineDashboardHandle {
  unmount: () => void;
}

/**
 * Recycle interval: unmount and remount the Ink app to reclaim yoga-layout
 * WASM memory. WASM linear memory is grow-only, so periodic recycling is
 * the only way to cap memory usage during multi-hour pipeline runs.
 */
const RECYCLE_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes

export function startDashboard(
  runId: string,
  projectDir: string,
  initialState: PipelineState,
): InlineDashboardHandle {
  // Drain react-reconciler's PerformanceMeasure emissions — they otherwise
  // accumulate unbounded in Node's default perf timeline buffer. Must be
  // installed before Ink mounts so the first-render batch is caught too.
  const uninstallPerfSink = installPerfMeasureSink();
  const dashboardStartTime = Date.now();
  const memSamples = new MemorySampleRing();
  const memLogger = isMemoryLogEnabled()
    ? new MemoryLogger(
        memoryLogPath(initialState.artifactDir),
        runId,
        stateJsonPathFor(initialState.artifactDir),
        true,
      )
    : undefined;
  // Threshold snapshotter is owned by the dashboard's poll loop (inline TUI).
  // SIGUSR2 / crash / periodic handlers are installed by runPipeline in the
  // same process — don't install them twice here.
  const snapshotter = new ThresholdSnapshotter(initialState.artifactDir, runId);
  let shuttingDown = false;

  function mount() {
    return render(
      <Dashboard
        runId={runId}
        artifactDir={initialState.artifactDir}
        projectDir={projectDir}
        initialState={initialState}
        useEventBus={true}
        startTime={dashboardStartTime}
        memSamples={memSamples}
        memLogger={memLogger}
        snapshotter={snapshotter}
      />,
      { maxFps: 10 },
    );
  }

  let instance = mount();

  const recycleTimer = setInterval(() => {
    if (shuttingDown) return;
    instance.unmount();
    instance = mount();
  }, RECYCLE_INTERVAL_MS);

  return {
    unmount: () => {
      shuttingDown = true;
      clearInterval(recycleTimer);
      instance.unmount();
      memLogger?.close();
      uninstallPerfSink();
    },
  };
}
