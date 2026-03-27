import { EventEmitter } from "node:events";

/**
 * Module-level singleton event bus for passing agent activity updates
 * from the runner to the TUI dashboard within the same process.
 *
 * The runner publishes: activityBus.emit("activity", agentActivity)
 * The dashboard subscribes: activityBus.on("activity", handler)
 */
export const activityBus = new EventEmitter();
