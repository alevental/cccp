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

type SizedMapGetter = () => number;
type AccumulatorCountGetter = () => Record<string, number>;

let activityMapSize: SizedMapGetter = () => 0;
let dispatchMapSize: SizedMapGetter = () => 0;
let accumulatorCounts: AccumulatorCountGetter = () => ({});
let streamTailerCount = 0;
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

/** Agent monitor registers a function that returns per-agent accumulator entry counts. */
export function registerAccumulatorGetter(getter: AccumulatorCountGetter): () => void {
  accumulatorCounts = getter;
  return () => { accumulatorCounts = () => ({}); };
}

/** StreamTailer / SingleFileTailer call these in their constructor and stop(). */
export function incTailerCount(): void { streamTailerCount++; }
export function decTailerCount(): void {
  streamTailerCount = Math.max(0, streamTailerCount - 1);
}

/** Memory log calls this so it can read activityBus.listenerCount without a cycle. */
export function registerActivityBus(bus: typeof ActivityBusType): void {
  activityBusRef = bus;
}

// ---------------------------------------------------------------------------
// Snapshot — read all counters as a plain object
// ---------------------------------------------------------------------------

export interface RegistrySnapshot {
  activityMapSize: number;
  dispatchMapSize: number;
  streamTailerCount: number;
  activityBusListeners: number;
  accumulatorEntryCounts: Record<string, number>;
}

export function snapshotRegistry(): RegistrySnapshot {
  return {
    activityMapSize: activityMapSize(),
    dispatchMapSize: dispatchMapSize(),
    streamTailerCount,
    activityBusListeners: activityBusRef?.listenerCount("activity") ?? 0,
    accumulatorEntryCounts: accumulatorCounts(),
  };
}
