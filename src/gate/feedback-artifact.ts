import { readdir, writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";

// ---------------------------------------------------------------------------
// Gate feedback artifact writer
// ---------------------------------------------------------------------------

/**
 * Write gate feedback as a numbered markdown artifact file.
 *
 * Files are written to `{artifactDir}/.cccp/{stageName}-gate-feedback-{N}.md`
 * where N increments based on existing feedback files for this stage.
 *
 * Returns the absolute path of the written file.
 */
export async function writeFeedbackArtifact(
  artifactDir: string,
  stageName: string,
  feedback: string,
  approved: boolean,
): Promise<string> {
  const cccpDir = join(artifactDir, ".cccp");
  await mkdir(cccpDir, { recursive: true });

  // Determine next sequence number by scanning existing files.
  const prefix = `${stageName}-gate-feedback-`;
  let maxN = 0;
  try {
    const files = await readdir(cccpDir);
    for (const f of files) {
      if (f.startsWith(prefix) && f.endsWith(".md")) {
        const n = parseInt(f.slice(prefix.length, -3), 10);
        if (!isNaN(n) && n > maxN) maxN = n;
      }
    }
  } catch {
    // Directory may not exist yet — that's fine, start at 1.
  }

  const seq = maxN + 1;
  const fileName = `${prefix}${seq}.md`;
  const filePath = join(cccpDir, fileName);

  const decision = approved ? "Approved" : "Rejected";
  const timestamp = new Date().toISOString();
  const content = [
    `# Gate Feedback: ${stageName}`,
    "",
    `**Decision**: ${decision}`,
    `**Timestamp**: ${timestamp}`,
    "",
    "---",
    "",
    feedback,
    "",
  ].join("\n");

  await writeFile(filePath, content, "utf-8");
  return filePath;
}
