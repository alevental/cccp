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

# Architecture and internals documentation
$QMD collection add docs/architecture/ --name architecture

# Project-level onboarding (CLAUDE.md, README.md — root .md files only)
$QMD collection add . --name onboarding --mask "*.md"

echo ""
echo "Configuring context annotations..."

$QMD context add qmd://architecture "CCCP system architecture: component relationships, data flow, PGE engine internals, state persistence, agent resolution, and MCP config generation"
$QMD context add qmd://onboarding "Project setup, build commands, CLI reference, and contribution guidelines for the CCCP pipeline orchestration tool"
$QMD context add / "CCCP (Claude Code and Cmux Pipeline Reagent) — a TypeScript CLI for deterministic YAML-based pipeline orchestration with Claude Code and cmux"

echo ""
echo "Building index (embedding documents)..."
$QMD embed

echo ""
echo "QMD setup complete!"
echo "Collections: $($QMD collection list 2>/dev/null | grep -cE '^[a-z]' || echo 0)"
echo ""
echo "To verify: qmd --index cccp status"
