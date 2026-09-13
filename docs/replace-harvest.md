# Replace Harvest

Moving your time and invoicing history out of Harvest and into this database. Fifteen minutes, three CSV files, one command.

## 1. Export from Harvest

Three exports matter. Only the first is required.

**Time (required).** Reports > Time. Set the date range to cover everything you want to keep ("All time" if you are leaving). Filter by nothing. Click Export, then "Detailed time report (CSV)". You get one row per time entry with the client, project, task, person, hours, notes and rates on it.

**Expenses.** Reports > Expenses, same date range, Export, detailed CSV.

**Invoices.** Invoices > All invoices, then Export. You get one row per invoice with its number, client, dates, amount and status.

Sample files in the same shape are in `examples/harvest/` if you want to see what the importer expects before you export anything.

## 2. Run the import

```bash
node scripts/billing.mjs import harvest --time=time.csv --expenses=expenses.csv --invoices=invoices.csv
```

Or through Claude Code:

```
/import
```

It prints what it created. Re-running the same files is safe: rows are matched on their own contents, so a second run updates instead of duplicating.

Invoices are imported first, so time entries can point at them.

## 3. What maps to what

| Harvest column                    | Here                                                     |
| --------------------------------- | -------------------------------------------------------- |
| Client                            | `clients.name` (created if new)                          |
| Project, Project Code             | `projects.name`, `projects.code` (created if new)        |
| Task                              | `tasks.name`, and the task is assigned to the project    |
| First Name, Last Name             | `people.full_name` (created if new)                      |
| Date                              | `time_entries.spent_on`                                  |
| Hours                             | `time_entries.minutes` (hours x 60, rounded)             |
| Notes                             | `time_entries.notes`                                     |
| Billable?                         | `time_entries.billable`                                  |
| Billable Rate                     | `time_entries.bill_rate_cents`, and the project rate if the project has none |
| Cost Rate                         | `time_entries.cost_rate_cents`                           |
| Currency                          | `clients.currency` (the three letter code is taken from Harvest's long name) |
| Expense Category, Notes, Total Cost | `expenses.category`, `expenses.description`, `expenses.amount_cents` |
| Invoice ID                        | `invoices.number`, prefixed `INV-`                       |
| Issue Date, Due Date, Paid Date   | `invoices.issued_on`, `due_on`, `paid_at`                |
| Invoice Status                    | `invoices.status`: Paid is paid, Draft is draft, Closed is void, anything else is sent |
| Invoice Amount                    | one `invoice_lines` row of kind `fixed`                  |

## 4. The one thing to decide

Harvest's detailed time export has an `Invoiced?` column but no invoice number. There is no way to tell which invoice a given hour went on, so the importer brings those hours in as **unbilled**, and tells you how many.

Two ways to handle it:

- **Re-run with `--skip-invoiced`.** The already-billed hours are left out. Your history is shorter but your unbilled list is right on day one. This is the usual choice.
- **Import everything, then raise one invoice covering the old work and void it.** Voiding releases the time again, so that does not help. If you want the full history and a clean unbilled list, import everything with `--skip-invoiced`, then import again without it into a second database you keep for reporting.

Either way, check `node scripts/billing.mjs unbilled` before you invoice anybody.

## 5. What does not carry over

Say this out loud before you switch, because these are the things people miss on day three.

- **Budgets.** Harvest does not put project budgets in the export. Set them yourself: `node scripts/billing.mjs add project` uses `--budget-hours`, and for existing projects it is one `update projects set budget_minutes = ...` in SQL, or ask Claude Code to do it. Without a budget, nothing warns you when a job runs long.
- **Fee types.** Every imported project arrives as hourly. Mark the fixed fee and retainer ones, or `/attention` will tell you to invoice work that is already covered by a fee.
- **Timers.** There is no stopwatch here. Time is logged after the fact, in one sentence.
- **Approvals.** Harvest timesheet approval and expense approval have no equivalent. If you need a lock, add an `approved_at` column and a migration.
- **Invoice line detail.** An imported invoice arrives as a single line for its total. New invoices raised here have proper lines by project, task and rate.
- **Payments and reminders.** Card payments, Stripe and PayPal links, and automatic reminders stay with Harvest. Here you mark an invoice paid and the chaser is a draft you send yourself.
- **Attachments, receipts and screenshots.** Files stay in Harvest. Export anything you need to keep before you close the account.
- **Integrations.** Anything Harvest was pushing into Xero, QuickBooks or Slack stops. Enterprise DNA wires those up in the installed version.

## 6. After the import

```bash
node scripts/billing.mjs projects          # set the budgets and fee types that did not come across
node scripts/billing.mjs team              # check rates and weekly capacity per person
node scripts/billing.mjs clients           # check payment terms
node scripts/billing.mjs unbilled          # what you can invoice this week
node scripts/billing.mjs attention         # what is already late
```

Then set `TIMEBILL_PERSON` in `.env` to your own name so `/log` does not have to ask, fill in the "Who this works for" block in `CLAUDE.md`, and run `/weekly-review` on Monday.

Keep the Harvest account open and read-only for a month. It costs one seat and it settles arguments.
