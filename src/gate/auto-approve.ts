import type { GateInfo } from "../state.js";
import type { GateResponse, GateStrategy } from "./gate-strategy.js";

/**
 * Gate strategy that automatically approves all gates.
 * Used in headless/CI mode where no human is available.
 */
export class AutoApproveStrategy implements GateStrategy {
  async waitForGate(gate: GateInfo): Promise<GateResponse> {
    console.log(`    ⏭ Auto-approving gate: ${gate.stageName}`);
    return { approved: true };
  }
}
