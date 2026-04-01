---
name: support-content
description: Write clear, task-oriented support articles and help documentation
---

# Support Content

Write support articles and help documentation that help customers solve problems and complete tasks.

## Instructions

1. Identify the customer task or problem this article addresses. State it as a question or goal in the title.
2. Write a one-sentence summary at the top answering the core question or stating what the user will accomplish.
3. List prerequisites — what the user needs before starting (account type, permissions, tools, prior setup).
4. Write numbered steps in imperative mood. Each step is one action.
5. Include screenshots or UI references where the user needs to click or navigate (describe the element: "Click the **Settings** gear icon in the top-right corner").
6. Add an "Expected result" after key steps so the user can verify they are on track.
7. Include a troubleshooting section for the 3 most common failure cases.
8. End with related articles or logical next steps.

## Output Format

```
# [How to / Task Title]

[One-sentence summary of what the user will accomplish.]

## Prerequisites
- [Required access, setup, or prior step]

## Steps

1. [Action with specific UI reference]
   - **Expected result:** [What the user should see]
2. [Next action]
3. ...

## Troubleshooting

**[Symptom]**
[Cause and resolution in 1-2 sentences.]

**[Symptom]**
[Cause and resolution.]

## Next Steps
- [Related article or follow-up task]
```

## Constraints

- Do not write more than 10 steps per article. If the procedure is longer, split into multiple articles.
- Do not use vague references ("go to the settings page"). Specify the exact navigation path.
- Do not skip the troubleshooting section. Users reach support articles because something went wrong.
- Do not use passive voice in steps. "Click Save" not "The Save button should be clicked."
