import type { GateInfo } from "../state.js";

// ---------------------------------------------------------------------------
// Gate response
// ---------------------------------------------------------------------------

export interface GateResponse {
  approved: boolean;
  feedback?: string;
}

// ---------------------------------------------------------------------------
// Strategy interface
// ---------------------------------------------------------------------------

/**
 * A gate strategy determines how human gates are presented and how responses
 * are collected. Implementations:
 * - `McpGateStrategy`: Writes gate_pending to state.json, waits for external
 *   response (via MCP server or direct state file edit).
 * - `AutoApproveStrategy`: Immediately approves all gates (headless mode).
 */
export interface GateStrategy {
  /**
   * Wait for a human gate response.
   * The strategy is responsible for:
   * 1. Signaling that a gate is pending (e.g., writing to state.json)
   * 2. Waiting for a response
   * 3. Returning the response
   */
  waitForGate(gate: GateInfo): Promise<GateResponse>;
}
