---
description: Add a client, a project, a person, a task or an expense
argument-hint: client|project|person|task|expense <details in plain language>
---

Map what the user describes to one of these:

```
node scripts/billing.mjs add client "<name>" [--rate=180] [--terms=14] [--contact=] [--email=] [--currency=NZD]
node scripts/billing.mjs add project "<name>" --client="<client>" [--code=] [--rate=] [--budget-hours=80] [--fee=hourly|fixed|retainer|internal]
node scripts/billing.mjs add person "<full name>" [--role=] [--email=] [--rate=180] [--cost=90] [--capacity=37.5]
node scripts/billing.mjs add task "<name>" [--nonbillable]
node scripts/billing.mjs add expense "<description>" --project="<project>" --amount=120 [--category=] [--on=YYYY-MM-DD] [--nonbillable]
```

Rules:

- Do the pieces in order. A project needs its client to exist first.
- A project with no rate uses the client rate. Set `--rate` only when this project is priced differently.
- Ask for the budget in hours if the user did not give one. A project without a budget cannot go over it, which means `/attention` will never warn about it.
- Fixed fee work: use `--fee=fixed` and set `--budget-hours` to the hours the fee assumes. That is how you find out the fee was too low.
- `--rate=180` means $180 an hour. `--capacity=37.5` means 37.5 hours a week.
- Do not invent rates, emails or budgets. Leave a field out rather than guess.

To put a task on a project at its own rate: `node scripts/billing.mjs assign "<project>" "<task>" --rate=250`.

Confirm each record in one line with its short id.
