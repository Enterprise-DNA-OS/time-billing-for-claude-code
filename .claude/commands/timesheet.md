---
description: This week's time, by day, by person and by project
argument-hint: [person name] [--last]
---

Run:

```
node scripts/billing.mjs timesheet
```

Add `--person="<name>"` if the user named someone, `--last` for last week, or `--from=YYYY-MM-DD --to=YYYY-MM-DD` for any other range.

Present it like this:

1. One line of totals: hours logged, hours billable, the billable share, what it is worth.
2. The day table as returned. Call out any weekday with nothing on it.
3. Hours per person against their capacity. Anyone under half their capacity gets a mention.
4. Hours per project, biggest first.
5. Two or three sentences of your own read: where the week went, which project is eating the time, whether the billable share is where it should be.

If the user asked something specific ("how much did Tom do on Kauri this week"), answer that first with the number, then show the rows behind it.

To see a whole project, use `/project`. To see money not yet invoiced, use `/unbilled`.
