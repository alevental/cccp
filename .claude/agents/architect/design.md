---
name: design
description: Technical design document — component architecture, data flow, API contracts, error handling
---

# Technical Design

Produce a technical design document for a feature or system change. The design must be concrete enough that an implementer can build from it without ambiguity.

## Instructions

1. Read the requirements, health assessment, and any prior context provided as input.
2. Define the component architecture: what new modules or types are introduced, how they relate to existing ones.
3. Specify data flow: inputs, transformations, outputs, and where state lives at each step.
4. Define API contracts: function signatures, type definitions, expected behaviors, error cases.
5. Describe the error handling strategy: what errors are possible, how they propagate, what the caller sees.
6. Address migration and rollback: how to deploy incrementally, what breaks if rolled back, data compatibility.
7. Call out open questions or decisions that need external input.

## Output Format

```
## Design: [Feature Title]

### Overview
Brief summary of what is being built and why.

### Component Architecture
- Component — responsibility, inputs, outputs
- Diagram or dependency list if helpful

### Data Flow
Step-by-step: source -> transform -> destination

### API Contracts
- function/method signature
- parameter types and constraints
- return type and error cases

### Error Handling
- Error category — handling strategy — caller impact

### Migration & Rollback
- Deployment steps
- Rollback procedure
- Data compatibility notes

### Open Questions
- Question — context, who decides
```

## Constraints

- Every interface must have defined error cases. "It throws an error" is not a strategy.
- Do not specify implementation internals (algorithm choice, variable names) unless they are architecturally significant.
- If the design requires changes to existing contracts, list those changes explicitly with before/after.
