import React, { useState, useEffect, useMemo } from "react";
import { render, Box, Text, useStdout, useInput } from "ink";
import { SingleFileTailer, type StreamDetailAccumulator, type MonitorEntry } from "../stream/stream-detail.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Max lines shown per entry in collapsed mode. */
const COLLAPSED_LINES = 4;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatElapsed(ms: number): string {
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  return `${mins}m ${secs % 60}s`;
}

function fmtTok(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

// ---------------------------------------------------------------------------
// Entry rendering
// ---------------------------------------------------------------------------

function truncateLines(text: string, maxLines: number): { lines: string[]; truncated: number } {
  const all = text.split("\n");
  if (all.length <= maxLines) return { lines: all, truncated: 0 };
  return { lines: all.slice(0, maxLines), truncated: all.length - maxLines };
}

function renderTextEntry(entry: MonitorEntry & { type: "text" }, expanded: boolean): React.ReactNode[] {
  const result: React.ReactNode[] = [];
  if (expanded) {
    const lines = entry.text.split("\n");
    for (const [i, line] of lines.entries()) {
      result.push(
        <Text key={`t-${entry.ts}-${i}`}>  {line}</Text>,
      );
    }
  } else {
    const { lines, truncated } = truncateLines(entry.text, COLLAPSED_LINES);
    for (const [i, line] of lines.entries()) {
      result.push(
        <Text key={`t-${entry.ts}-${i}`}>  {line}</Text>,
      );
    }
    if (truncated > 0) {
      result.push(
        <Text key={`t-${entry.ts}-more`} dimColor>  ... {truncated} more lines</Text>,
      );
    }
  }
  return result;
}

function renderThinkingEntry(entry: MonitorEntry & { type: "thinking" }, expanded: boolean): React.ReactNode[] {
  const result: React.ReactNode[] = [];
  result.push(
    <Text key={`th-${entry.ts}-h`} color="magenta">{"\u25B8"} Thinking</Text>,
  );
  if (expanded) {
    const lines = entry.text.split("\n");
    for (const [i, line] of lines.entries()) {
      result.push(
        <Text key={`th-${entry.ts}-${i}`} dimColor>  {line}</Text>,
      );
    }
  } else {
    const { lines, truncated } = truncateLines(entry.text, COLLAPSED_LINES);
    for (const [i, line] of lines.entries()) {
      result.push(
        <Text key={`th-${entry.ts}-${i}`} dimColor>  {line}</Text>,
      );
    }
    if (truncated > 0) {
      result.push(
        <Text key={`th-${entry.ts}-more`} dimColor>  ... {truncated} more lines</Text>,
      );
    }
  }
  return result;
}

function renderToolCallEntry(entry: MonitorEntry & { type: "tool_call" }, expanded: boolean): React.ReactNode[] {
  const result: React.ReactNode[] = [];
  const summaryText = entry.summary ? ` ${entry.summary}` : "";
  result.push(
    <Text key={`tc-${entry.id}`}>
      <Text color="cyan">{"\u25B6"} {entry.name}</Text>
      <Text dimColor>{summaryText}</Text>
    </Text>,
  );
  if (expanded && entry.input) {
    const json = JSON.stringify(entry.input, null, 2);
    const lines = json.split("\n");
    for (const [i, line] of lines.entries()) {
      result.push(
        <Text key={`tc-${entry.id}-${i}`} dimColor>  {line}</Text>,
      );
    }
  }
  return result;
}

function renderToolResultEntry(entry: MonitorEntry & { type: "tool_result" }): React.ReactNode[] {
  return [
    <Text key={`tr-${entry.id}`}>
      <Text color="gray">{"\u2713"} {entry.name}</Text>
    </Text>,
  ];
}

function renderTaskProgressEntry(entry: MonitorEntry & { type: "task_progress" }): React.ReactNode[] {
  const tool = entry.toolName ? `${entry.toolName}: ` : "";
  return [
    <Text key={`tp-${entry.ts}`} dimColor>  [sub-agent] {tool}{entry.description}</Text>,
  ];
}

function renderResultEntry(entry: MonitorEntry & { type: "result" }): React.ReactNode[] {
  const tok = `${fmtTok(entry.inputTokens ?? 0)}/${fmtTok(entry.outputTokens ?? 0)} tok`;
  const cost = entry.totalCostUsd ? ` \u00B7 $${entry.totalCostUsd.toFixed(4)}` : "";
  const exit = entry.exitCode === 0 ? "success" : `exit ${entry.exitCode}`;
  return [
    <Text key={`res-${entry.ts}`} color={entry.exitCode === 0 ? "green" : "red"} bold>
      {entry.exitCode === 0 ? "\u2714" : "\u2717"} Done ({exit}) {"\u2014"} {tok}{cost}
    </Text>,
  ];
}

function renderEntry(entry: MonitorEntry, expanded: boolean): React.ReactNode[] {
  switch (entry.type) {
    case "text": return renderTextEntry(entry, expanded);
    case "thinking": return renderThinkingEntry(entry, expanded);
    case "tool_call": return renderToolCallEntry(entry, expanded);
    case "tool_result": return renderToolResultEntry(entry);
    case "task_progress": return renderTaskProgressEntry(entry);
    case "result": return renderResultEntry(entry);
    case "system_init": return []; // Shown in header
  }
}

// ---------------------------------------------------------------------------
// Agent Monitor component
// ---------------------------------------------------------------------------

interface AgentMonitorProps {
  filePath: string;
  agentName: string;
  onDone?: () => void;
}

function AgentMonitor({ filePath, agentName, onDone }: AgentMonitorProps) {
  const { stdout } = useStdout();
  const [detail, setDetail] = useState<StreamDetailAccumulator | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [scrollOffset, setScrollOffset] = useState(0);
  const [startTime] = useState(Date.now());
  const [elapsed, setElapsed] = useState(0);

  // Start tailing.
  useEffect(() => {
    const tailer = new SingleFileTailer(filePath, agentName);
    tailer.on("update", (acc: StreamDetailAccumulator) => {
      setDetail({ ...acc, entries: [...acc.entries] } as StreamDetailAccumulator);
    });
    tailer.on("done", () => {
      // Brief pause to show final state.
      setTimeout(() => onDone?.(), 1500);
    });
    tailer.start().catch(() => {});
    return () => { tailer.stop(); };
  }, [filePath, agentName, onDone]);

  // Elapsed timer.
  useEffect(() => {
    const timer = setInterval(() => setElapsed(Date.now() - startTime), 1000);
    return () => clearInterval(timer);
  }, [startTime]);

  // Keyboard input.
  useInput((input, key) => {
    if (input === "e" || input === "E") {
      setExpanded((prev) => !prev);
      setScrollOffset(0);
    } else if (key.upArrow) {
      setScrollOffset((prev) => prev + 1);
    } else if (key.downArrow) {
      setScrollOffset((prev) => Math.max(0, prev - 1));
    } else if (key.pageUp) {
      setScrollOffset((prev) => prev + 10);
    } else if (key.pageDown) {
      setScrollOffset((prev) => Math.max(0, prev - 10));
    } else if (key.end || input === "G") {
      setScrollOffset(0);
    } else if (key.home || input === "g") {
      // Jump to top — set to a large value, will be clamped.
      setScrollOffset(99999);
    }
  });

  // Flatten entries to lines.
  const allLines = useMemo(() => {
    if (!detail) return [];
    const lines: React.ReactNode[] = [];
    for (const entry of detail.entries) {
      lines.push(...renderEntry(entry, expanded));
    }
    return lines;
  }, [detail, expanded]);

  const terminalRows = stdout.rows ?? 24;
  const headerHeight = 3; // header + stats + separator
  const footerHeight = 1; // keybinding hint
  const availableHeight = Math.max(3, terminalRows - headerHeight - footerHeight);
  const totalLines = allLines.length;
  const maxOffset = Math.max(0, totalLines - availableHeight);
  const clampedOffset = Math.min(scrollOffset, maxOffset);
  const endIndex = totalLines - clampedOffset;
  const startIndex = Math.max(0, endIndex - availableHeight);
  const visibleLines = allLines.slice(startIndex, endIndex);
  const isScrolled = clampedOffset > 0;

  const model = detail?.model ?? "";
  const inputTok = detail?.inputTokens ?? 0;
  const outputTok = detail?.outputTokens ?? 0;
  const cost = detail?.totalCostUsd ?? 0;
  const toolCount = detail?.toolCallCount ?? 0;
  const done = detail?.done ?? false;

  return (
    <Box flexDirection="column" height={terminalRows} overflow="hidden">
      {/* Header */}
      <Box>
        <Text bold color={done ? "green" : "yellow"}>[{agentName}]</Text>
        <Text dimColor> {model} {"\u00B7"} {formatElapsed(elapsed)}</Text>
      </Box>
      <Box>
        <Text dimColor>
          {fmtTok(inputTok)}/{fmtTok(outputTok)} tok
          {cost > 0 && ` \u00B7 $${cost.toFixed(4)}`}
          {` \u00B7 ${toolCount} tool calls`}
        </Text>
      </Box>

      {/* Separator */}
      <Text dimColor>{"\u2500".repeat(Math.min(60, stdout.columns ?? 60))}</Text>

      {/* Event log */}
      {visibleLines.length === 0 && (
        <Text dimColor>Waiting for stream data...</Text>
      )}
      {visibleLines.map((line, i) => (
        <Box key={i}>{line}</Box>
      ))}

      {/* Footer */}
      <Box position="absolute" marginTop={terminalRows - 1}>
        <Text dimColor>
          [e] {expanded ? "collapse" : "expand"}
          {isScrolled && " [scrolled \u2014 End to resume]"}
          {!isScrolled && totalLines > availableHeight && " [\u2191\u2193 scroll]"}
        </Text>
      </Box>
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Launch function (called from CLI)
// ---------------------------------------------------------------------------

export async function launchAgentMonitor(
  streamLogPath: string,
  agentName: string,
): Promise<void> {
  return new Promise<void>((resolvePromise) => {
    const { unmount, waitUntilExit } = render(
      <AgentMonitor
        filePath={streamLogPath}
        agentName={agentName}
        onDone={() => {
          unmount();
          resolvePromise();
        }}
      />,
      { maxFps: 10 },
    );

    waitUntilExit().then(() => resolvePromise());
  });
}
