import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { openDatabase } from "../db.js";
import { writeFeedbackArtifact } from "../gate/feedback-artifact.js";
import { discoverRuns, loadState, saveState, setStageArtifact } from "../state.js";
import type { DiscoveredRun } from "../types.js";

// ---------------------------------------------------------------------------
// Gate notifier — polls for pending gates and notifies via MCP
//
// Notification tiers (tried in order):
//   1. Channel notification (push-based, experimental)
//   2. Elicitation form (interactive, may not be supported)
//   3. Fallback: user discovers via cccp_status / cccp_gate_respond tools
// ---------------------------------------------------------------------------

const DEFAULT_POLL_MS = 2000;

export interface GateNotifierOptions {
  server: McpServer;
  projectDir: string;
  /** Session ID for this MCP server instance. Used to filter gate notifications. */
  sessionId?: string;
  pollIntervalMs?: number;
}

/**
 * Watches for pending human gates across all pipeline runs and sends
 * MCP notifications to the connected Claude Code session.
 *
 * Uses channels as primary notification (push), with elicitation as fallback.
 *
 * Lifecycle: call `start()` after the MCP server connects, `stop()` on shutdown.
 */
export class GateNotifier {
  private seenGates = new Set<string>();
  /** Tracks run statuses to detect completion transitions. */
  private lastRunStatus = new Map<string, string>();
  private channelSupported: boolean | null = null; // null = not yet tested
  private elicitationSupported = true;
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private pendingNotification: Promise<void> | null = null;

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
    // If both notification mechanisms are disabled, stop polling.
    if (this.channelSupported === false && !this.elicitationSupported) return;
    if (this.pendingNotification) return; // one at a time

    try {
      const db = await openDatabase(this.opts.projectDir);
      db.reload();
      const runs = await discoverRuns(this.opts.projectDir);

      // Detect pipeline completion transitions and send channel notifications.
      for (const run of runs) {
        // Session affinity: skip runs belonging to other MCP sessions.
        if (
          this.opts.sessionId &&
          run.state.sessionId &&
          run.state.sessionId !== this.opts.sessionId
        ) {
          continue;
        }

        const prevStatus = this.lastRunStatus.get(run.state.runId);
        this.lastRunStatus.set(run.state.runId, run.state.status);

        const isTerminal = run.state.status === "passed" || run.state.status === "failed" || run.state.status === "error";
        if (isTerminal && prevStatus && prevStatus !== run.state.status) {
          // Pipeline just completed — send notification (fire-and-forget).
          void this.sendPipelineCompleteNotification(run);
        }
      }

      // Clean up seen gates for runs that no longer have a pending gate.
      for (const key of this.seenGates) {
        const [runId] = key.split(":");
        const run = runs.find((r) => r.state.runId === runId);
        if (!run || run.state.gate?.status !== "pending") {
          this.seenGates.delete(key);
        }
      }

      // Find new pending gates (filtered by session affinity).
      for (const run of runs) {
        const gate = run.state.gate;
        if (!gate || gate.status !== "pending") continue;

        // Session affinity: skip gates belonging to other MCP sessions.
        if (
          this.opts.sessionId &&
          run.state.sessionId &&
          run.state.sessionId !== this.opts.sessionId
        ) {
          continue;
        }

        const key = this.gateKey(run.state.runId, gate.stageName);
        if (this.seenGates.has(key)) continue;

        // Mark as seen immediately to avoid duplicate notifications.
        this.seenGates.add(key);
        this.pendingNotification = this.notifyGate(run);
        // Only process one gate per poll cycle.
        return;
      }
    } catch {
      // DB may be mid-write or unavailable — ignore and retry next cycle.
    }
  }

  // -------------------------------------------------------------------------
  // Notification dispatch (channel → elicitation → silent fallback)
  // -------------------------------------------------------------------------

  private async notifyGate(run: DiscoveredRun): Promise<void> {
    const gate = run.state.gate!;
    const gateKey = this.gateKey(run.state.runId, gate.stageName);

    try {
      // Tier 1: Try channel notification (non-blocking push).
      if (this.channelSupported !== false) {
        const sent = await this.sendChannelNotification(run);
        if (sent) return; // Channel delivered — no need for elicitation.
      }

      // Tier 2: Fall back to elicitation (blocking form).
      if (this.elicitationSupported) {
        await this.elicitGateApproval(run);
        return;
      }

      // Tier 3: Both unavailable. User will discover via cccp_status / cccp_gate_respond.
    } catch {
      // Transient error — remove from seen so it can retry.
      this.seenGates.delete(gateKey);
    } finally {
      this.pendingNotification = null;
    }
  }

  // -------------------------------------------------------------------------
  // Tier 1: Channel notification
  // -------------------------------------------------------------------------

  private async sendChannelNotification(run: DiscoveredRun): Promise<boolean> {
    const gate = run.state.gate!;
    const runShort = run.state.runId.slice(0, 8);

    try {
      // Channel notifications use an experimental protocol method.
      // The SDK types don't include this notification type, so we cast through unknown.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const notificationFn = (this.opts.server.server as any).notification as
        | ((msg: unknown) => Promise<void>)
        | undefined;

      if (!notificationFn) {
        this.channelSupported = false;
        return false;
      }

      await notificationFn.call(this.opts.server.server, {
        method: "notifications/claude/channel",
        params: {
          content: [
            `Pipeline gate "${gate.stageName}" requires your review (run ${runShort}).`,
            gate.prompt ? `\n${gate.prompt}` : "",
            `\nUse cccp_gate_review to see full context, discuss with the user, then respond via cccp_gate_respond.`,
          ]
            .filter(Boolean)
            .join("\n"),
          meta: {
            severity: "high",
            type: "gate_pending",
            run_id: runShort,
            stage: gate.stageName,
          },
        },
      });

      if (this.channelSupported === null) {
        this.channelSupported = true;
      }
      return true;
    } catch {
      // Channel not supported — disable and fall through to elicitation.
      this.channelSupported = false;
      return false;
    }
  }

  // -------------------------------------------------------------------------
  // Pipeline completion notification
  // -------------------------------------------------------------------------

  private async sendPipelineCompleteNotification(run: DiscoveredRun): Promise<void> {
    if (this.channelSupported === false) return;

    const runShort = run.state.runId.slice(0, 8);
    const status = run.state.status;
    const emoji = status === "passed" ? "\u2714" : "\u2717";
    const duration = run.state.startedAt && run.state.completedAt
      ? ` in ${formatDurationMs(new Date(run.state.completedAt).getTime() - new Date(run.state.startedAt).getTime())}`
      : "";

    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const notificationFn = (this.opts.server.server as any).notification as
        | ((msg: unknown) => Promise<void>)
        | undefined;

      if (!notificationFn) {
        this.channelSupported = false;
        return;
      }

      await notificationFn.call(this.opts.server.server, {
        method: "notifications/claude/channel",
        params: {
          content: `${emoji} Pipeline "${run.state.pipeline}" ${status}${duration} (run ${runShort}).`,
          meta: {
            severity: status === "passed" ? "info" : "high",
            type: "pipeline_complete",
            run_id: runShort,
            status,
          },
        },
      });

      if (this.channelSupported === null) {
        this.channelSupported = true;
      }
    } catch {
      this.channelSupported = false;
    }
  }

  // -------------------------------------------------------------------------
  // Tier 2: Elicitation form
  // -------------------------------------------------------------------------

  private async elicitGateApproval(run: DiscoveredRun): Promise<void> {
    const gate = run.state.gate!;
    const runShort = run.state.runId.slice(0, 8);

    let result;
    try {
      result = await this.opts.server.server.elicitInput({
        message: [
          `Pipeline gate requires approval (run ${runShort}).`,
          "",
          `Stage: ${gate.stageName}`,
          gate.prompt ? `\n${gate.prompt}` : "",
          "",
          `Reject with feedback to retry the generation cycle with your guidance.`,
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
              description: "Optional feedback (on rejection, triggers retry with your feedback)",
            },
          },
          required: ["decision"],
        },
      });
    } catch {
      // Elicitation not supported by this client — disable for the session.
      this.elicitationSupported = false;
      return;
    }

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
  }

  // -------------------------------------------------------------------------
  // State writes
  // -------------------------------------------------------------------------

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

    // Write feedback as a numbered artifact file.
    if (feedback) {
      const feedbackPath = await writeFeedbackArtifact(
        run.artifactDir, freshState.gate.stageName, feedback, approved,
      );
      freshState.gate.feedbackPath = feedbackPath;
      setStageArtifact(freshState, freshState.gate.stageName, "gate-feedback", feedbackPath);
    }

    await saveState(freshState);
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private gateKey(runId: string, stageName: string): string {
    return `${runId}:${stageName}`;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatDurationMs(ms: number): string {
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ${secs % 60}s`;
  const hrs = Math.floor(mins / 60);
  return `${hrs}h ${mins % 60}m`;
}
