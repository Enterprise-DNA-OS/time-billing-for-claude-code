---
description: Billable work that is not on an invoice yet
argument-hint: [client or project name]
---

Run:

```
node scripts/billing.mjs unbilled
```

Pass the name if the user narrowed it: `node scripts/billing.mjs unbilled "kauri"`.

Present it as one list ranked by money, not by date. For each row:

- client and project
- hours and what they are worth, plus expenses
- how old the oldest entry is

Then say the total in one sentence, and name the two or three worth invoicing today. Old work is harder to collect, so anything past 30 days goes to the top of that list whatever its size.

Check the fee type before recommending an invoice. Hours on a fixed fee project are not billed by the hour, they are billed at the milestone. Say that rather than suggesting an invoice that should not be raised.

To raise one, use `/draft-invoice <client>`.
