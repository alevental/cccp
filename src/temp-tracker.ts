import { unlink, unlinkSync } from "node:fs";

export class TempFileTracker {
  private paths: string[] = [];

  track(path: string): string {
    this.paths.push(path);
    return path;
  }

  async cleanup(): Promise<void> {
    await Promise.all(
      this.paths.map((p) =>
        new Promise<void>((resolve) => {
          unlink(p, () => resolve()); // ignore errors
        })
      )
    );
    this.paths = [];
  }

  cleanupSync(): void {
    for (const p of this.paths) {
      try { unlinkSync(p); } catch { /* ignore */ }
    }
    this.paths = [];
  }
}
