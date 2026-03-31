# TODO-001: Pipeline Composition — Sub-Pipeline Stages

**Status:** open
**Priority:** medium
**Type:** feature
**Created:** 2026-03-27
**Updated:** 2026-03-27

## Context

Pipelines are currently flat — a sequence of `agent`, `pge`, and `human_gate` stages. As projects grow, pipeline YAML files become long and hard to reuse. A common pattern is wanting to invoke a well-tested sub-pipeline (e.g., "build docs") as a single stage within a larger pipeline. This came up during the architectural refactoring session as a natural next enhancement.

## Goal

A new `type: "pipeline"` stage that invokes a separate pipeline YAML as a sub-pipeline. The sub-pipeline runs inline within the parent, shares the same run lifecycle, and its stages appear in the TUI and state. When done, a parent pipeline can compose reusable sub-pipelines without copy-pasting stages.

```yaml
name: full-build
stages:
  - name: research
    type: agent
    agent: researcher
    output: "{artifact_dir}/research.md"

  - name: documentation
    type: pipeline
    file: pipelines/build-docs.yaml
    variables:
      source: "{artifact_dir}/research.md"
    # artifact_dir: "{artifact_dir}/docs"  # optional scoping

  - name: final-review
    type: human_gate
    prompt: "Review the generated documentation"
```

## Current State

The stage type system uses a Zod discriminated union on `type` (`src/pipeline.ts`). The runner dispatches via a `switch` on `stage.type` (`src/runner.ts`). Adding a new stage type is well-paved — add a schema, a type, and a handler.

The main complexity is in the **state model** and the consumers that read it.

## Steps / Open Questions

### Design decisions (resolved)

- [x] **Artifact directory:** Inherit parent's `artifactDir` by default; optional `artifact_dir` override on the stage for isolation
- [x] **State model:** Nested `PipelineState` inside `StageState` (not flattened) — avoids name collisions, enables recursive resume, self-contained sub-pipeline state
- [x] **Variable flow:** Explicit pass-through only — sub-pipeline does NOT inherit parent variables implicitly. Built-in variables (`project`, `project_dir`, `artifact_dir`, `pipeline_name`) recomputed for sub-pipeline context
- [x] **Execution model:** Recursive `runPipeline()` call with child `RunContext`
- [x] **Database storage:** Embedded in parent's `stages_json`, not a separate `runs` row
- [x] **Cycle detection:** `Set<string>` of visited pipeline paths on RunContext, max depth 5

### Implementation

- [ ] Add `PipelineStage` interface to `src/types.ts`, add to `Stage` union
- [ ] Add `children?: PipelineState` to `StageState`
- [ ] Add `PipelineStageSchema` to Zod discriminated union in `src/pipeline.ts`
- [ ] Add `visitedPipelines?: Set<string>` to `RunContext` in `src/types.ts`
- [ ] Implement `runPipelineStage()` in `src/runner.ts` — load sub-pipeline, build child context, call `runPipeline()` recursively, map result
- [ ] Add cycle detection check before recursive call
- [ ] Update `findResumePoint()` in `src/state.ts` to walk nested state tree
- [ ] Update TUI `StageList` in `src/tui/components.tsx` for recursive rendering with indentation
- [ ] Update MCP tools (status, artifacts) in `src/mcp/mcp-server.ts` to walk nested state
- [ ] Add tests: happy path, resume across boundary, cycle detection, variable isolation, dry-run

### Open questions

- [ ] Should `on_fail` be supported on pipeline stages? (e.g., if the sub-pipeline fails, skip/gate/stop)
- [ ] Should the sub-pipeline's gate stages use the parent's gate strategy, or can it be overridden?
- [ ] What happens if a sub-pipeline is resumed standalone (`cccp resume`) vs as part of the parent?

## References

- `src/types.ts` — Stage discriminated union, PipelineState, StageState, RunContext
- `src/pipeline.ts` — Zod schemas for stage validation
- `src/runner.ts` — `runStage()` dispatch, `runPipeline()` entry point
- `src/state.ts` — `findResumePoint()` resume logic
- `src/context.ts` — `buildRunContext()`, `buildAgentSearchPaths()`
- `src/tui/components.tsx` — `StageList` component
- `src/mcp/mcp-server.ts` — `cccp_status`, `cccp_artifacts` tools
- `src/mcp/mcp-config.ts` — MCP profile cycle detection (pattern to reuse)
