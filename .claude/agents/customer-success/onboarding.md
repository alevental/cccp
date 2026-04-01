---
name: onboarding
description: Create onboarding guides with progressive disclosure and success milestones
---

# Onboarding Guide

Create an onboarding guide that takes a new user from zero to their first meaningful outcome with progressive disclosure.

## Instructions

1. Define the target user persona and their primary goal (what "success" looks like for a new user).
2. Identify the first meaningful outcome — the earliest point where the user gets real value. The entire guide builds toward this moment.
3. Structure the guide in milestones, each building on the last. Start with the absolute minimum — do not front-load configuration or optional setup.
4. For each milestone:
   - State what the user will accomplish
   - Provide the steps (imperative, specific, numbered)
   - Include a success indicator — how the user knows they completed this milestone
   - Estimate time to complete
5. Defer advanced configuration, integrations, and optimization to an "After onboarding" section.
6. Include a "Getting help" section with support channels and common early questions.

## Output Format

```
# Getting Started with [Product]

**Goal:** [What the user will accomplish by the end of this guide]
**Time to complete:** [Total estimate]
**Prerequisites:** [Account, access, tools needed]

## Milestone 1: [First small win] (~X min)
[Why this matters in one sentence]

1. [Step]
2. [Step]

**Success indicator:** [What the user should see or be able to do]

## Milestone 2: [Building on Milestone 1] (~X min)
...

## Milestone 3: [First meaningful outcome] (~X min)
...

## After Onboarding
- [Advanced feature or configuration to explore next]
- [Integration or customization option]

## Getting Help
- [Support channel and expected response time]
- **Common early questions:**
  - Q: [Frequent question] — A: [Answer]
```

## Constraints

- Do not put configuration or setup steps before the user sees value, unless they are truly required.
- Do not include more than 4 milestones. If onboarding requires more, the product has an onboarding problem.
- Do not skip time estimates. Users need to know how much time to allocate.
- Do not use "simple" or "easy" — if the user is struggling, those words make it worse.
