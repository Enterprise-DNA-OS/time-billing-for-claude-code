---
description: Monday review: last week's hours, what to bill, what is late, what to fix
---

Run all three, in order:

```
node scripts/billing.mjs timesheet --last --json
node scripts/billing.mjs unbilled --json
node scripts/billing.mjs attention --json
```

Then write the review in this exact shape. Plain language, short sentences, no filler.

**Last week**
Hours logged, hours billable, the billable share, what the week was worth. Hours per person against capacity. One sentence on whether that is enough to hit the month.

**What to bill this week**
Projects with unbilled work, biggest first, with the age of the oldest entry. Name the ones to invoice now and say why. If nothing is ready, say so.

**What is late**
Overdue invoices with the client, the amount and the days. Total at the end.

**Where the money is leaking**
Projects at or past budget, projects with no time logged in two weeks, and any project whose cost is close to what it will bill. One line each.

**Five things to do this week**
Exactly five, ranked, each one sentence with a name attached. Pull from the lists above. If there are fewer than five worth doing, list fewer and say why.

Save the review to `drafts/weekly-review-YYYY-MM-DD.md` (today's date) and show it in full. Do not change any records while writing it. If the user then wants to act, use `/draft-invoice`, `/draft-chaser` and `/log`.
