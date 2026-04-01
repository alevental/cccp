---
name: feedback-synthesis
description: Synthesize customer feedback into themes with frequency, severity, and recommendations
---

# Feedback Synthesis

Synthesize customer feedback from multiple sources into actionable themes with clear evidence and recommendations.

## Instructions

1. Read all provided feedback sources — support tickets, NPS comments, survey responses, call transcripts, community posts, churn reasons.
2. Tag each piece of feedback with:
   - **Category**: Feature request, bug report, UX friction, documentation gap, pricing concern, praise
   - **Severity**: How much does this block the customer's goal? (Critical / High / Medium / Low)
   - **Segment**: Customer type, plan tier, use case, or tenure if identifiable
3. Group tagged feedback into themes. A theme requires at least 3 data points to qualify.
4. Rank themes by a composite of frequency and severity — a rare critical issue ranks above a frequent minor annoyance.
5. For each theme, include 2-3 representative quotes verbatim.
6. Produce specific, actionable recommendations tied to themes.
7. Identify segment-specific patterns (e.g., enterprise customers care about X, new users struggle with Y).

## Output Format

```
## Feedback Summary
- **Sources reviewed:** [count by type]
- **Total data points:** [N]
- **Period:** [date range]

## Top Themes

### 1. [Theme Name]
- **Frequency:** [N of total] ([%])
- **Severity:** [Critical/High/Medium/Low]
- **Segments affected:** [Which customer segments]
- **Representative quotes:**
  - "[Verbatim quote]" — [Source type, segment]
  - "[Verbatim quote]" — [Source type, segment]
- **Recommendation:** [Specific action]

### 2. [Theme Name]
...

## Segment Patterns
| Segment | Top Concern | Frequency | Unique Insight |
|---------|------------|-----------|----------------|

## Positive Signals
- [What customers consistently praise — do not lose this]

## Recommended Actions
| Priority | Action | Addresses Theme | Expected Impact |
|----------|--------|----------------|-----------------|
```

## Constraints

- Do not present a theme with fewer than 3 supporting data points.
- Do not editorialize or paraphrase quotes unless clearly marked as paraphrased.
- Do not ignore positive feedback. Understanding what works is as important as what is broken.
- Do not recommend actions without tying them to specific themes and evidence.
- Do not treat all customer segments as homogeneous. Segment-level patterns drive better decisions.
