---
description: Invoice list: what is out, what is overdue, what is still a draft
argument-hint: [draft|sent|paid]
---

Run:

```
node scripts/billing.mjs invoices
```

Add `--status=draft`, `--status=sent` or `--status=paid` if the user asked for one kind, or `--all` to include voided ones.

Present it like this:

1. Three numbers first: owed, overdue, sitting in draft.
2. The overdue invoices, worst first, with the client and how many days late.
3. The rest of the sent invoices with their due dates.
4. Drafts, with a note that a draft collects nothing until it is sent.
5. Your read: how much cash is late, who is the repeat offender, what to do today.

To open one: `node scripts/billing.mjs invoice <number>`. To write a chaser: `/draft-chaser <number>`. To mark one paid: `node scripts/billing.mjs invoice paid <number> --on=YYYY-MM-DD`.

Marking an invoice sent does not email anyone. There is no send path in this repo.
