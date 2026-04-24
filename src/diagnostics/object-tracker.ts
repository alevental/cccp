// ---------------------------------------------------------------------------
// WeakRef-based object lifetime tracker.
//
// Register known object kinds (StateEvent, PipelineState, AgentActivity, …)
// at construction time. Each call bumps a monotonic `created` counter and
// stashes a WeakRef. A periodic sweep drops refs whose target has been GC'd.
//
// The snapshot returns {kind: {created, live}} — a diverging created-vs-live
// ratio localises retention to a specific class even when the aggregate
// heap number doesn't tell you which allocations survived.
// ---------------------------------------------------------------------------
interface Bucket {
  created: number;
  refs: WeakRef<object>[];
}

const buckets = new Map<string, Bucket>();
const MAX_REFS_PER_KIND = 50_000;

/** Register an object under a kind label. Cheap: allocates one WeakRef. */
export function trackObject(kind: string, obj: object): void {
  let b = buckets.get(kind);
  if (!b) {
    b = { created: 0, refs: [] };
    buckets.set(kind, b);
  }
  b.created++;
  // Cap refs array so we don't indefinitely grow a per-kind array of
  // dead WeakRefs if sweep() is called infrequently.
  if (b.refs.length < MAX_REFS_PER_KIND) {
    b.refs.push(new WeakRef(obj));
  }
}

/** Drop refs that have been collected. Called before every snapshot. */
function sweep(): void {
  for (const b of buckets.values()) {
    b.refs = b.refs.filter((r) => r.deref() !== undefined);
  }
}

export interface ObjectSnapshot {
  [kind: string]: { created: number; live: number };
}

export function snapshotObjects(): ObjectSnapshot {
  sweep();
  const out: ObjectSnapshot = {};
  for (const [k, b] of buckets) {
    out[k] = { created: b.created, live: b.refs.length };
  }
  return out;
}

/** Reset everything — used by tests. */
export function resetObjectTracker(): void {
  buckets.clear();
}
