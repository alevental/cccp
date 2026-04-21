import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { openDatabase } from "../db.js";
import { writeFeedbackArtifact } from "../gate/feedback-artifact.js";
import { discoverRuns, loadState, saveState, setStageArtifact } from "../state.js";
import type { DiscoveredRun } from "../types.js";
import type { DbService } from "../db-service.js";

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
  /** Centralized database service for reload + WASM reclaim.
   *  When omitted, falls back to direct openDatabase() + reload() with no WASM reclaim. */
  dbService?: DbService;
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
    this.seenGates.clear();
    this.lastRunStatus.clear();
  }

  // -------------------------------------------------------------------------
  // Poll loop
  // -------------------------------------------------------------------------

  private async poll(): Promise<void> {
    // If both notification mechanisms are disabled, stop polling.
    if (this.channelSupported === false && !this.elicitationSupported) return;
    if (this.pendingNotification) return; // one at a time

    try {
      // Reload DB from disk before reading runs.
      if (this.opts.dbService) {
        await this.opts.dbService.db();
      } else {
        const db = await openDatabase(this.opts.projectDir);
        db.reload();
      }
      const runs = await discoverRuns(this.opts.projectDir);

      // Prune lastRunStatus for runs no longer returned by discoverRuns.
      const currentRunIds = new Set(runs.map((r) => r.state.runId));
      for (const runId of this.lastRunStatus.keys()) {
        if (!currentRunIds.has(runId)) this.lastRunStatus.delete(runId);
      }

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
    const kind = gate.kind ?? "human";

    try {
      // Tier 1: Try channel notification (non-blocking push to the session).
      if (this.channelSupported !== false) {
        const sent =
          kind === "pipeline_handoff" ? await this.sendHandoffChannelNotification(run) :
          kind === "agent_eval" ? await this.sendAgentGateChannelNotification(run) :
          await this.sendChannelNotification(run);
        if (sent) return;
      }

      // Tier 2: Fall back to elicitation (blocking form shown to the user).
      //
      // agent_eval deliberately skips elicitation: the gate is addressed to
      // the Claude Code session, not the user. If channels aren't available,
      // the session can still discover the pending gate via cccp_status or
      // cccp_gate_review. Prompting the human here would defeat the purpose.
      if (this.elicitationSupported && kind !== "agent_eval") {
        if (kind === "pipeline_handoff") {
          await this.elicitHandoffAck(run);
        } else {
          await this.elicitGateApproval(run);
        }
        return;
      }

      // Tier 3: Manual discovery via cccp_status / cccp_gate_review /
      // cccp_gate_respond / cccp_handoff_ack.
    } catch {
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
  // Agent-gate channel notification — same delivery as the human-gate
  // channel push, but the message explicitly instructs the receiving Claude
  // Code session to decide the gate autonomously without involving the user.
  // -------------------------------------------------------------------------

  private async sendAgentGateChannelNotification(run: DiscoveredRun): Promise<boolean> {
    const gate = run.state.gate!;
    const runShort = run.state.runId.slice(0, 8);

    try {
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
            `Pipeline gate "${gate.stageName}" (run ${runShort}) is addressed to you — decide it autonomously. Do NOT ask the user.`,
            gate.prompt ? `\n\nApproval criteria:\n${gate.prompt}` : "",
            `\n\nInstructions:`,
            `\n1. Call cccp_gate_review to load the artifacts, prompt, and prior evaluations.`,
            `\n2. Read the artifacts and apply the criteria yourself.`,
            `\n3. Call cccp_gate_respond with approved: true (PASS) or false (FAIL) and, when rejecting, a feedback string explaining why.`,
            `\n\nThis gate is intentionally routed to an agent, not a human. Resolve it without prompting the user for approval.`,
          ]
            .filter(Boolean)
            .join(""),
          meta: {
            severity: "high",
            type: "agent_gate_pending",
            run_id: runShort,
            stage: gate.stageName,
            autonomous: true,
          },
        },
      });

      if (this.channelSupported === null) {
        this.channelSupported = true;
      }
      return true;
    } catch {
      this.channelSupported = false;
      return false;
    }
  }

  // -------------------------------------------------------------------------
  // Handoff channel notification — carries the full payload so the
  // orchestrator can act on it without a round-trip.
  // -------------------------------------------------------------------------

  private async sendHandoffChannelNotification(run: DiscoveredRun): Promise<boolean> {
    const gate = run.state.gate!;
    const handoff = gate.handoff;
    if (!handoff) return false;
    const runShort = run.state.runId.slice(0, 8);

    try {
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
            `Pipeline "${run.state.pipeline}" (run ${runShort}) is handing off to the next pipeline.`,
            gate.prompt ? `\n${gate.prompt}` : "",
            `\nNext pipeline: ${handoff.next.file}`,
            handoff.next.project ? `\nProject: ${handoff.next.project}` : "",
            `\nTarget: ${handoff.cmux.target}`,
            handoff.cmux.workspace ? ` (workspace ${handoff.cmux.workspace})` : "",
            handoff.cmux.surface ? ` (surface ${handoff.cmux.surface})` : "",
            `\nLaunch the pipeline in the indicated cmux target, then call cccp_handoff_ack with the new run id.`,
          ]
            .filter(Boolean)
            .join(""),
          meta: {
            severity: "high",
            type: "pipeline_handoff",
            run_id: runShort,
            stage: gate.stageName,
            next: handoff.next,
            cmux: handoff.cmux,
          },
        },
      });

      if (this.channelSupported === null) {
        this.channelSupported = true;
      }
      return true;
    } catch {
      this.channelSupported = false;
      return false;
    }
  }

  // -------------------------------------------------------------------------
  // Handoff elicitation fallback — collects the launched run id and target
  // pane from the orchestrator. Unlike human gates, this form does not have
  // a reject path; cancel leaves the gate pending for retry.
  // -------------------------------------------------------------------------

  private async elicitHandoffAck(run: DiscoveredRun): Promise<void> {
    const gate = run.state.gate!;
    const handoff = gate.handoff;
    if (!handoff) return;
    const runShort = run.state.runId.slice(0, 8);

    let result;
    try {
      result = await this.opts.server.server.elicitInput({
        message: [
          `Pipeline handoff requested (run ${runShort}).`,
          "",
          `Stage: ${gate.stageName}`,
          gate.prompt ? `\n${gate.prompt}` : "",
          "",
          `Next pipeline: ${handoff.next.file}`,
          handoff.next.project ? `Project: ${handoff.next.project}` : "",
          `Cmux target: ${handoff.cmux.target}`,
          "",
          `Launch the pipeline in the indicated cmux target, then fill in the new run id below to acknowledge.`,
        ]
          .filter(Boolean)
          .join("\n"),
        requestedSchema: {
          type: "object" as const,
          properties: {
            launched_run_id: {
              type: "string" as const,
              title: "Launched run ID",
              description: "Run id of the pipeline you just launched (or leave blank if you couldn't launch it).",
            },
            target_pane: {
              type: "string" as const,
              title: "Target pane",
              description: "cmux pane/surface the new pipeline is running in.",
            },
            note: {
              type: "string" as const,
              title: "Note",
              description: "Optional freeform note.",
            },
          },
          required: [],
        },
      });
    } catch {
      this.elicitationSupported = false;
      return;
    }

    if (result.action === "cancel") {
      this.seenGates.delete(this.gateKey(run.state.runId, gate.stageName));
      return;
    }

    const launchedRunId = result.content?.launched_run_id as string | undefined;
    const targetPane = result.content?.target_pane as string | undefined;
    const note = result.content?.note as string | undefined;
    await this.writeHandoffAck(run, launchedRunId, targetPane, note);
  }

  private async writeHandoffAck(
    run: DiscoveredRun,
    launchedRunId: string | undefined,
    targetPane: string | undefined,
    note: string | undefined,
  ): Promise<void> {
    const freshState = await loadState(run.state.runId, this.opts.projectDir, true);
    if (!freshState?.gate || freshState.gate.status !== "pending") {
      return;
    }
    if (freshState.gate.kind !== "pipeline_handoff" || !freshState.gate.handoff) {
      return;
    }

    freshState.gate.handoff.launchedRunId = launchedRunId || undefined;
    freshState.gate.handoff.targetPane = targetPane || undefined;
    freshState.gate.status = "approved";
    freshState.gate.feedback = note || undefined;
    freshState.gate.respondedAt = new Date().toISOString();

    if (note) {
      const feedbackPath = await writeFeedbackArtifact(
        run.artifactDir, freshState.gate.stageName, note, true,
      );
      freshState.gate.feedbackPath = feedbackPath;
      setStageArtifact(freshState, freshState.gate.stageName, "gate-feedback", feedbackPath);
    }
    if (launchedRunId) {
      setStageArtifact(freshState, freshState.gate.stageName, "handoff-launched-run", launchedRunId);
    }
    if (targetPane) {
      setStageArtifact(freshState, freshState.gate.stageName, "handoff-target-pane", targetPane);
    }

    await saveState(freshState);
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
