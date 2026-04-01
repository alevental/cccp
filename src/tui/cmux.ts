import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

// ---------------------------------------------------------------------------
// cmux detection
// ---------------------------------------------------------------------------

/** Returns true if running inside a cmux workspace. */
export function isCmuxAvailable(): boolean {
  return !!process.env.CMUX_WORKSPACE_ID;
}

// ---------------------------------------------------------------------------
// cmux commands
// ---------------------------------------------------------------------------

async function cmux(...args: string[]): Promise<string> {
  if (!isCmuxAvailable()) return "";
  try {
    const { stdout } = await exec("cmux", args);
    return stdout.trim();
  } catch {
    // cmux command failed — not critical, just skip.
    return "";
  }
}

/** Set the sidebar status pill. */
export async function setStatus(label: string): Promise<void> {
  await cmux("set-status", "cccp", label);
}

/** Set the progress bar (0.0–1.0). */
export async function setProgress(fraction: number): Promise<void> {
  await cmux("set-progress", String(Math.max(0, Math.min(1, fraction))));
}

/** Write a structured log entry. */
export async function log(
  message: string,
  level: "info" | "success" | "warning" | "error" = "info",
): Promise<void> {
  await cmux("log", "--level", level, message);
}

/** Send a desktop notification. */
export async function notify(
  title: string,
  body?: string,
): Promise<void> {
  const args = ["notify", "--title", title];
  if (body) args.push("--body", body);
  await cmux(...args);
}

/** Open a new split pane and return the surface ref (e.g., "surface:10"). */
export async function newSplit(
  direction: "right" | "below" = "right",
): Promise<string> {
  const output = await cmux("new-split", direction);
  // Parse "OK surface:N workspace:M" → "surface:N"
  const match = output.match(/surface:\d+/);
  return match?.[0] ?? "";
}

/** Send text to a surface (does NOT press Enter). */
export async function sendText(
  surfaceRef: string,
  text: string,
): Promise<void> {
  await cmux("send", "--surface", surfaceRef, text);
}

/** Send a key press to a surface (e.g., "Enter", "Tab"). */
export async function sendKey(
  surfaceRef: string,
  key: string,
): Promise<void> {
  await cmux("send-key", "--surface", surfaceRef, key);
}

// ---------------------------------------------------------------------------
// High-level helpers for pipeline events
// ---------------------------------------------------------------------------

/** Update cmux with current pipeline stage progress. */
export async function updatePipelineStatus(
  stageName: string,
  stageIndex: number,
  totalStages: number,
): Promise<void> {
  if (!isCmuxAvailable()) return;
  await setStatus(`${stageName} (${stageIndex + 1}/${totalStages})`);
  await setProgress((stageIndex + 1) / totalStages);
}

/** Notify that a human gate requires attention. */
export async function notifyGateRequired(stageName: string): Promise<void> {
  if (!isCmuxAvailable()) return;
  await notify("Gate Required", `Pipeline waiting for approval: ${stageName}`);
}

/** Notify that the pipeline has completed. */
export async function notifyPipelineComplete(
  pipelineName: string,
  status: string,
): Promise<void> {
  if (!isCmuxAvailable()) return;
  await notify("Pipeline Complete", `${pipelineName}: ${status}`);
}
