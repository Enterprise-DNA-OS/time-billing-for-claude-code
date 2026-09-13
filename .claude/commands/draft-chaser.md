---
description: Draft a short chaser for an overdue invoice, saved to drafts/, never sent
argument-hint: <invoice number, or client name>
---

This command writes a draft. It never sends anything.

Steps:

1. Read the invoice and the relationship first:

   ```
   node scripts/billing.mjs invoice "$ARGUMENTS"
   node scripts/billing.mjs client "<the client on it>"
   ```

   Note the amount, the due date, the days overdue, whether this client is usually late, and whether more work has gone in since.

2. Read the "Who this works for" block in `CLAUDE.md` for the operator's name, business and voice.

3. Write the chaser:
   - Subject: the invoice number and what it was for. No "Reminder" and no "Just following up".
   - 50 to 100 words. Two short paragraphs.
   - Open with the work, not the debt. One line on what the invoice covered.
   - State the number, the date it was due and how many days ago that was.
   - One clear ask: pay by a named date, or tell us what is holding it up.
   - No threats, no apology for asking, no exclamation marks.
   - Sign off with the operator's first name.

4. If the invoice is more than 30 days late, add one line offering to talk it through on the phone. If it is more than 60, say plainly that new work is on hold until it is settled, and check with the operator before including that line.

5. Save to `drafts/chaser-<invoice-number>-YYYY-MM-DD.md` in this shape:

   ```
   To: <contact and email>
   Subject: <subject>

   <body>

   ---
   Context used: <the invoice, its age, and anything from the client history that shaped it>
   ```

Show the draft in full and say where it was saved. Offer to mark the invoice paid once the money lands.
