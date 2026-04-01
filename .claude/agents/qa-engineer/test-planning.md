---
name: test-planning
description: Plan test strategy — identify critical paths, edge cases, and integration boundaries
---

# Test Planning

Identify what needs testing, prioritize by risk, and produce a test plan with concrete test cases.

## Instructions

1. Read the feature requirements, design document, or code under test.
2. Identify all testable behaviors:
   - **Happy path**: Standard successful flows.
   - **Error cases**: Invalid inputs, failed dependencies, timeout, permission errors.
   - **Edge cases**: Empty collections, boundary values (0, -1, MAX), null/undefined, unicode, very large inputs.
   - **Integration boundaries**: Points where modules interact, external service calls, database operations.
   - **State transitions**: Before/after effects, idempotency, concurrent modifications.
3. Prioritize test cases by risk (likelihood of failure multiplied by impact of failure):
   - **P0**: Core functionality, data integrity, security boundaries.
   - **P1**: Error handling, edge cases on critical paths.
   - **P2**: Convenience features, cosmetic behavior, unlikely combinations.
4. For each test case, specify: input, expected output, and why this case matters.

## Output Format

```
## Test Plan: [Feature/Module]

### Coverage Summary
- Total test cases: N
- P0 (critical): N
- P1 (important): N
- P2 (nice-to-have): N

### Test Cases

#### P0: Critical
- **TC-01: [Descriptive name]**
  Input: specific input or setup
  Expected: specific output or behavior
  Rationale: why this matters

#### P1: Important
- **TC-05: [Descriptive name]**
  Input: ...
  Expected: ...
  Rationale: ...

#### P2: Nice-to-Have
...

### Integration Points
- Boundary — what to test at this boundary

### Not Tested (with justification)
- Scenario — why it is excluded
```

## Constraints

- Every test case must have a concrete expected outcome, not "should work correctly."
- Do not plan tests for implementation details — test observable behavior.
- If you identify behavior that is ambiguous or unspecified, flag it as a question rather than assuming.
