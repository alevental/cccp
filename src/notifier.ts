import { notifyPipelineComplete, notifyGateRequired, log as cmuxLog } from "./tui/cmux.js";

// ---------------------------------------------------------------------------
// Notification event types
// ---------------------------------------------------------------------------

export interface PipelineEvent {
  type: "stage_start" | "stage_complete" | "gate_required" | "pipeline_complete";
  pipeline: string;
  project: string;
  stageName?: string;
  status?: string;
  message?: string;
}

// ---------------------------------------------------------------------------
// Notifier interface
// ---------------------------------------------------------------------------

export interface Notifier {
  notify(event: PipelineEvent): Promise<void>;
}

// ---------------------------------------------------------------------------
// Cmux notifier (default when cmux is available)
// ---------------------------------------------------------------------------

export class CmuxNotifier implements Notifier {
  async notify(event: PipelineEvent): Promise<void> {
    switch (event.type) {
      case "gate_required":
        await notifyGateRequired(event.stageName ?? "unknown");
        break;
      case "pipeline_complete":
        await notifyPipelineComplete(event.pipeline, event.status ?? "unknown");
        break;
      case "stage_complete":
        await cmuxLog(
          `${event.stageName}: ${event.status}`,
          event.status === "passed" ? "success" : "warning",
        );
        break;
    }
  }
}

// ---------------------------------------------------------------------------
// Webhook notifier (for headless/CI mode)
// ---------------------------------------------------------------------------

export class WebhookNotifier implements Notifier {
  constructor(private url: string) {}

  async notify(event: PipelineEvent): Promise<void> {
    try {
      await fetch(this.url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...event,
          timestamp: new Date().toISOString(),
        }),
      });
    } catch (err) {
      // Webhook failures are non-fatal — log and continue.
      console.error(
        `[webhook] Failed to send notification: ${err instanceof Error ? err.message : err}`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Composite notifier (sends to multiple notifiers)
// ---------------------------------------------------------------------------

export class CompositeNotifier implements Notifier {
  constructor(private notifiers: Notifier[]) {}

  async notify(event: PipelineEvent): Promise<void> {
    await Promise.all(this.notifiers.map((n) => n.notify(event)));
  }
}

// ---------------------------------------------------------------------------
// Console notifier (fallback — always available)
// ---------------------------------------------------------------------------

export class ConsoleNotifier implements Notifier {
  async notify(event: PipelineEvent): Promise<void> {
    switch (event.type) {
      case "gate_required":
        console.log(`\n🔔 Gate required: ${event.stageName}\n`);
        break;
      case "pipeline_complete":
        console.log(`\n📋 Pipeline ${event.pipeline}: ${event.status}\n`);
        break;
    }
  }
}
