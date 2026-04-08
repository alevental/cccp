import { isCmuxAvailable, newSplit, sendText, sendKey, closeSurface, getCccpCliPrefix } from "./cmux.js";

/**
 * Manages cmux panes for per-agent monitor views.
 *
 * Layout: first active agent splits right from the primary pane.
 * Subsequent agents split down from the last agent pane, stacking vertically.
 * When all agent panes close, the next agent triggers a fresh split-right.
 */
export class AgentPaneManager {
  /** agentName → surface ref */
  private activeSurfaces = new Map<string, string>();
  /** The most recently opened surface (used as split target for stacking). */
  private lastSurface: string | null = null;
  /** Serialises pane creation so parallel dispatches stack correctly. */
  private openQueue: Promise<void> = Promise.resolve();

  constructor(private projectDir: string) {}

  /**
   * Open a cmux pane for an agent and launch the agent-monitor TUI inside it.
   * No-op if cmux is unavailable. Serialised via queue so concurrent calls
   * from parallel dispatches stack vertically instead of all splitting right.
   */
  async openPane(agentName: string, streamLogPath: string): Promise<void> {
    if (!isCmuxAvailable()) return;
    this.openQueue = this.openQueue.then(() => this._openPane(agentName, streamLogPath));
    return this.openQueue;
  }

  private async _openPane(agentName: string, streamLogPath: string): Promise<void> {
    // First active agent → split right from primary pane.
    // Subsequent → split down from the last agent pane.
    const direction = this.activeSurfaces.size === 0 ? "right" : "down";
    const fromSurface = direction === "down" ? this.lastSurface ?? undefined : undefined;

    const surfaceRef = await newSplit(direction, fromSurface);
    if (!surfaceRef) return;

    this.activeSurfaces.set(agentName, surfaceRef);
    this.lastSurface = surfaceRef;

    // Launch agent-monitor in the pane. Chain close-surface for auto-cleanup.
    const cli = getCccpCliPrefix();
    const cmd = `${cli} agent-monitor --stream-log "${streamLogPath}" ; cmux close-surface --surface ${surfaceRef}`;
    await sendText(surfaceRef, cmd);
    await sendKey(surfaceRef, "Enter");
  }

  /**
   * Close the cmux pane for a completed agent.
   * The pane will auto-close via the chained close-surface command when the
   * monitor process exits, but we also close it explicitly as a safety net.
   */
  async closePane(agentName: string): Promise<void> {
    const surfaceRef = this.activeSurfaces.get(agentName);
    if (!surfaceRef) return;

    this.activeSurfaces.delete(agentName);

    // Update lastSurface to the most recent remaining surface, or null.
    if (this.lastSurface === surfaceRef) {
      const remaining = [...this.activeSurfaces.values()];
      this.lastSurface = remaining.length > 0 ? remaining[remaining.length - 1] : null;
    }

    // Fire-and-forget — the chained command likely already closed it.
    closeSurface(surfaceRef).catch(() => {});
  }
}
