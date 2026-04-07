import { dispatchAgent, type DispatchOptions } from "./agent.js";
import type { AgentResult } from "./types.js";
import type { AgentPaneManager } from "./tui/agent-panes.js";

export type { DispatchOptions } from "./agent.js";

export interface AgentDispatcher {
  dispatch(opts: DispatchOptions): Promise<AgentResult>;
}

export class DefaultAgentDispatcher implements AgentDispatcher {
  async dispatch(opts: DispatchOptions): Promise<AgentResult> {
    return dispatchAgent(opts);
  }
}

/**
 * Decorator that opens/closes a cmux monitor pane around each agent dispatch.
 * Wraps any inner AgentDispatcher.
 */
export class PaneAwareDispatcher implements AgentDispatcher {
  constructor(
    private inner: AgentDispatcher,
    private panes: AgentPaneManager,
  ) {}

  async dispatch(opts: DispatchOptions): Promise<AgentResult> {
    const agentName = opts.agentName ?? "agent";
    const logPath =
      opts.streamLogDir ? `${opts.streamLogDir}/${agentName}.stream.jsonl` : undefined;

    if (logPath) {
      await this.panes.openPane(agentName, logPath);
    }
    try {
      return await this.inner.dispatch(opts);
    } finally {
      if (logPath) {
        // Fire-and-forget — don't block on pane close.
        this.panes.closePane(agentName).catch(() => {});
      }
    }
  }
}
