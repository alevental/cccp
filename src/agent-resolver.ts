import { access, readdir, stat } from "node:fs/promises";
import { resolve, join, extname, basename, dirname } from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ResolvedAgent {
  /** Absolute path to the agent's main markdown file. */
  agentPath: string;
  /** Absolute path to the operation file (if applicable). */
  operationPath?: string;
  /** Whether this is a directory-style agent. */
  isDirectory: boolean;
}

// ---------------------------------------------------------------------------
// Resolution logic
// ---------------------------------------------------------------------------

/**
 * Resolve an agent name to file path(s) by searching configured directories.
 *
 * Search order (first match wins):
 * 1. Each directory in `searchPaths`, in order
 *
 * For each search directory, tries:
 * - `<dir>/<agent>.md` — flat-file agent
 * - `<dir>/<agent>/agent.md` — directory-style agent
 *
 * If an `operation` is specified and the agent is directory-style:
 * - Also resolves `<dir>/<agent>/<operation>.md`
 *
 * If the agent name already ends in `.md` or contains a path separator,
 * it's treated as a direct path (absolute or relative to projectDir).
 */
export async function resolveAgent(
  agentName: string,
  searchPaths: string[],
  operation?: string,
  projectDir?: string,
): Promise<ResolvedAgent> {
  // Direct path — skip search if agent looks like a path.
  if (agentName.includes("/") || agentName.endsWith(".md")) {
    return resolveDirectPath(agentName, operation, projectDir);
  }

  // Search configured paths.
  for (const searchDir of searchPaths) {
    // Try flat file: <dir>/<agent>.md
    const flatPath = join(searchDir, `${agentName}.md`);
    if (await fileExists(flatPath)) {
      if (operation) {
        // Flat file agents don't have operations — check if there's a
        // sibling directory with the operation file.
        const opPath = join(searchDir, agentName, `${operation}.md`);
        if (await fileExists(opPath)) {
          // There's actually a directory-style agent alongside the flat file.
          const dirAgentPath = join(searchDir, agentName, "agent.md");
          if (await fileExists(dirAgentPath)) {
            return {
              agentPath: dirAgentPath,
              operationPath: opPath,
              isDirectory: true,
            };
          }
        }
        throw new Error(
          `Agent "${agentName}" is a flat file and does not support operation "${operation}"`,
        );
      }
      return { agentPath: flatPath, isDirectory: false };
    }

    // Try directory: <dir>/<agent>/agent.md
    const dirAgentPath = join(searchDir, agentName, "agent.md");
    if (await fileExists(dirAgentPath)) {
      let operationPath: string | undefined;
      if (operation) {
        operationPath = join(searchDir, agentName, `${operation}.md`);
        if (!(await fileExists(operationPath))) {
          throw new Error(
            `Operation "${operation}" not found for agent "${agentName}" at: ${operationPath}`,
          );
        }
      }
      return {
        agentPath: dirAgentPath,
        operationPath,
        isDirectory: true,
      };
    }
  }

  const searched = searchPaths.map((p) => `  - ${p}`).join("\n");
  throw new Error(
    `Agent "${agentName}" not found. Searched:\n${searched}`,
  );
}

/**
 * List all available operations for a directory-style agent.
 */
export async function listOperations(
  agentName: string,
  searchPaths: string[],
): Promise<string[]> {
  for (const searchDir of searchPaths) {
    const agentDir = join(searchDir, agentName);
    try {
      const entries = await readdir(agentDir);
      return entries
        .filter((e) => e.endsWith(".md") && e !== "agent.md")
        .map((e) => e.replace(/\.md$/, ""));
    } catch {
      continue;
    }
  }
  return [];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function resolveDirectPath(
  agentPath: string,
  operation?: string,
  projectDir?: string,
): Promise<ResolvedAgent> {
  const absPath = projectDir
    ? resolve(projectDir, agentPath)
    : resolve(agentPath);

  if (!(await fileExists(absPath))) {
    throw new Error(`Agent file not found: ${absPath}`);
  }

  // Check if it's a directory-style agent (path ends with agent.md).
  const isDir = basename(absPath) === "agent.md";

  let operationPath: string | undefined;
  if (operation) {
    if (!isDir) {
      throw new Error(
        `Agent at "${absPath}" is a flat file and does not support operation "${operation}"`,
      );
    }
    operationPath = resolve(dirname(absPath), `${operation}.md`);
    if (!(await fileExists(operationPath))) {
      throw new Error(
        `Operation "${operation}" not found at: ${operationPath}`,
      );
    }
  }

  return { agentPath: absPath, operationPath, isDirectory: isDir };
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
