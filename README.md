<div align="center">

# time-billing-for-claude-code

**The open-source time tracking and invoicing that is just a database and Claude Code.**

Created by [Enterprise DNA](https://www.enterprisedna.co)

[What is this](#what-is-this) · [Why no front end](#why-no-front-end) · [Quick start](#quick-start) · [Your own Postgres](#use-it-with-your-own-postgres-or-supabase) · [The commands](#the-commands) · [Replace Harvest](#replace-harvest) · [Architecture](#architecture) · [Installed for you](#want-it-installed-and-run-for-you)

[![Node 20+](https://img.shields.io/badge/node-%3E%3D20-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-any-4169E1?logo=postgresql&logoColor=white)](https://www.postgresql.org)
[![PGlite](https://img.shields.io/badge/PGlite-embedded-0f766e)](https://pglite.dev)
[![MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

</div>

## What is this

Time tracking and invoicing for a firm that bills by the hour, built from two things: a Postgres database and Claude Code.

The database holds clients, projects, people, tasks, time entries, expenses and invoices. A small Node CLI reads and writes it. Claude Code slash commands drive the CLI, so you run your billing by talking to it:

```
/timesheet                             where did the week go
/log Kauri intake 2h15 "conflict check screens"
/unbilled                              what can go on an invoice today
/attention                             overdue invoices, ageing work, projects past budget
/draft-invoice Kauri Legal             a draft invoice and a covering note, saved to drafts/
/weekly-review                         Monday review: hours, what to bill, what is late
```

Every hour is one row. The questions that decide whether a services business makes money are questions about those rows: what is unbilled, what is over budget, what that fixed fee job really cost, who is slow to pay. You get better answers than a timesheet dashboard, for no per-seat fee, with your data in your own Postgres. It runs on a laptop in 60 seconds with no database install (embedded Postgres via PGlite), or against your own Postgres or Supabase for a team.

## Why no front end

- The front end was the product because the database was hard to talk to. Claude Code makes the database easy to talk to, so the screens are the part you can drop.
- You gain your own questions ("which fixed fee jobs earn under $120 an hour once you count the design time?"), a schema you own, no seat fees, and a weekly prompt to bill the work you already did.
- You give up the stopwatch button, the phone app and the approvals workflow. That is a real trade and it is spelled out in [docs/why-no-front-end.md](docs/why-no-front-end.md).

## Quick start

60 seconds, no database install. Needs Node 20 or newer and [Claude Code](https://claude.com/claude-code).

```bash
git clone https://github.com/Enterprise-DNA-OS/time-billing-for-claude-code.git
cd time-billing-for-claude-code
npm install
npm run demo
```

`npm run demo` creates an embedded database under `.data/`, applies the schema, loads a demo studio with three months of history, then prints the timesheet, the unbilled list and the attention list.

Then open the folder in Claude Code and type:

```
/timesheet
```

Try `/unbilled`, `/attention`, `/project dispatch`, `/weekly-review`. When you are ready for real data, delete `.data/` and start with `/add`, or bring your Harvest export in with `/import`.

Fill in the "Who this works for" block in [CLAUDE.md](CLAUDE.md) so drafts come out in your voice.

## Use it with your own Postgres or Supabase

Set `DATABASE_URL` and every script switches from the embedded database to yours. Same SQL, same commands.

```bash
cp .env.example .env
# edit .env:
# DATABASE_URL=postgresql://postgres:password@db.xxxxxxxxxxxx.supabase.co:5432/postgres
npm run migrate
```

For Supabase: Project Settings > Database > Connection string (URI). Use the direct connection or the session pooler. Both work. Skip `npm run seed` unless you want the demo data in your real database.

A team shares one database. Each person clones the repo, sets the same `DATABASE_URL`, sets `TIMEBILL_PERSON` to their own name so `/log` knows whose time it is, and works in their own Claude Code. There is no per-seat anything.

## The commands

Slash commands live in `.claude/commands/`. Each one tells Claude exactly which CLI call to run and how to present the result.

| Command           | What it does                                                                                         |
| ----------------- | ---------------------------------------------------------------------------------------------------- |
| `/timesheet`      | This week by day, by person against capacity, and by project, with the billable share                |
| `/project <name>` | One project: budget used, hours by person and task, expenses, invoices, recent time, the margin      |
| `/client <name>`  | One client: projects, unbilled work, invoices, how many days they take to pay                        |
| `/log`            | Log time in one sentence. Durations as `90m`, `1.5`, `1:30` or `2h15`                                |
| `/add`            | Add a client, project, person, task or expense from a plain-language description                     |
| `/unbilled`       | Billable work not yet on an invoice, ranked by money, with the age of the oldest entry               |
| `/invoices`       | Owed, overdue and draft in three numbers, then the list, worst first                                 |
| `/attention`      | Overdue invoices, work uninvoiced 30+ days, projects past budget, quiet projects, missing timesheets |
| `/weekly-review`  | Monday review: last week's hours, what to bill, what is late, five things to do. Saved to drafts     |
| `/draft-invoice`  | Rolls unbilled work into a draft invoice and writes a covering note to `drafts/`. Never sends        |
| `/draft-chaser`   | Reads the invoice and the history, drafts a short chaser to `drafts/`. Never sends                   |
| `/import`         | Walks a Harvest export (time, expenses, invoices) through the importer                               |

Under the hood it is one CLI. You can use it directly, and `--json` gives machine output for anything:

```
node scripts/billing.mjs help
node scripts/billing.mjs timesheet --last
node scripts/billing.mjs report --by=task --from=2026-07-01
node scripts/billing.mjs log "Dispatch rebuild" 2h15 --person="Ana Silva" --task=Testing --notes="Edge cases with the depot"
node scripts/billing.mjs project "intake"
node scripts/billing.mjs unbilled
node scripts/billing.mjs invoice draft "Kauri Legal" --through=2026-09-30
node scripts/billing.mjs invoice send INV-1007
node scripts/billing.mjs invoice paid INV-1007 --on=2026-10-14
node scripts/billing.mjs stats --json
node scripts/billing.mjs export --out=backup.json
```

Ids can be shortened to their first 8 characters. Names match case-insensitively. When a name matches more than one record, the CLI lists the candidates and exits 1 instead of guessing.

## Replace Harvest

Export your detailed time report from Harvest as CSV, then:

```
node scripts/billing.mjs import harvest --time=time.csv --expenses=expenses.csv --invoices=invoices.csv
```

The time export alone carries clients, projects, tasks, people, hours, notes and rates. Re-running is safe: rows are matched on their own contents, so nothing doubles up. Sample files in Harvest's export shape are in `examples/harvest/`. The full walkthrough, including what does not carry over, is in [docs/replace-harvest.md](docs/replace-harvest.md).

## Architecture

```
.claude/commands/      slash commands: the operator's vocabulary
CLAUDE.md              who this works for, the routing table, house rules
scripts/
  billing.mjs          the one CLI (timesheet, project, unbilled, invoice, attention, import, export ...)
  migrate.mjs          applies supabase/migrations/*.sql, tracked in schema_migrations
  seed.mjs             loads supabase/seed.sql (idempotent demo data)
  smoke.mjs            npm test: migrate, seed, exercise every command on a temp database
  lib/db.mjs           getDb(): PGlite embedded by default, pg Pool when DATABASE_URL is set
  lib/csv.mjs          tiny CSV parser for the Harvest import
  lib/format.mjs       aligned text tables, money, hours, dates
supabase/
  migrations/0001_time_billing.sql   tables, triggers, starter tasks, four views
  seed.sql                           a demo studio: 6 clients, 7 projects, 181 time entries, 6 invoices
examples/harvest/      three small CSVs in Harvest's export shape
docs/                  replace-harvest.md, why-no-front-end.md
drafts/                where covering notes, chasers and reviews are written (gitignored)
```

The four views are the ones the weekly commands need: `v_project_health` (hours, value, cost, budget used), `v_unbilled` (money on the floor), `v_invoice_status` (totals and days overdue) and `v_attention_due` (everything that wants a decision, in one list).

Plain JavaScript, ESM, no build step, two dependencies (`pg`, `@electric-sql/pglite`).

## Built with Claude Code

This repo was written with Claude Code and is meant to be extended the same way. Want approval before time can be invoiced, a second currency, GST on invoice lines, or an importer for Toggl? Open the folder in Claude Code and ask. The schema is nine tables and four views. A new migration file is the whole change.

`npm test` runs the smoke test on a throwaway database and must print `PASS` before anything merges.

## Contributing

Issues and pull requests are welcome. Keep to the shape of the thing:

- Plain JavaScript, no TypeScript, no build step.
- Every SQL change is a new file in `supabase/migrations/` and must run on both PGlite and Postgres.
- Money in cents and time in minutes, everywhere in the database.
- Every new CLI command gets a line in `help`, a slash command in `.claude/commands/`, and a step in `scripts/smoke.mjs`.
- Prose in plain language. No buzzwords, no hedging.

Run `npm test` before you open a PR.

## Want it installed and run for you?

Enterprise DNA installs this for your business, migrates your Harvest data, wires it to the rest of your tools, and runs it for you as part of Omni, our managed Command Center. One setup fee, then a monthly retainer.

Book a call: https://calendly.com/sam-mckay/discovery-call

Read more: https://enterprisedna.co/omni/instead-of/harvest

## License

MIT. Copyright (c) 2026 Enterprise DNA. See [LICENSE](LICENSE).
