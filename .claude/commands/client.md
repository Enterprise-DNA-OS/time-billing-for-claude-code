---
description: One client: projects, unbilled work, invoices, how fast they pay
argument-hint: <client name or id>
---

Run:

```
node scripts/billing.mjs client "$ARGUMENTS"
```

If the CLI lists several matches, show them and ask which one.

Present the result like this:

1. Client, contact, rate, payment terms.
2. Money in three numbers: unbilled work, sent and unpaid, overdue.
3. Projects with hours, budget used and unbilled value.
4. Unbilled work by project, oldest first.
5. Invoices, newest first, with days overdue where it applies.
6. Your own read: how much of the month this client is, whether they pay on time, and whether anything needs a conversation before more work goes in.

If they have an overdue invoice, offer `/draft-chaser`. If they have unbilled work older than a month, offer `/draft-invoice`.
