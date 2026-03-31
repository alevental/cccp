import { loadState } from "../state.js";
import type { GateInfo } from "../types.js";
import type { GateResponse, GateStrategy } from "./gate-strategy.js";
import { notifyGateRequired } from "../tui/cmux.js";

// ---------------------------------------------------------------------------
// Filesystem-polling gate strategy
// ---------------------------------------------------------------------------

const POLL_INTERVAL_MS = 2000;

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
  ) {}

  async waitForGate(gate: GateInfo): Promise<GateResponse> {
    await notifyGateRequired(gate.stageName);

    if (!this.quiet) {
      console.log(`    ⏸ Waiting for gate approval: ${gate.stageName}`);
      if (gate.prompt) console.log(`      ${gate.prompt}`);
    }

    return new Promise<GateResponse>((resolve) => {
      const interval = setInterval(async () => {
        try {
          const state = await loadState(this.runId, this.projectDir, true);
          if (!state?.gate) return;

          if (state.gate.stageName !== gate.stageName) return;

          if (state.gate.status === "approved") {
            clearInterval(interval);
            if (!this.quiet) console.log(`    ✓ Gate approved`);
            resolve({
              approved: true,
              feedback: state.gate.feedback,
            });
          } else if (state.gate.status === "rejected") {
            clearInterval(interval);
            if (!this.quiet) {
              console.log(`    ✗ Gate rejected${state.gate.feedback ? `: ${state.gate.feedback}` : ""}`);
            }
            resolve({
              approved: false,
              feedback: state.gate.feedback,
            });
          }
        } catch {
          // State file may be mid-write — ignore and retry.
        }
      }, POLL_INTERVAL_MS);
    });
  }
}
