#!/usr/bin/env node
// End-to-end smoke test on a throwaway embedded database.
// Runs migrate, seed, then every CLI command that matters, and asserts on the JSON.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = mkdtempSync(path.join(tmpdir(), 'timebill-smoke-'));
const env = { ...process.env, TIMEBILL_DATA_DIR: dataDir };
delete env.DATABASE_URL; // the smoke test always runs embedded
delete env.TIMEBILL_PERSON;

let step = 0;
function run(label, args, { json = true, expectFail = false } = {}) {
  step++;
  const argv = [path.join(root, 'scripts', args[0]), ...args.slice(1), ...(json ? ['--json'] : [])];
  const res = spawnSync(process.execPath, argv, { cwd: root, env, encoding: 'utf8' });
  const ok = expectFail ? res.status !== 0 : res.status === 0;
  if (!ok) {
    console.error(`\nFAIL step ${step} (${label}): exit ${res.status}\n--- stdout\n${res.stdout}\n--- stderr\n${res.stderr}`);
    process.exit(1);
  }
  console.log(`  ok  ${String(step).padStart(2)}  ${label}`);
  if (!json || expectFail) return { stdout: res.stdout, stderr: res.stderr };
  try {
    return JSON.parse(res.stdout);
  } catch {
    console.error(`\nFAIL step ${step} (${label}): output is not JSON\n${res.stdout}\n${res.stderr}`);
    process.exit(1);
  }
}

function assert(cond, msg) {
  if (!cond) {
    console.error(`\nFAIL assertion: ${msg}`);
    process.exit(1);
  }
}

const n = (v) => Number(v ?? 0);
const iso = (d) => d.toISOString().slice(0, 10);
const todayIso = iso(new Date());
const longAgo = iso(new Date(Date.now() - 120 * 86400000));

console.log(`smoke: data dir ${dataDir}`);
try {
  run('migrate', ['migrate.mjs'], { json: false });
  run('migrate again (idempotent)', ['migrate.mjs'], { json: false });
  run('seed', ['seed.mjs'], { json: false });
  run('seed again (idempotent)', ['seed.mjs'], { json: false });

  // ---- reads -------------------------------------------------------------

  const sheet = run('timesheet (whole history)', ['billing.mjs', 'timesheet', `--from=${longAgo}`, `--to=${todayIso}`]);
  assert(sheet.totals.minutes > 20000, `a lot of time is logged (${sheet.totals.minutes} minutes)`);
  assert(sheet.people.length === 4, 'four people on the timesheet');
  assert(sheet.totals.billable_pct > 80 && sheet.totals.billable_pct < 100, `billable share is realistic (${sheet.totals.billable_pct}%)`);
  assert(sheet.projects.length >= 6, 'every project shows up');

  const week = run('timesheet (this week, the default)', ['billing.mjs', 'timesheet']);
  assert(week.entries.length >= 1, 'the current week always has entries');

  const byClient = run('report by client', ['billing.mjs', 'report', '--by=client', `--from=${longAgo}`]);
  assert(byClient.rows.length >= 5, 'five clients or more in the report');
  assert(byClient.totals.margin_cents > 0, 'the studio makes money');
  const byPerson = run('report by person', ['billing.mjs', 'report', '--by=person', `--from=${longAgo}`]);
  assert(byPerson.rows.length === 4, 'four people in the report');
  run('report rejects a bad grouping', ['billing.mjs', 'report', '--by=colour'], { json: false, expectFail: true });

  const projects = run('projects', ['billing.mjs', 'projects']);
  assert(projects.length === 6, `six active projects (${projects.length})`);
  assert(projects.some((p) => n(p.budget_pct) > 100), 'at least one project is past its budget');
  const all = run('projects --all', ['billing.mjs', 'projects', '--all']);
  assert(all.length === 7, 'the archived project shows with --all');

  const dispatch = run('project by name', ['billing.mjs', 'project', 'dispatch']);
  assert(dispatch.project.name === 'Dispatch rebuild', 'resolved the dispatch project');
  assert(dispatch.by_person.length === 3, 'three people worked on it');
  assert(dispatch.by_task.length >= 4, 'several tasks');
  assert(n(dispatch.health.unbilled_cents) > 0, 'it has unbilled work');
  assert(dispatch.invoices.length >= 1, 'it has been invoiced before');
  assert(dispatch.expenses.length === 2, 'it has two expenses');

  const byPrefix = run('project by id prefix', ['billing.mjs', 'project', dispatch.project.id.slice(0, 8)]);
  assert(byPrefix.project.id === dispatch.project.id, 'id prefix resolves');

  const ambiguous = run('ambiguous project exits 1', ['billing.mjs', 'project', 're'], { json: false, expectFail: true });
  assert(/matches \d+ projects/.test(ambiguous.stderr), 'ambiguity lists the candidates');

  const clients = run('clients', ['billing.mjs', 'clients']);
  assert(clients.length === 6, `six clients (${clients.length})`);
  const kauri = run('client', ['billing.mjs', 'client', 'kauri']);
  assert(kauri.client.name === 'Kauri Legal', 'resolved Kauri Legal');
  assert(n(kauri.stats.overdue_cents) > 0, 'Kauri has an overdue invoice');
  assert(n(kauri.stats.unbilled_cents) > 0, 'Kauri has unbilled work');
  assert(kauri.projects.length === 1 && kauri.invoices.length === 1, 'one project, one invoice');

  const team = run('team', ['billing.mjs', 'team']);
  assert(team.length === 4, 'four people');
  const jack = team.find((p) => p.full_name === 'Jack Doyle');
  assert(jack && jack.minutes_7d === 0, 'Jack has logged nothing this week, which is the point of him');

  const tasks = run('tasks', ['billing.mjs', 'tasks']);
  assert(tasks.length >= 7, 'the starter tasks are there');
  assert(tasks.some((t) => n(t.minutes) > 0), 'tasks have hours against them');

  const unbilled = run('unbilled', ['billing.mjs', 'unbilled']);
  assert(unbilled.rows.length >= 3, 'several projects have unbilled work');
  assert(n(unbilled.totals.total_cents) > 2000000, 'there is real money sitting there');
  const unbilledOne = run('unbilled filtered', ['billing.mjs', 'unbilled', 'kauri']);
  assert(unbilledOne.rows.length === 1, 'filter narrows it to one project');

  const invoices = run('invoices', ['billing.mjs', 'invoices']);
  assert(invoices.rows.length === 6, `six invoices (${invoices.rows.length})`);
  assert(n(invoices.totals.overdue_cents) > 0, 'one is overdue');
  assert(n(invoices.totals.draft_cents) > 0, 'one is a draft');
  const sent = run('invoices --status=sent', ['billing.mjs', 'invoices', '--status=sent']);
  assert(sent.rows.every((r) => r.status === 'sent'), 'status filter works');
  const overdue = run('one invoice', ['billing.mjs', 'invoice', 'INV-1004']);
  assert(overdue.lines.length >= 1, 'the invoice has lines');
  assert(n(overdue.status.days_overdue) > 0, 'it is past due');
  assert(n(overdue.covers.minutes) > 0, 'it covers real time entries');

  const attention = run('attention', ['billing.mjs', 'attention']);
  const reasons = new Set(attention.map((a) => a.reason));
  for (const reason of ['invoice_overdue', 'unbilled_ageing', 'budget_risk', 'project_quiet', 'timesheet_gap']) {
    assert(reasons.has(reason), `attention finds ${reason}`);
  }

  const stats = run('stats', ['billing.mjs', 'stats']);
  assert(n(stats.unbilled_cents) > 0 && n(stats.overdue_cents) > 0, 'stats sees the money');
  assert(n(stats.effective_rate_cents) > 10000, 'effective rate is sane');
  assert(n(stats.utilisation_pct_last_30d) > 10, 'utilisation is calculated');

  // ---- writes ------------------------------------------------------------

  const client = run('add client', ['billing.mjs', 'add', 'client', 'Smoke Test Co', '--rate=200', '--terms=7', '--contact=Casey Tester']);
  assert(n(client.default_rate_cents) === 20000 && n(client.payment_terms_days) === 7, 'client rate and terms');
  run('duplicate client is refused', ['billing.mjs', 'add', 'client', 'Smoke Test Co'], { json: false, expectFail: true });

  const person = run('add person', ['billing.mjs', 'add', 'person', 'Robin Smoke', '--role=Contractor', '--rate=150', '--cost=80', '--capacity=20']);
  assert(n(person.weekly_capacity_minutes) === 1200, 'capacity in hours becomes minutes');

  const project = run('add project', ['billing.mjs', 'add', 'project', 'Smoke build', '--client=Smoke Test Co', '--code=SMK-01', '--budget-hours=10']);
  assert(n(project.budget_minutes) === 600, 'ten hour budget');
  const task = run('add task', ['billing.mjs', 'add', 'task', 'Smoke checking']);
  const assigned = run('assign task to project', ['billing.mjs', 'assign', 'Smoke build', 'Smoke checking', '--rate=250']);
  assert(n(assigned.bill_rate_cents) === 25000, 'the task carries its own rate on this project');

  const e1 = run('log hours as h:mm', ['billing.mjs', 'log', 'Smoke build', '1:45', '--person=Robin Smoke', '--notes=First slice']);
  assert(n(e1.entry.minutes) === 105, '1:45 is 105 minutes');
  assert(n(e1.entry.bill_rate_cents) === 20000, 'the client rate applied');
  assert(n(e1.value_cents) === 35000, '1.75h at $200 is $350');
  const e2 = run('log hours as minutes', ['billing.mjs', 'log', 'Smoke build', '90m', '--person=Robin Smoke', '--task=Smoke checking']);
  assert(n(e2.entry.minutes) === 90 && n(e2.entry.bill_rate_cents) === 25000, 'the task rate beats the client rate');
  const e3 = run('log hours as 2h15', ['billing.mjs', 'log', 'Smoke build', '2h15', '--person=Robin Smoke', '--on=2026-01-06']);
  assert(n(e3.entry.minutes) === 135, '2h15 is 135 minutes');
  const e4 = run('log non-billable time', ['billing.mjs', 'log', 'Smoke build', '0.5', '--person=Robin Smoke', '--nonbillable']);
  assert(e4.entry.billable === false && n(e4.entry.bill_rate_cents) === 0, 'non-billable time is worth nothing');
  run('a bad duration is refused', ['billing.mjs', 'log', 'Smoke build', 'ages', '--person=Robin Smoke'], { json: false, expectFail: true });
  run('log without a person is refused when several exist', ['billing.mjs', 'log', 'Smoke build', '1'], { json: false, expectFail: true });

  const expense = run('add expense', ['billing.mjs', 'add', 'expense', 'Test SIM card', '--project=Smoke build', '--amount=45.50', '--category=Hardware']);
  assert(n(expense.amount_cents) === 4550, 'dollars and cents');

  const smokeUnbilled = run('the new work shows as unbilled', ['billing.mjs', 'unbilled', 'Smoke build']);
  assert(smokeUnbilled.rows.length === 1, 'one project');
  assert(n(smokeUnbilled.rows[0].time_cents) === 35000 + 37500 + 45000, 'unbilled time is the three billable entries');
  assert(n(smokeUnbilled.rows[0].total_cents) === 117500 + 4550, 'the expense is in there too');

  const draft = run('draft an invoice', ['billing.mjs', 'invoice', 'draft', 'Smoke Test Co']);
  assert(draft.invoice.status === 'draft', 'it is a draft');
  assert(n(draft.totals.total_cents) === 122050, `invoice total (${draft.totals.total_cents})`);
  assert(draft.lines.length === 3, 'time grouped into two lines by task and rate, plus the expense');
  const emptyAgain = run('nothing left to invoice', ['billing.mjs', 'invoice', 'draft', 'Smoke Test Co'], { json: false, expectFail: true });
  assert(/Nothing to invoice/.test(emptyAgain.stderr), 'the second draft says why');

  const shown = run('read the draft back', ['billing.mjs', 'invoice', draft.invoice.number]);
  assert(n(shown.status.total_cents) === 122050, 'the view agrees with the draft');
  assert(n(shown.covers.minutes) === 330, 'it covers 5.5 hours of time');

  const sentInv = run('mark it sent', ['billing.mjs', 'invoice', 'send', draft.invoice.number]);
  assert(sentInv.status === 'sent' && sentInv.sent_at, 'sent');
  const paid = run('mark it paid', ['billing.mjs', 'invoice', 'paid', draft.invoice.number]);
  assert(paid.status === 'paid' && n(paid.paid_amount_cents) === 122050, 'paid in full');

  const voided = run('void it', ['billing.mjs', 'invoice', 'void', draft.invoice.number]);
  assert(voided.status === 'void', 'void');
  assert(n(voided.released_time_entries) === 3 && n(voided.released_expenses) === 1, 'voiding releases the work');
  const back = run('the work is unbilled again', ['billing.mjs', 'unbilled', 'Smoke build']);
  assert(n(back.rows[0].total_cents) === 122050, 'all of it came back');

  const archived = run('archive the project', ['billing.mjs', 'archive', 'Smoke build']);
  assert(archived.status === 'archived', 'archived');
  assert(n(archived.unbilled_cents) === 122050, 'archiving warns about unbilled work');
  const reopened = run('activate it again', ['billing.mjs', 'activate', 'Smoke build']);
  assert(reopened.status === 'active', 'active');

  // ---- import and export --------------------------------------------------

  const ex = path.join(root, 'examples', 'harvest');
  const imp = run('import harvest', [
    'billing.mjs', 'import', 'harvest',
    `--time=${path.join(ex, 'time.csv')}`,
    `--expenses=${path.join(ex, 'expenses.csv')}`,
    `--invoices=${path.join(ex, 'invoices.csv')}`,
  ]);
  assert(imp.clients.created === 4, `four clients imported (${imp.clients.created})`);
  assert(imp.projects.created === 5, `five projects imported (${imp.projects.created})`);
  assert(imp.people.created === 3, `three people imported (${imp.people.created})`);
  assert(imp.time_entries.created === 15, `fifteen time entries imported (${imp.time_entries.created})`);
  assert(imp.expenses.created === 3 && imp.invoices.created === 2, 'expenses and invoices imported');
  assert(imp.already_invoiced === 5, 'it says how many entries Harvest had already invoiced');

  const imp2 = run('import again (idempotent)', [
    'billing.mjs', 'import', 'harvest',
    `--time=${path.join(ex, 'time.csv')}`,
    `--expenses=${path.join(ex, 'expenses.csv')}`,
    `--invoices=${path.join(ex, 'invoices.csv')}`,
  ]);
  assert(imp2.time_entries.created === 0 && imp2.time_entries.updated === 15, 're-import creates nothing new');
  assert(imp2.clients.created === 0 && imp2.projects.created === 0, 'no duplicate clients or projects');

  const imported = run('an imported project reads back', ['billing.mjs', 'project', 'Lease review portal']);
  assert(imported.project.code === 'RAN-01', 'the project code came across');
  assert(n(imported.health.minutes) === 1155, `19.25 hours imported (${imported.health.minutes} minutes)`);
  assert(n(imported.health.billable_cents) === 316625, `billable value from Harvest rates (${imported.health.billable_cents})`);
  const importedInvoice = run('an imported invoice reads back', ['billing.mjs', 'invoice', 'INV-2041']);
  assert(importedInvoice.invoice.status === 'paid', 'a paid Harvest invoice stays paid');
  assert(n(importedInvoice.status.total_cents) === 196625, 'the invoice total came across');

  const dump = run('export', ['billing.mjs', 'export']);
  assert(dump.clients.length >= 11, 'export carries every client');
  assert(dump.time_entries.length >= 190, 'export carries every time entry');
  assert(dump.invoice_lines.length >= 20, 'export carries the invoice lines');
  const outFile = path.join(dataDir, 'export.json');
  const written = run('export to a file', ['billing.mjs', 'export', `--out=${outFile}`]);
  assert(existsSync(outFile) && JSON.parse(readFileSync(outFile, 'utf8')).clients.length === dump.clients.length, 'the file matches');
  assert(n(written.counts.projects) >= 12, 'the report counts what it wrote');

  // ---- the human-readable side --------------------------------------------

  run('timesheet (text)', ['billing.mjs', 'timesheet'], { json: false });
  run('projects (text)', ['billing.mjs', 'projects'], { json: false });
  run('unbilled (text)', ['billing.mjs', 'unbilled'], { json: false });
  run('attention (text)', ['billing.mjs', 'attention'], { json: false });
  run('stats (text)', ['billing.mjs', 'stats'], { json: false });
  run('client (text)', ['billing.mjs', 'client', 'harbourline'], { json: false });
  run('help', ['billing.mjs', 'help'], { json: false });
  run('an unknown command exits 1', ['billing.mjs', 'nonsense'], { json: false, expectFail: true });

  console.log('\nPASS');
} finally {
  if (existsSync(dataDir)) {
    try {
      rmSync(dataDir, { recursive: true, force: true });
    } catch {
      // Windows can hold the handle briefly; a leftover temp dir is harmless.
    }
  }
}
