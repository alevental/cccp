import React from "react";
import { Box, Text, useStdout } from "ink";

import type { StateEvent } from "../types.js";

// ---------------------------------------------------------------------------
// Detail log — replaces EventLog with rich PGE visualization
// ---------------------------------------------------------------------------

interface DetailLogProps {
  events: StateEvent[];
  /** Height of the fixed panes above (header + split pane + margins). */
  chromeHeight?: number;
}

export function DetailLog({ events, chromeHeight = 14 }: DetailLogProps) {
  const { stdout } = useStdout();
  // +2 for the DetailLog title line and its marginTop
  const availableHeight = Math.max(5, (stdout.rows ?? 24) - chromeHeight - 2);

  // Flatten all events into formatted lines, then show the last N.
  const allLines: React.ReactNode[] = [];
  for (const event of events) {
    allLines.push(...formatDetailEvent(event));
  }
  const visibleLines = allLines.slice(-availableHeight);

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text bold underline>Detail Log</Text>
      {visibleLines.length === 0 && (
        <Text dimColor>  Waiting for events...</Text>
      )}
      {visibleLines.map((line, i) => (
        <Box key={i}>{line}</Box>
      ))}
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Event formatting — returns one or more <Text> lines per event
// ---------------------------------------------------------------------------

// PAD must be 10 chars to align with "{HH:MM:SS}  " (8 + 2 = 10) before the bar.
const PAD = "          ";
const BAR = "\u2502";

const MAX_PREVIEW_LINES = 15;

/** Render a preview of artifact content under the PGE gutter bar. */
function artifactPreview(content: string): React.ReactNode[] {
  if (!content.trim()) return [];
  const lines = content.split("\n").filter((l) => l.trim());
  const preview = lines.slice(0, MAX_PREVIEW_LINES);
  const remaining = lines.length - preview.length;

  const result: React.ReactNode[] = [];
  for (const [i, line] of preview.entries()) {
    const truncated = line.length > 80 ? line.slice(0, 77) + "..." : line;
    result.push(
      <Text key={`ap-${i}`}><Text dimColor>{PAD}</Text><Text color="cyan">{BAR}</Text><Text dimColor>    {truncated}</Text></Text>,
    );
  }
  if (remaining > 0) {
    result.push(
      <Text key="ap-more"><Text dimColor>{PAD}</Text><Text color="cyan">{BAR}</Text><Text dimColor>    ... {remaining} more lines</Text></Text>,
    );
  }
  return result;
}

export function formatDetailEvent(event: StateEvent): React.ReactNode[] {
  const time = event.timestamp.slice(11, 19); // HH:MM:SS
  const d = (event.data ?? {}) as Record<string, unknown>;

  switch (event.eventType) {
    // --- PGE events ---

    case "pge_planner_start": {
      const agent = String(d.agent ?? "?");
      return [
        <Text key="ps"><Text dimColor>{time}</Text><Text color="cyan">  {"\u250C\u2500"} PGE: {event.stageName}</Text></Text>,
        <Text key="ps2"><Text dimColor>{PAD}</Text><Text color="cyan">{BAR}</Text><Text color="yellow">  {"\u25B6"} Planner [{agent}]</Text></Text>,
      ];
    }

    case "pge_planner_done":
      return [
        <Text key="pd"><Text dimColor>{time}</Text><Text color="cyan">  {BAR}</Text><Text dimColor>  {"\u2713"} Task plan {"\u2192"} </Text><Text color="white">{String(d.taskPlanPath ?? "")}</Text></Text>,
      ];

    case "pge_contract_start": {
      const agent = String(d.agent ?? "?");
      return [
        <Text key="cs"><Text dimColor>{time}</Text><Text color="cyan">  {BAR}</Text><Text color="yellow">  {"\u25B6"} Contract [{agent}]</Text></Text>,
      ];
    }

    case "pge_contract_done": {
      const contractPath = String(d.contractPath ?? "");
      const contract = d.contractContent as string ?? "";
      return [
        <Text key="cd"><Text dimColor>{time}</Text><Text color="cyan">  {BAR}</Text><Text dimColor>  {"\u2713"} Contract {"\u2192"} </Text><Text color="white">{contractPath}</Text></Text>,
        ...(contract ? artifactPreview(contract) : []),
      ];
    }

    case "pge_start": {
      const planner = d.planner as string ?? "?";
      const gen = d.generator as string ?? "?";
      const eval_ = d.evaluator as string ?? "?";
      const maxIter = String(d.maxIterations ?? "?");
      return [
        <Text key="s1"><Text dimColor>{time}</Text><Text color="cyan">  {BAR}</Text><Text>  Planner: <Text color="green">{planner}</Text>  Generator: <Text color="green">{gen}</Text>  Evaluator: <Text color="green">{eval_}</Text></Text></Text>,
        <Text key="s2"><Text dimColor>{PAD}</Text><Text color="cyan">{BAR}</Text><Text>  Max: {maxIter} iters — GE loop starting</Text></Text>,
      ];
    }

    case "pge_generator_start": {
      const agent = String(d.agent ?? "?");
      const iter = String(d.iteration ?? "?");
      const maxI = String(d.maxIterations ?? "?");
      return [
        <Text key="gs"><Text dimColor>{time}</Text><Text color="cyan">  {BAR}</Text><Text color="yellow">  {"\u25B6"} Generator [{agent}] iter {iter}/{maxI}</Text></Text>,
      ];
    }

    case "pge_generator_done":
      return [
        <Text key="gd"><Text dimColor>{time}</Text><Text color="cyan">  {BAR}</Text><Text dimColor>  {"\u2713"} Deliverable {"\u2192"} </Text><Text color="white">{String(d.deliverablePath ?? "")}</Text></Text>,
      ];

    case "pge_evaluator_start": {
      const agent = String(d.agent ?? "?");
      const iter = String(d.iteration ?? "?");
      const maxI = String(d.maxIterations ?? "?");
      return [
        <Text key="es"><Text dimColor>{time}</Text><Text color="cyan">  {BAR}</Text><Text color="yellow">  {"\u25B6"} Evaluator [{agent}] iter {iter}/{maxI}</Text></Text>,
      ];
    }

    case "pge_evaluator_done":
      return [
        <Text key="ed"><Text dimColor>{time}</Text><Text color="cyan">  {BAR}</Text><Text dimColor>  {"\u2713"} Evaluation {"\u2192"} </Text><Text color="white">{String(d.evaluationPath ?? "")}</Text></Text>,
      ];

    case "pge_evaluation": {
      const outcome = String(d.outcome ?? "?");
      const iter = String(d.iteration ?? "?");
      const maxIter = String(d.maxIterations ?? "?");
      const evalContent = d.evaluationContent as string ?? "";
      const evalPath = String(d.evaluationPath ?? "");
      const willRetry = d.willRetry as boolean | undefined;
      const escalation = d.escalation as string | undefined;

      if (outcome === "pass") {
        return [
          <Text key="ep"><Text dimColor>{time}</Text><Text color="cyan">  {BAR}</Text><Text color="green" bold>  {"\u2714"} PASS (iter {iter}/{maxIter})</Text><Text dimColor> {"\u2192"} </Text><Text color="white">{evalPath}</Text></Text>,
          ...(evalContent ? artifactPreview(evalContent) : []),
          <Text key="epc"><Text dimColor>{PAD}</Text><Text color="cyan">{"\u2514\u2500\u2500\u2500\u2500\u2500\u2500"}</Text></Text>,
        ];
      }

      if (outcome === "fail") {
        const suffix = willRetry
          ? " \u2014 retrying"
          : ` \u2014 exhausted, escalation: ${escalation ?? "stop"}`;
        return [
          <Text key="ef"><Text dimColor>{time}</Text><Text color="cyan">  {BAR}</Text><Text color="red">  {"\u2717"} FAIL (iter {iter}/{maxIter}){suffix}</Text><Text dimColor> {"\u2192"} </Text><Text color="white">{evalPath}</Text></Text>,
          ...(evalContent ? artifactPreview(evalContent) : []),
          ...(!willRetry ? [
            <Text key="efc"><Text dimColor>{PAD}</Text><Text color="cyan">{"\u2514\u2500\u2500\u2500\u2500\u2500\u2500"}</Text></Text>,
          ] : []),
        ];
      }

      // parse_error
      return [
        <Text key="ee"><Text dimColor>{time}</Text><Text color="cyan">  {BAR}</Text><Text color="red">  {"\u26A0"} PARSE ERROR: {String(d.error ?? "unknown")}</Text></Text>,
        <Text key="eec"><Text dimColor>{PAD}</Text><Text color="cyan">{"\u2514\u2500\u2500\u2500\u2500\u2500\u2500"}</Text></Text>,
      ];
    }

    // --- Non-PGE events (compact single line) ---

    case "stage_start":
      return [
        <Text key="ss"><Text dimColor>{time}</Text><Text color="yellow">  {"\u25B6"} Started: {event.stageName}</Text></Text>,
      ];

    case "stage_complete": {
      const status = d.status as string ?? "?";
      const ms = d.durationMs as number | undefined;
      const dur = ms != null ? ` (${(ms / 1000).toFixed(1)}s)` : "";
      const color = status === "passed" ? "green" : "red";
      return [
        <Text key="sc"><Text dimColor>{time}</Text><Text color={color}>  {status === "passed" ? "\u2713" : "\u2717"} Completed: {event.stageName} {status}{dur}</Text></Text>,
      ];
    }

    case "gate_pending":
      return [
        <Text key="gp"><Text dimColor>{time}</Text><Text color="blue">  {"\u23F8"} Gate pending: {event.stageName}</Text></Text>,
      ];

    case "gate_responded":
      return [
        <Text key="gr"><Text dimColor>{time}</Text><Text color="green">  {"\u2713"} Gate responded: {event.stageName}</Text></Text>,
      ];

    case "pipeline_complete": {
      const status = d.status as string ?? "?";
      const color = status === "passed" ? "green" : "red";
      return [
        <Text key="pc"><Text dimColor>{time}</Text><Text color={color} bold>  {"\u2550"} Pipeline {status}</Text></Text>,
      ];
    }

    default:
      return [
        <Text key="df"><Text dimColor>{time}</Text><Text>  {event.eventType}{event.stageName ? ` ${event.stageName}` : ""}</Text></Text>,
      ];
  }
}
