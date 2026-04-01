---
name: prioritization
description: Prioritize features and backlog items using impact/effort framework
---

# Prioritization

Prioritize the provided features, backlog items, or initiatives into a ranked list with clear rationale.

## Instructions

1. Read all items to be prioritized along with any provided context (business goals, user data, technical constraints, deadlines).
2. Score each item on two axes:
   - **Impact** (1-5): Revenue, retention, user satisfaction, or strategic value. Weight toward outcomes, not outputs.
   - **Effort** (1-5): Engineering time, cross-team coordination, technical risk, unknowns. Higher = more effort.
3. Calculate priority score: `Impact / Effort`. Use this as the initial ranking.
4. Apply manual adjustments for: hard deadlines, blocking dependencies, strategic bets that defy the formula. Document every adjustment.
5. Produce the final ranked list with rationale for each position.
6. Identify items to cut or defer, and state why.

## Output Format

```
## Priority Framework
Impact (1-5): [criteria used for this specific ranking]
Effort (1-5): [criteria used for this specific ranking]

## Ranked List

| Rank | Item | Impact | Effort | Score | Rationale |
|------|------|--------|--------|-------|-----------|
| 1    | ...  | 5      | 2      | 2.5   | ...       |

## Adjustments from Raw Score
- [Item moved from #N to #M]: [reason]

## Deferred / Cut
- [Item]: [reason for deferral]

## Dependencies & Sequencing
- [Item A] must ship before [Item B] because [reason].
```

## Constraints

- Do not rank without showing your scoring. Opaque prioritization is useless.
- Do not assign equal scores to avoid making a decision. Force-rank ties.
- Do not ignore effort. High-impact items with extreme effort may not be the right next move.
- Limit the "do now" list to what can realistically ship in the stated time horizon.
