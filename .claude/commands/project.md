---
description: One project: budget, who worked on it, unbilled work, invoices, recent time
argument-hint: <project name, code or id>
---

Run:

```
node scripts/billing.mjs project "$ARGUMENTS"
```

If the CLI lists several matches, show them and ask which one. Do not guess.

Present the result like this:

1. Project, client, fee type, status.
2. Budget: hours used against hours budgeted, as a percentage. If it is over 90%, say so in the first line.
3. Money: what the logged time is worth, what it cost, the margin, and what is still unbilled.
4. Hours by person and by task.
5. Expenses, and whether each one has been invoiced.
6. Invoices raised against the project.
7. Recent time entries with their notes. The notes are the part worth reading.
8. Finish with your own read: is this project making money, will it finish inside the budget, what should happen next.

For a fixed fee project, compare the value of the time logged with the fee. That gap is the whole story.

To bill what is sitting there, use `/draft-invoice`.
