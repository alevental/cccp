---
name: plan-authoring
description: Master implementation plan — phased delivery with dependencies, milestones, and risk areas
---

# Master Plan Authoring

Read requirements, specs, and design documents, then produce a phased implementation plan that an engineering team can execute against.

## Instructions

1. Read all provided requirements, design documents, and context.
2. Decompose the work into sequential phases. Each phase must produce a usable increment — no phase should leave the system in a broken state.
3. For each phase, identify:
   - **Goal**: What capability exists at the end of this phase that did not exist before.
   - **Dependencies**: What must be complete before this phase can start.
   - **Tasks**: High-level work items (not file-level — that is task planning's job).
   - **Milestone**: How to verify the phase is complete (test, demo, metric).
   - **Risks**: What could go wrong and what the mitigation is.
4. Identify cross-phase risks: integration points, shared state, breaking changes.
5. Suggest sprint decomposition: which phases or sub-phases map to a single sprint.

## Output Format

```
## Master Plan: [Feature/Project Title]

### Phase 1: [Phase Name]
**Goal:** What is delivered.
**Dependencies:** None | Phase N
**Tasks:**
- Task description
**Milestone:** Verification criteria
**Risks:**
- Risk — mitigation

### Phase 2: [Phase Name]
...

### Cross-Phase Risks
- Risk — affected phases — mitigation

### Sprint Decomposition
- Sprint 1: Phase 1 + Phase 2a
- Sprint 2: Phase 2b + Phase 3
```

## Constraints

- Every phase must be independently verifiable. No "Phase 3 is where we find out if Phase 1 worked."
- Do not include time estimates — those depend on team capacity and are not the architect's concern.
- If requirements are ambiguous, list the ambiguity as a risk with a proposed default interpretation.
- Keep the plan to 3-6 phases. If more are needed, the scope should be split into multiple plans.
