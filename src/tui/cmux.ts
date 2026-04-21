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

/** Cmux workspace/surface/pane identifiers read from the runtime env. */
export interface CmuxContext {
  workspace?: string;
  surface?: string;
  pane?: string;
}

/**
 * Read the current cmux workspace/surface/pane from env vars. Any field can
 * be absent (e.g., if the process isn't running inside cmux); callers should
 * treat missing values as "use the orchestrator's default".
 */
export function getCurrentCmuxContext(): CmuxContext {
  return {
    workspace: process.env.CMUX_WORKSPACE_ID,
    surface: process.env.CMUX_SURFACE_ID ?? process.env.CMUX_SURFACE,
    pane: process.env.CMUX_PANE_ID ?? process.env.CMUX_PANE,
  };
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
  direction: "right" | "down" = "right",
  fromSurface?: string,
): Promise<string> {
  const args = ["new-split", direction];
  if (fromSurface) args.push("--surface", fromSurface);
  const output = await cmux(...args);
  // Parse "OK surface:N workspace:M" → "surface:N"
  const match = output.match(/surface:\d+/);
  return match?.[0] ?? "";
}

/** Close a cmux surface. */
export async function closeSurface(surfaceRef: string): Promise<void> {
  await cmux("close-surface", "--surface", surfaceRef);
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
// CLI command resolution
// ---------------------------------------------------------------------------

/**
 * Returns the CLI command prefix for spawning cccp subcommands in external
 * shells (cmux panes). When running in dev mode via tsx, resolves to
 * `npx --yes tsx <abs-path>/src/cli.ts`; otherwise `npx --yes @alevental/cccp@latest`.
 */
export function getCccpCliPrefix(): string {
  const entry = process.argv[1] ?? "";
  if (entry.endsWith("/src/cli.ts")) {
    const projectRoot = entry.replace(/\/src\/cli\.ts$/, "");
    return `npx --yes tsx "${projectRoot}/src/cli.ts"`;
  }
  return "npx --yes @alevental/cccp@latest";
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

/**
 * Open a cmux split pane below and launch a scoped dashboard for a sub-pipeline stage.
 * The pane auto-closes when the dashboard exits (via chained close-surface command).
 * Returns the surface ref, or empty string if cmux is not available.
 */
export async function launchScopedDashboard(
  runId: string,
  projectDir: string,
  scopeStage: string,
): Promise<string> {
  if (!isCmuxAvailable()) return "";
  const surfaceRef = await newSplit("down");
  if (!surfaceRef) return "";
  const prefix = runId.slice(0, 12);
  const cli = getCccpCliPrefix();
  const cmd = `${cli} dashboard -r "${prefix}" -d "${projectDir}" --scope "${scopeStage}" ; cmux close-surface --surface ${surfaceRef}`;
  await sendText(surfaceRef, cmd);
  await sendKey(surfaceRef, "Enter");
  return surfaceRef;
}

/** Notify that the pipeline has been paused. */
export async function notifyPipelinePaused(
  pipelineName: string,
): Promise<void> {
  if (!isCmuxAvailable()) return;
  await notify("Pipeline Paused", `${pipelineName}: paused at clean breakpoint`);
}

/** Notify that the pipeline has completed. */
export async function notifyPipelineComplete(
  pipelineName: string,
  status: string,
): Promise<void> {
  if (!isCmuxAvailable()) return;
  await notify("Pipeline Complete", `${pipelineName}: ${status}`);
}
