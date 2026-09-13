---
description: Draft an invoice from unbilled work, plus a covering note, saved to drafts/
argument-hint: <client> [project]
---

This command creates a draft invoice in the database and writes a covering note to `drafts/`. It never sends anything. There is no send path in this repo and you must not create one.

Steps:

1. Look before you bill:

   ```
   node scripts/billing.mjs unbilled "<client>"
   node scripts/billing.mjs client "<client>"
   ```

   Read the fee types. Hourly and retainer work bills as it stands. Fixed fee work bills at the milestone, whatever the hours say. If a fixed fee project is in the list, ask what to bill rather than billing the hours.

2. Show the user what is about to go on the invoice: projects, hours, expenses, the total, and the period it covers. Wait for a yes.

3. Raise it:

   ```
   node scripts/billing.mjs invoice draft "<client>" [--project="<project>"] [--through=YYYY-MM-DD] [--subject="<subject>"]
   ```

   The entries and expenses on it are marked as invoiced. Voiding it later puts them back.

4. Write the covering note to `drafts/invoice-<number>-<client-slug>.md`:

   ```
   To: <client contact and email>
   Subject: Invoice <number>, <what it covers>

   <two or three sentences: what the work was, the period, the total, the due date. Reference something specific from the project notes so it does not read like a form letter.>

   ---
   Lines: <the invoice lines, one per row>
   ```

5. Show the invoice and the note in full. Say the number, the total and the due date. Tell the user it is a draft and hand them the two commands they need next:

   ```
   node scripts/billing.mjs invoice send <number>
   node scripts/billing.mjs invoice paid <number> --on=YYYY-MM-DD
   ```

Never invent hours, rates or line items. Everything on an invoice comes out of the database.
