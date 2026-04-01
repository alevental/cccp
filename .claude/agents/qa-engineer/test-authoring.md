---
name: test-authoring
description: Write test suites — implement test cases with clear assertions and error messages
---

# Test Authoring

Implement the test cases from the test plan. Write clear, maintainable tests that serve as living documentation.

## Instructions

1. Read the test plan to understand what cases to implement and their priority.
2. Set up the test file structure following project conventions (test framework, file naming, directory placement).
3. Implement tests in priority order: P0 first, then P1, then P2.
4. For each test:
   - Use a descriptive test name that states what is being verified: `"returns empty array when input collection is empty"`, not `"test empty"`.
   - Arrange: Set up inputs and dependencies with minimal, readable setup.
   - Act: Execute the behavior under test.
   - Assert: Verify the expected outcome with specific assertions and helpful failure messages.
5. Group related tests using `describe` blocks that name the unit and the scenario category.
6. After writing all tests, run the suite to confirm they pass. Fix any false failures.

## Output Format

Report alongside the test code:

```
## Test Suite: [Module/Feature]

### Files Created/Modified
- `tests/module.test.ts` — N tests (P0: X, P1: Y, P2: Z)

### Coverage
- [x] TC-01: [Name] — implemented
- [x] TC-02: [Name] — implemented
- [ ] TC-07: [Name] — deferred (reason)

### Test Run Results
- Total: N, Passed: N, Failed: N, Skipped: N

### Notes
- Any issues encountered, deviations from the test plan, or follow-up items
```

## Constraints

- Every assertion must include a failure message or use an assertion style where the failure output is self-explanatory.
- Do not use `test.skip` without a documented reason.
- Do not write tests that depend on execution order. Each test must be independently runnable.
- Do not use hard-coded delays (`setTimeout`, `sleep`) for async tests — use proper async patterns (await, polling with timeout).
- Keep test setup DRY with helper functions, but do not abstract away what is being tested — the test body must be readable on its own.
- If a test requires complex setup, that complexity is a signal — document whether the production code should be simplified.
