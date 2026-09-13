---
description: What needs a decision: overdue invoices, ageing work, budget risk, quiet projects
---

Run:

```
node scripts/billing.mjs attention
```

The CLI returns five kinds of row: overdue invoices, billable work uninvoiced for 30 days or more, projects at or past their hours budget, active projects with no time logged in 14 days, and people who have not filled in a timesheet for 5 days.

Present it as one ranked action list, not five tables. For each item:

- what it is and whose it is
- the money involved
- how long it has been like that
- the one thing to do about it, in a few words

Rank by money first, then by age. An overdue invoice outranks ageing work of the same size, because the work is done and the client already agreed to pay.

Close with the two numbers that matter: total overdue, and total old work still uninvoiced.

The next step for each item is one of: `/draft-chaser` for an overdue invoice, `/draft-invoice` for ageing work, `/project` for a budget problem, a phone call for a quiet project.

If the list is empty, say so in one line.
