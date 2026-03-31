import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { openDatabase } from "../db.js";
import { discoverRuns, loadState, saveState } from "../state.js";
import type { DiscoveredRun } from "../types.js";

// ---------------------------------------------------------------------------
// Gate notifier — polls for pending gates and elicits approval via MCP
// ---------------------------------------------------------------------------

const DEFAULT_POLL_MS = 2000;

export interface GateNotifierOptions {
  server: McpServer;
  projectDir: string;
  pollIntervalMs?: number;
}

/**
 * Watches for pending human gates across all pipeline runs and sends
 * MCP elicitation requests to the connected Claude Code session.
 *
 * Lifecycle: call `start()` after the MCP server connects, `stop()` on shutdown.
 */
export class GateNotifier {
  private seenGates = new Set<string>();
  private elicitationSupported = true;
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private pendingElicitation: Promise<void> | null = null;

  constructor(private opts: GateNotifierOptions) {}

  start(): void {
    if (this.intervalId) return;
    const ms = this.opts.pollIntervalMs ?? DEFAULT_POLL_MS;
    this.intervalId = setInterval(() => void this.poll(), ms);
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  // -------------------------------------------------------------------------
  // Poll loop
  // -------------------------------------------------------------------------

  private async poll(): Promise<void> {
    if (!this.elicitationSupported) return;
    if (this.pendingElicitation) return; // one at a time

    try {
      const db = await openDatabase(this.opts.projectDir);
      db.reload();
      const runs = await discoverRuns(this.opts.projectDir);

      // Clean up seen gates for runs that no longer have a pending gate.
      for (const key of this.seenGates) {
        const [runId] = key.split(":");
        const run = runs.find((r) => r.state.runId === runId);
        if (!run || run.state.gate?.status !== "pending") {
          this.seenGates.delete(key);
        }
      }

      // Find new pending gates.
      for (const run of runs) {
        const gate = run.state.gate;
        if (!gate || gate.status !== "pending") continue;

        const key = this.gateKey(run.state.runId, gate.stageName);
        if (this.seenGates.has(key)) continue;

        // Mark as seen immediately to avoid duplicate elicitations.
        this.seenGates.add(key);
        this.pendingElicitation = this.elicitGateApproval(run);
        // Only process one gate per poll cycle.
        return;
      }
    } catch {
      // DB may be mid-write or unavailable — ignore and retry next cycle.
    }
  }

  // -------------------------------------------------------------------------
  // Elicitation
  // -------------------------------------------------------------------------

  private async elicitGateApproval(run: DiscoveredRun): Promise<void> {
    const gate = run.state.gate!;
    const runShort = run.state.runId.slice(0, 8);

    try {
      const result = await this.opts.server.server.elicitInput({
        message: [
          `Pipeline gate requires approval (run ${runShort}).`,
          "",
          `Stage: ${gate.stageName}`,
          gate.prompt ? `\n${gate.prompt}` : "",
        ]
          .filter(Boolean)
          .join("\n"),
        requestedSchema: {
          type: "object" as const,
          properties: {
            decision: {
              type: "string" as const,
              title: "Decision",
              description: "Approve or reject this gate",
              enum: ["approve", "reject"],
              default: "approve",
            },
            feedback: {
              type: "string" as const,
              title: "Feedback",
              description: "Optional feedback (passed to generator on rejection)",
            },
          },
          required: ["decision"],
        },
      });

      // Handle the elicitation result.
      if (result.action === "cancel") {
        // User dismissed — remove from seen so it can be re-prompted.
        this.seenGates.delete(this.gateKey(run.state.runId, gate.stageName));
        return;
      }

      if (result.action === "decline") {
        // User explicitly declined — write rejection.
        await this.writeGateResponse(run, false);
        return;
      }

      // action === "accept" — check the form content.
      const decision = result.content?.decision as string | undefined;
      const feedback = result.content?.feedback as string | undefined;
      const approved = decision !== "reject";
      await this.writeGateResponse(run, approved, feedback);
    } catch {
      // Elicitation not supported or connection lost.
      this.elicitationSupported = false;
    } finally {
      this.pendingElicitation = null;
    }
  }

  private async writeGateResponse(
    run: DiscoveredRun,
    approved: boolean,
    feedback?: string,
  ): Promise<void> {
    // Reload state to ensure we have the latest (gate may have been resolved externally).
    const freshState = await loadState(run.state.runId, this.opts.projectDir, true);
    if (!freshState?.gate || freshState.gate.status !== "pending") {
      return; // Gate already resolved — discard.
    }

    freshState.gate.status = approved ? "approved" : "rejected";
    freshState.gate.feedback = feedback;
    freshState.gate.respondedAt = new Date().toISOString();
    await saveState(freshState);
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private gateKey(runId: string, stageName: string): string {
    return `${runId}:${stageName}`;
  }
}
