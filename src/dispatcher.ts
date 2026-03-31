import { dispatchAgent, type DispatchOptions } from "./agent.js";
import type { AgentResult } from "./types.js";

export type { DispatchOptions } from "./agent.js";

export interface AgentDispatcher {
  dispatch(opts: DispatchOptions): Promise<AgentResult>;
}

export class DefaultAgentDispatcher implements AgentDispatcher {
  async dispatch(opts: DispatchOptions): Promise<AgentResult> {
    return dispatchAgent(opts);
  }
}
