// ---------------------------------------------------------------------------
// Logger abstraction — decouples pipeline output from console
// ---------------------------------------------------------------------------

/** Minimal logger interface used throughout the pipeline runner. */
export interface Logger {
  log(...args: unknown[]): void;
  error(...args: unknown[]): void;
  warn(...args: unknown[]): void;
}

/** Default logger that forwards everything to the console. */
export class ConsoleLogger implements Logger {
  log(...args: unknown[]): void { console.log(...args); }
  error(...args: unknown[]): void { console.error(...args); }
  warn(...args: unknown[]): void { console.warn(...args); }
}

/** Logger that suppresses log/warn but still emits errors (for TUI mode). */
export class QuietLogger implements Logger {
  log(): void {}
  error(...args: unknown[]): void { console.error(...args); }
  warn(): void {}
}

/** Completely silent logger — useful for tests. */
export class SilentLogger implements Logger {
  log(): void {}
  error(): void {}
  warn(): void {}
}
