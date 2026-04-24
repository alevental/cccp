// ---------------------------------------------------------------------------
// Runtime counter registry for memory diagnostics.
//
// The memory JSONL logger needs visibility into in-process state that might
// leak (dashboard Maps, stream tailer count, accumulator entry counts).
// Rather than thread those refs through every call site, components register
// themselves here and the diagnostics layer reads them out on every sample.
//
// Kept intentionally simple: module-level singletons, no subscribers. Unset
// getters return 0 / empty so headless runs (no dashboard) sample cleanly.
// ---------------------------------------------------------------------------

import type { activityBus as ActivityBusType } from "../activity-bus.js";
import {
  activeHandleCounts,
  heapCodeStats,
  eventLoopUtilization,
  resourceUsage,
} from "./runtime-introspection.js";
import { snapshotObjects, type ObjectSnapshot } from "./object-tracker.js";

type SizedMapGetter = () => number;
type AccumulatorCountGetter = () => Record<string, number>;

let activityMapSize: SizedMapGetter = () => 0;
let dispatchMapSize: SizedMapGetter = () => 0;
let eventHistorySize: SizedMapGetter = () => 0;
let eventHistoryBytes: SizedMapGetter = () => 0;
let maxEventBytes: SizedMapGetter = () => 0;
let stateBytes: SizedMapGetter = () => 0;
let accumulatorCounts: AccumulatorCountGetter = () => ({});
const monitorAccumulators = new Map<string, SizedMapGetter>();
let streamTailerCount = 0;
let activityBusEmitCount = 0;
let activityBusRef: typeof ActivityBusType | null = null;

/** Dashboard registers a function that returns its activities Map size. */
export function registerActivityMap(getter: SizedMapGetter): () => void {
  activityMapSize = getter;
  return () => { activityMapSize = () => 0; };
}

/** Dashboard registers a function that returns its dispatch-start-times Map size. */
export function registerDispatchMap(getter: SizedMapGetter): () => void {
  dispatchMapSize = getter;
  return () => { dispatchMapSize = () => 0; };
}

/** Dashboard registers a function that returns its event-history array length. */
export function registerEventHistory(getter: SizedMapGetter): () => void {
  eventHistorySize = getter;
  return () => { eventHistorySize = () => 0; };
}

/** Dashboard registers a function that returns total byte size of retained event data payloads. */
export function registerEventHistoryBytes(getter: SizedMapGetter): () => void {
  eventHistoryBytes = getter;
  return () => { eventHistoryBytes = () => 0; };
}

/** Dashboard registers a function that returns the single largest event's payload byte size. */
export function registerMaxEventBytes(getter: SizedMapGetter): () => void {
  maxEventBytes = getter;
  return () => { maxEventBytes = () => 0; };
}

/** Dashboard registers a function that returns JSON.stringify(state).length for the current PipelineState. */
export function registerStateBytes(getter: SizedMapGetter): () => void {
  stateBytes = getter;
  return () => { stateBytes = () => 0; };
}

/** Runner / bus owner calls this per activity emit — monotonic counter. */
export function incActivityBusEmit(): void { activityBusEmitCount++; }

/** Agent monitor registers a function that returns per-agent accumulator entry counts. */
export function registerAccumulatorGetter(getter: AccumulatorCountGetter): () => void {
  accumulatorCounts = getter;
  return () => { accumulatorCounts = () => ({}); };
}

/** Each StreamDetailAccumulator-bearing tailer registers its own entry-count getter, keyed by agent name. */
export function registerMonitorAccumulator(name: string, getter: SizedMapGetter): () => void {
  monitorAccumulators.set(name, getter);
  return () => { monitorAccumulators.delete(name); };
}

/** StreamTailer / SingleFileTailer call these in their constructor and stop(). */
export function incTailerCount(): void { streamTailerCount++; }
export function decTailerCount(): void {
  streamTailerCount = Math.max(0, streamTailerCount - 1);
}

/** Memory log calls this so it can read activityBus.listenerCount without a cycle.
 *  Also attaches a listener that increments the emit counter — listeners run on
 *  every emit, so this gives us a cheap monotonic throughput counter. */
export function registerActivityBus(bus: typeof ActivityBusType): void {
  if (activityBusRef === bus) return; // idempotent
  activityBusRef = bus;
  bus.on("activity", () => { activityBusEmitCount++; });
}

// ---------------------------------------------------------------------------
// Snapshot — read all counters as a plain object
// ---------------------------------------------------------------------------

export interface RegistrySnapshot {
  activityMapSize: number;
  dispatchMapSize: number;
  eventHistorySize: number;
  eventHistoryBytes: number;
  maxEventBytes: number;
  stateBytes: number;
  streamTailerCount: number;
  activityBusListeners: number;
  activityBusEmitCount: number;
  accumulatorEntryCounts: Record<string, number>;
  activeHandles: Record<string, number>;
  heapCodeStats: {
    codeAndMetadataSize: number;
    bytecodeAndMetadataSize: number;
    externalScriptSourceSize: number;
  };
  eventLoopUtilization: { utilization: number; idleMs: number; activeMs: number };
  resourceUsage: {
    userCPUTimeMs: number;
    systemCPUTimeMs: number;
    maxRssKB: number;
    minorPageFaults: number;
    majorPageFaults: number;
    voluntaryContextSwitches: number;
    involuntaryContextSwitches: number;
  };
  objectTracker: ObjectSnapshot;
}

export function snapshotRegistry(): RegistrySnapshot {
  const counts: Record<string, number> = { ...accumulatorCounts() };
  for (const [name, get] of monitorAccumulators) counts[name] = get();
  return {
    activityMapSize: activityMapSize(),
    dispatchMapSize: dispatchMapSize(),
    eventHistorySize: eventHistorySize(),
    eventHistoryBytes: eventHistoryBytes(),
    maxEventBytes: maxEventBytes(),
    stateBytes: stateBytes(),
    streamTailerCount,
    activityBusListeners: activityBusRef?.listenerCount("activity") ?? 0,
    activityBusEmitCount,
    accumulatorEntryCounts: counts,
    activeHandles: activeHandleCounts(),
    heapCodeStats: heapCodeStats(),
    eventLoopUtilization: eventLoopUtilization(),
    resourceUsage: resourceUsage(),
    objectTracker: snapshotObjects(),
  };
}
