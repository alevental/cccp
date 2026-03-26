# Evaluation Template

Reference template for evaluator agents. Every evaluator agent writes an evaluation
after reviewing a generator's output against the contract.

## Template

```markdown
## Evaluation: [sub-stage name]

### Criterion Results

| # | Criterion | Result | Evidence |
|---|-----------|--------|----------|
| 1 | [from contract] | PASS/FAIL | [specific finding with evidence] |
| 2 | [from contract] | PASS/FAIL | [specific finding with evidence] |

### Overall: PASS / FAIL

Any single criterion FAIL = overall FAIL. No exceptions.

### Iteration Guidance (if FAIL)

1. [Specific, actionable fix with file/line references where applicable]
2. [Specific, actionable fix with file/line references where applicable]

### Iteration: [current] of [max from contract]
```

## Guidance for Evaluators

- **Grade against the contract, not your preferences.** The contract defines success.
  If something isn't in the contract, it's not grounds for failure.
- **Evidence is mandatory.** Every PASS and FAIL must cite specific evidence — file paths,
  line numbers, code snippets, observable behavior. "Looks good" is not evidence.
- **Be skeptical.** When in doubt, FAIL and provide specific iteration guidance.
- **Iteration guidance must be actionable.** "Improve quality" is not guidance.
  "Line 45 of service.ts: the error handler swallows the exception without logging —
  add error propagation" is guidance.
- **The overall field is the only thing the orchestrator reads.** Make it accurate.
  The orchestrator routes based on PASS/FAIL — it never interprets criterion details.
