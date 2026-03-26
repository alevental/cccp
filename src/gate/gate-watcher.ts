import { loadState } from "../state.js";
import type { GateInfo } from "../state.js";
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
  constructor(private artifactDir: string) {}

  async waitForGate(gate: GateInfo): Promise<GateResponse> {
    // Notify via cmux that a gate requires attention.
    await notifyGateRequired(gate.stageName);

    console.log(
      `    ⏸ Waiting for gate approval: ${gate.stageName}`,
    );
    if (gate.prompt) {
      console.log(`      ${gate.prompt}`);
    }

    // Poll state.json until gate.status changes from "pending".
    return new Promise<GateResponse>((resolve) => {
      const interval = setInterval(async () => {
        try {
          const state = await loadState(this.artifactDir);
          if (!state?.gate) return;

          if (state.gate.stageName !== gate.stageName) return;

          if (state.gate.status === "approved") {
            clearInterval(interval);
            console.log(`    ✓ Gate approved`);
            resolve({
              approved: true,
              feedback: state.gate.feedback,
            });
          } else if (state.gate.status === "rejected") {
            clearInterval(interval);
            console.log(
              `    ✗ Gate rejected${state.gate.feedback ? `: ${state.gate.feedback}` : ""}`,
            );
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
