---
name: designer/design-spec
description: Design specification — IA, interactions, components, and accessibility.
---

# Design Spec Operation

Produce a detailed design specification that an engineer can implement.

## Instructions

1. Understand the scope and acceptance criteria
2. Review available inputs — research synthesis, product requirements, existing design docs
3. Define the information architecture — what content exists and how it is organized
4. Specify interaction patterns for each key user flow
5. Inventory all components with their states and variants
6. Define accessibility requirements for each component and flow
7. Document responsive behavior across breakpoints
8. Cover edge cases: empty states, error states, loading states, maximum content, minimum content

## Output Format

```
## Information Architecture
[Hierarchy / sitemap as indented list or table]

## User Flows
### Flow: [Name]
1. [Step] — [what the user sees, what they can do, what happens next]
2. [Step] — ...
- **Error path**: [what happens on failure]
- **Edge case**: [unusual but valid scenario]

## Component Inventory
| Component | States | Variants | Accessibility Notes |
|-----------|--------|----------|-------------------|
| [name]    | default, hover, active, disabled, error | [size/type variants] | [ARIA roles, keyboard behavior] |

## Accessibility Requirements
- Keyboard navigation: [tab order, focus management, shortcuts]
- Screen reader: [ARIA labels, live regions, landmark roles]
- Visual: [contrast ratios, focus indicators, motion preferences]
- Cognitive: [reading level, error recovery, confirmation dialogs]

## Responsive Behavior
| Breakpoint | Layout Change | Component Adaptations |
|-----------|--------------|----------------------|

## Edge Cases
| Scenario | Expected Behavior |
|----------|------------------|
```

## Constraints

- Every component must list all its states — do not omit disabled or error states
- Do not describe visual styling (colors, fonts) — describe structure and behavior
- Do not skip accessibility — it is a required section, not optional
- Specs must be specific enough that two engineers would build the same thing independently
