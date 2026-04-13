import { execFile } from "node:child_process";
import { basename } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

// ---------------------------------------------------------------------------
// GitInfo — snapshot of git repository state
// ---------------------------------------------------------------------------

export interface GitInfo {
  /** Current branch name, or "(detached)" if in detached HEAD state. */
  branch: string;
  /** Short HEAD commit hash (7 chars). */
  hash: string;
  /** True if the working tree has uncommitted changes. */
  dirty: boolean;
  /** Commits ahead of upstream tracking branch. 0 if no tracking branch. */
  ahead: number;
  /** Commits behind upstream tracking branch. 0 if no tracking branch. */
  behind: number;
  /** Basename of the git root directory. */
  repoName: string;
  /** True if this is a linked worktree (not the main working tree). */
  isWorktree: boolean;
}

// ---------------------------------------------------------------------------
// Git query helpers
// ---------------------------------------------------------------------------

const TIMEOUT_MS = 3000;

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await exec("git", ["-C", cwd, ...args], { timeout: TIMEOUT_MS });
  return stdout.trim();
}

// ---------------------------------------------------------------------------
// getGitInfo — one-shot snapshot, returns null if not a git repo
// ---------------------------------------------------------------------------

export async function getGitInfo(cwd: string): Promise<GitInfo | null> {
  try {
    // Confirm this is a git repo and detect worktree status.
    const gitDir = await git(cwd, "rev-parse", "--git-dir");
    const isWorktree = gitDir.includes("/worktrees/");

    // Run remaining queries in parallel.
    const [hash, branch, porcelain, toplevel, aheadBehind] = await Promise.all([
      git(cwd, "rev-parse", "--short", "HEAD"),
      git(cwd, "symbolic-ref", "--short", "HEAD").catch(() => "(detached)"),
      git(cwd, "status", "--porcelain"),
      git(cwd, "rev-parse", "--show-toplevel"),
      git(cwd, "rev-list", "--left-right", "--count", "HEAD...@{u}")
        .then((out) => {
          const [ahead, behind] = out.split(/\s+/).map(Number);
          return { ahead: ahead || 0, behind: behind || 0 };
        })
        .catch(() => ({ ahead: 0, behind: 0 })),
    ]);

    return {
      branch,
      hash,
      dirty: porcelain.length > 0,
      ahead: aheadBehind.ahead,
      behind: aheadBehind.behind,
      repoName: basename(toplevel),
      isWorktree,
    };
  } catch {
    return null;
  }
}
