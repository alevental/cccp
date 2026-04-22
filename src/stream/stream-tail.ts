import { watch, type FSWatcher } from "node:fs";
import { readdir, open } from "node:fs/promises";
import { resolve } from "node:path";
import { EventEmitter } from "node:events";
import { StreamParser, type AgentActivity } from "./stream.js";
import { incTailerCount, decTailerCount } from "../diagnostics/runtime-registry.js";
import { debug as logDebug } from "../logger.js";

/**
 * Tails `.stream.jsonl` files in a `.cccp/` directory and emits
 * `"activity"` events as new lines are written. Used by the standalone
 * `cccp dashboard` command where the runner is in a separate process.
 */
export class StreamTailer extends EventEmitter {
  private parsers: Map<string, { parser: StreamParser; offset: number }> = new Map();
  private dirWatcher: FSWatcher | null = null;
  private pollInterval: ReturnType<typeof setInterval> | null = null;

  private counted = false;

  constructor(private cccpDir: string) {
    super();
    incTailerCount();
    this.counted = true;
    logDebug("stream", "StreamTailer opened", { dir: cccpDir });
  }

  async start(): Promise<void> {
    // Initial scan for existing files.
    await this.scanFiles();

    // Watch for new/changed files.
    try {
      this.dirWatcher = watch(this.cccpDir, async (eventType, filename) => {
        if (filename?.endsWith(".stream.jsonl")) {
          await this.tailFile(filename);
        }
      });
    } catch {
      // Directory may not exist yet — fall back to polling.
    }

    // Poll every 500ms as a fallback (fs.watch can miss events).
    this.pollInterval = setInterval(() => this.scanFiles().catch(() => {}), 500);
  }

  stop(): void {
    this.dirWatcher?.close();
    this.dirWatcher = null;
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
    for (const { parser } of this.parsers.values()) {
      parser.flush();
      parser.removeAllListeners();
    }
    this.parsers.clear();
    this.removeAllListeners();
    if (this.counted) {
      decTailerCount();
      this.counted = false;
      logDebug("stream", "StreamTailer closed");
    }
  }

  private async scanFiles(): Promise<void> {
    let files: string[];
    try {
      files = await readdir(this.cccpDir);
    } catch {
      return;
    }

    for (const file of files) {
      if (file.endsWith(".stream.jsonl")) {
        await this.tailFile(file);
      }
    }
  }

  private async tailFile(filename: string): Promise<void> {
    const filePath = resolve(this.cccpDir, filename);
    const agentName = filename.replace(/\.stream\.jsonl$/, "");

    if (!this.parsers.has(filename)) {
      const parser = new StreamParser(agentName);
      parser.on("activity", (a: AgentActivity) => {
        this.emit("activity", a);
      });
      this.parsers.set(filename, { parser, offset: 0 });
    }

    const entry = this.parsers.get(filename)!;

    try {
      const fh = await open(filePath, "r");
      try {
        const stat = await fh.stat();
        if (stat.size <= entry.offset) return;

        const buf = Buffer.alloc(stat.size - entry.offset);
        const { bytesRead } = await fh.read(buf, 0, buf.length, entry.offset);
        entry.offset += bytesRead;

        if (bytesRead > 0) {
          entry.parser.feed(buf.toString("utf-8", 0, bytesRead));
        }
      } finally {
        await fh.close();
      }
    } catch {
      // File may be mid-write or deleted — ignore.
    }
  }
}
