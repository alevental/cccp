import { loadState } from "../state.js";
import { reclaimWasmMemory } from "../db.js";
import type { GateInfo } from "../types.js";
import type { GateResponse, GateStrategy } from "./gate-strategy.js";
import { notifyGateRequired } from "../tui/cmux.js";
import type { DbService } from "../db-service.js";

// ---------------------------------------------------------------------------
// Filesystem-polling gate strategy
// ---------------------------------------------------------------------------

const POLL_INTERVAL_MS = 5000;

/** Reclaim sql.js WASM memory every ~15 minutes (180 polls × 5s). */
const WASM_RECLAIM_EVERY = 180;

/** Safety timeout: 12 hours at 5s per poll = 8640 polls. */
const MAX_POLL_COUNT = 8640;

/**
 * Gate strategy that writes `gate_pending` to state.json and polls for
 * a response. The response comes from either:
 * - The MCP server (pipeline_gate_respond tool)
 * - Direct edit of state.json
 */
export class FilesystemGateStrategy implements GateStrategy {
  constructor(
    private runId: string,
    private projectDir?: string,
    private quiet?: boolean,
    private dbService?: DbService,
  ) {}

  async waitForGate(gate: GateInfo): Promise<GateResponse> {
    await notifyGateRequired(gate.stageName);

    if (!this.quiet) {
      console.log(`    ⏸ Waiting for gate approval: ${gate.stageName}`);
      if (gate.prompt) console.log(`      ${gate.prompt}`);
    }

    return new Promise<GateResponse>((resolve, reject) => {
      let pollCount = 0;
      const interval = setInterval(async () => {
        try {
          pollCount++;

          // Safety timeout — prevent infinite polling on corrupted state.
          if (pollCount > MAX_POLL_COUNT) {
            clearInterval(interval);
            reject(new Error(`Gate "${gate.stageName}" timed out after ${MAX_POLL_COUNT} polls (~12 hours)`));
            return;
          }

          // Periodically reclaim sql.js WASM linear memory (only when
          // no DbService is provided — the service manages its own timer).
          if (!this.dbService && pollCount % WASM_RECLAIM_EVERY === 0) {
            reclaimWasmMemory();
          }

          const state = await loadState(this.runId, this.projectDir, true);
          if (!state?.gate) return;

          if (state.gate.stageName !== gate.stageName) return;

          if (state.gate.status === "approved") {
            clearInterval(interval);
            if (!this.quiet) console.log(`    ✓ Gate approved`);
            resolve({
              approved: true,
              feedback: state.gate.feedback,
              feedbackPath: state.gate.feedbackPath,
            });
          } else if (state.gate.status === "rejected") {
            clearInterval(interval);
            if (!this.quiet) {
              console.log(`    ✗ Gate rejected${state.gate.feedback ? `: ${state.gate.feedback}` : ""}`);
            }
            resolve({
              approved: false,
              feedback: state.gate.feedback,
              feedbackPath: state.gate.feedbackPath,
            });
          }
        } catch {
          // State file may be mid-write — ignore and retry.
        }
      }, POLL_INTERVAL_MS);
    });
  }
}
