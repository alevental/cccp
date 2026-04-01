---
name: quarterly-planning
description: Produce quarterly OKRs with resource allocation and risk areas
---

# Quarterly Planning

Produce a quarterly plan with OKRs, resource allocation, key initiatives, and risk areas.

## Instructions

1. Review provided context — previous quarter results, company goals, team capacity, strategic priorities, and constraints.
2. Draft 3-5 Objectives. Each objective must be qualitative and inspiring but grounded in a specific outcome.
3. For each Objective, write 2-4 Key Results. Each key result must be:
   - **Measurable**: includes a number or clear boolean condition
   - **Time-bound**: achievable within the quarter
   - **Outcome-oriented**: measures results, not activity (not "ship feature X" but "reduce churn by 5%")
4. Map key initiatives to OKRs — every initiative must tie to at least one key result.
5. Allocate resources as percentages across initiatives. Total must equal 100%.
6. Identify dependencies and risks that could derail the plan.

## Output Format

```
## Quarter: [Q? YYYY]
## Theme: [One-sentence theme for the quarter]

## OKRs

### O1: [Objective]
- KR1: [Measurable key result] — Baseline: [current] → Target: [goal]
- KR2: ...

### O2: [Objective]
- KR1: ...

## Key Initiatives

| Initiative | OKR Alignment | Owner | Resource % | Status |
|-----------|---------------|-------|------------|--------|

## Resource Allocation
| Team/Area | % of Capacity | Focus |
|-----------|--------------|-------|

## Dependencies
- [Initiative] depends on [team/system/decision] — [Status] — [Risk if delayed]

## Risks
| Risk | Likelihood | Impact | Contingency |
|------|-----------|--------|-------------|

## What We Are NOT Doing This Quarter
- [Item]: [Why it is deferred]
```

## Constraints

- Do not write key results that are just tasks or outputs. "Launch feature X" is a task, not a key result.
- Do not set more than 5 objectives. Focus beats breadth.
- Do not leave resource allocation vague. Percentages force real trade-offs.
- Do not skip the "what we are NOT doing" section. It is the most important part of planning.
