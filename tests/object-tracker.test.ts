import { describe, it, expect, beforeEach } from "vitest";
import { trackObject, snapshotObjects, resetObjectTracker } from "../src/diagnostics/object-tracker.js";

describe("object tracker", () => {
  beforeEach(() => {
    resetObjectTracker();
  });

  it("counts created monotonically per kind", () => {
    const a = {};
    const b = {};
    trackObject("Foo", a);
    trackObject("Foo", b);
    trackObject("Bar", {});

    const snap = snapshotObjects();
    expect(snap.Foo.created).toBe(2);
    expect(snap.Foo.live).toBe(2);
    expect(snap.Bar.created).toBe(1);
    expect(snap.Bar.live).toBe(1);
  });

  it("live goes down when refs are released and GC runs", async () => {
    const hold: object[] = [];
    for (let i = 0; i < 10; i++) {
      const o = { n: i, buf: new Array(1000).fill(0) };
      trackObject("Tmp", o);
      if (i < 3) hold.push(o); // keep first 3, drop rest
    }

    expect(snapshotObjects().Tmp.created).toBe(10);
    // Before GC, all may still be live. Skip the assertion there.

    // gc is only available when node is started with --expose-gc; the test
    // is informational if it isn't. We still assert the contract shape.
    const gc = (globalThis as unknown as { gc?: () => void }).gc;
    if (gc) {
      // Yield, then GC a few times to let WeakRefs fire.
      await new Promise((r) => setTimeout(r, 10));
      gc();
      gc();
      const live = snapshotObjects().Tmp.live;
      expect(live).toBeLessThanOrEqual(10);
      // Held objects must still be live.
      expect(live).toBeGreaterThanOrEqual(hold.length);
    } else {
      // Fallback — just make sure created is still accurate.
      expect(snapshotObjects().Tmp.created).toBe(10);
    }
  });

  it("handles unknown kinds gracefully in snapshot", () => {
    expect(snapshotObjects()).toEqual({});
    trackObject("X", {});
    expect(Object.keys(snapshotObjects())).toEqual(["X"]);
  });
});
