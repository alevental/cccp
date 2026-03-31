#!/bin/bash
set -euo pipefail

# QMD collection setup for CCCP project docs
# Uses named index "cccp" to isolate from other projects.
# Idempotent — safe to re-run after adding/changing collections.
#
# Prerequisites:
#   npm install -g @tobilu/qmd
#
# Usage:
#   ./scripts/qmd-setup.sh

QMD="qmd --index cccp"

echo "Setting up QMD collections (index: cccp)..."

# Remove existing collections to start clean
existing=$($QMD collection list 2>/dev/null | grep -oE '^[a-z][a-z0-9_-]+' || true)
for name in $existing; do
  $QMD collection remove "$name" 2>/dev/null || true
done

# Foundational
$QMD collection add docs/architecture/ --name architecture
$QMD collection add docs/api/ --name api

# Reference
$QMD collection add docs/guides/ --name guides
$QMD collection add docs/patterns/ --name patterns

# Supplementary
$QMD collection add docs/adr/ --name decisions
$QMD collection add . --name onboarding --mask "*.md"

echo ""
echo "Configuring context annotations..."

$QMD context add qmd://architecture "System internals: pipeline execution, PGE engine, agent resolution, state persistence (SQLite), gate system, streaming, TUI dashboard, doc mapping"
$QMD context add qmd://api "External interfaces: CLI commands (run, resume, dashboard, mcp-server, init), MCP tools (cccp_runs, cccp_status, cccp_gate_respond, cccp_logs, cccp_artifacts), cccp.yaml configuration schema"
$QMD context add qmd://guides "User-facing how-tos: pipeline YAML authoring, agent markdown authoring, project setup and first run"
$QMD context add qmd://patterns "Reusable recipes: PGE cycle pattern (contract → generate → evaluate → route), agent dispatch pattern (subprocess flags, prompt assembly)"
$QMD context add qmd://decisions "Architecture Decision Records: SQLite over JSON (ADR-001), sql.js over better-sqlite3 (ADR-002)"
$QMD context add qmd://onboarding "Project setup, build commands, and conventions (CLAUDE.md, README.md)"
$QMD context add / "CCCP (Claude Code and Cmux Pipeline Reagent) — a TypeScript CLI for deterministic YAML-based pipeline orchestration with Claude Code and cmux"

echo ""
echo "Building index (embedding documents)..."
$QMD embed

echo ""
echo "QMD setup complete!"
echo "Collections: $($QMD collection list 2>/dev/null | grep -cE '^[a-z]' || echo 0)"
echo ""
echo "To verify: qmd --index cccp status"
