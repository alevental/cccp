# TODO-002: Pipeline Authoring Agent

**Status:** open
**Priority:** high
**Type:** feature
**Created:** 2026-03-30
**Updated:** 2026-03-30

## Context

Pipelines today are hand-written YAML. As CCCP moves toward dynamic workflows — where a planning pipeline produces a sprint pipeline, or a discovery pipeline produces an implementation pipeline — we need an agent that can write (and review) valid pipeline YAML.

This is distinct from TODO-001 (pipeline composition/sub-pipelines). Composition is about nesting pipelines at runtime. This is about an agent that *generates* pipeline YAML as a deliverable, which is then executed as an independent `cccp run`.

## Goal

A pipeline-authoring agent (and optionally a paired evaluator) that can:

1. Scan the project's agent search paths to discover available agents and their capabilities
2. Understand the pipeline YAML schema (stage types, PGE contracts, variables, etc.)
3. Produce valid, well-structured pipeline YAML tailored to a specific task/project
4. Be usable as a generator in a PGE stage, so generated pipelines can be evaluated before execution

### Workflow example

```
Pipeline A (planning):
  stage 1: research the project
  stage 2: design the architecture
  stage 3: generate sprint-1 pipeline (PGE)  ← pipeline-author agent writes YAML
           evaluator checks validity, agent coverage, task completeness

(Pipeline A completes, outputs: pipelines/sprint-1.yaml)

Pipeline B (sprint-1.yaml):                  ← independent run
  stage 1: implement-auth
  stage 2: implement-api
  stage 3: test
```

## Design

### Agent catalog via self-assembly

Rather than maintaining a static agent manifest that can go stale, the pipeline-authoring agent scans at runtime:

1. Read the project's `cccp.yaml` to find `agent_paths`
2. Walk each search path directory
3. For each agent found:
   - Read the markdown to understand its role and capabilities
   - For directory agents, list available operations
   - Note any frontmatter metadata (name, description)
4. Build an internal catalog before writing the pipeline

This requires the agent to have filesystem read access (`Read`, `Glob` tools at minimum).

### Schema knowledge

Embedded directly in the agent markdown -- the full pipeline YAML schema with examples of each stage type (`agent`, `pge`, `human_gate`), PGE planner/generator/evaluator configuration, contract guidance, variable interpolation, `on_fail` strategies, and MCP profiles.

### Pipeline evaluator

A paired evaluator agent that checks generated pipelines for:

- YAML validity and Zod schema compliance
- All referenced agents exist on disk
- Operations referenced exist for directory agents
- PGE stages have planner, generator, and evaluator configured
- Contract guidance is specific and actionable
- Task instructions are clear and actionable
- Variable references are consistent
- Stage ordering makes sense (inputs available before they're needed)

The evaluator could even do a dry-run parse (`loadPipeline()` on the generated file) as part of its validation.

## Implementation

### Agent files

```
agents/
  pipeline-author/
    agent.md              # Base: schema knowledge, conventions, output format
    sprint-planning.md    # Operation: generate sprint execution pipelines
    qa-planning.md        # Operation: generate QA/testing pipelines
    discovery.md          # Operation: generate discovery/research pipelines

  pipeline-reviewer.md    # Evaluator for generated pipelines
```

### Steps

- [ ] Write `pipeline-author/agent.md` with full schema reference and catalog-scanning instructions
- [ ] Write at least one operation (e.g., `sprint-planning.md`)
- [ ] Write `pipeline-reviewer.md` evaluator agent
- [ ] Create an example "meta-pipeline" that uses the authoring agent in a PGE stage
- [ ] Test end-to-end: meta-pipeline generates a sprint pipeline, sprint pipeline executes
- [ ] Document the pattern in `docs/guides/` or `docs/patterns/`

### Open questions

- [ ] Should the pipeline-author agent ship with CCCP, or live in a separate "cccp-agents" package?
- [ ] Should there be a CLI helper (`cccp generate-pipeline`) that wraps the agent invocation?
- [ ] How to handle the handoff — should the meta-pipeline's last stage automatically print "run this next: `cccp run -f <generated.yaml>`"?

## References

- `src/pipeline.ts` — Zod schemas the generated YAML must satisfy
- `src/agent-resolver.ts` — agent search path logic the catalog scan mirrors
- `docs/guides/pipeline-authoring.md` — schema docs to embed or reference
- `docs/guides/agent-authoring.md` — agent format docs
- `docs/todos/001-pipeline-composition.md` — related but orthogonal feature
