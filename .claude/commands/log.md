---
description: Log time against a project in plain language
argument-hint: <project> <duration> [what you did]
---

The user will describe work in plain language. Examples:

- "two hours on the Kauri intake build, conflict check screens"
- "log 45 minutes support for Harbourline"
- "I did 3.5 on the dispatch rebuild yesterday, testing"

Turn it into one CLI call:

```
node scripts/billing.mjs log "<project>" <duration> --person="<who>" [--task="<task>"] [--on=YYYY-MM-DD] [--notes="<what they said>"]
```

Rules:

- Durations take any of these shapes: `90m`, `1.5`, `1:30`, `2h15`.
- Leave `--person` off only when there is one person in the database. Otherwise pass the operator's name from CLAUDE.md, or ask.
- Pick the task from the words used. Built, wrote or fixed means Development. Met, call or status means Project management. Drew, layout or screens means Design. Tested or checked means Testing. Helped them means Support. If nothing fits, leave the task off rather than inventing one.
- Turn relative dates into YYYY-MM-DD and say which date you used.
- Keep the note in the user's words. Fix dictation typos, add nothing.
- Use `--nonbillable` when the user says it is not chargeable, or when the project is internal.
- If the project does not exist, ask whether to add it with `/add`, then log.

Confirm in one line: hours, project, task, date, and what it is worth.
