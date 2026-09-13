---
description: Import a Harvest export (time, expenses, invoices) into this database
argument-hint: [path to the folder holding the CSV files]
---

Walk the user through moving off Harvest. Full detail is in `docs/replace-harvest.md`. Read it first.

1. Get the files. In Harvest: Reports, pick the date range, then Export, detailed CSV. Three exports matter:
   - time (the detailed time report)
   - expenses
   - invoices

   Only the time export is required. It carries clients, projects, tasks, people and hours in one file.

2. Check each header row before running anything. The time export needs at least Date, Client, Project and Hours. Name the missing column rather than importing half a file.

3. Say what will happen: how many rows are in each file, how many clients and projects that will create, and that rates come from the Billable Rate column while budgets do not come across at all.

4. Run it:

   ```
   node scripts/billing.mjs import harvest --time="<time.csv>" --expenses="<expenses.csv>" --invoices="<invoices.csv>"
   ```

   Re-running the same files is safe. Rows are matched on their own contents, so nothing doubles up.

5. Harvest's time export does not carry an invoice number, so entries it had already invoiced arrive here as unbilled. The import says how many. Either re-run with `--skip-invoiced`, or filter them out in Harvest before exporting. Decide that with the user, do not pick for them.

6. Then run `node scripts/billing.mjs projects` and set what Harvest did not export: budgets in hours, fee types, and the rate on any project priced differently from its client.

7. Say what did not come across: budgets, approvals, timers, retainer settings, reminders, invoice line detail and attachments. Do not pretend they did.

To try it on sample files first, the ones in `examples/harvest/` are in the shape Harvest exports.
