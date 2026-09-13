#!/usr/bin/env node
// time-billing-for-claude-code: the one CLI. Claude Code slash commands call this; so can you.
//
//   node scripts/billing.mjs <command> [args] [--flags] [--json]
//
// Run with no arguments (or `help`) for the command list.

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { getDb } from './lib/db.mjs';
import { parseCsv, pick, yesNo } from './lib/csv.mjs';
import { table, money, clock, isoDate, weekday, short, truncate, heading, bar } from './lib/format.mjs';

// ---------------------------------------------------------------------------
// Argument parsing

const BOOL_FLAGS = new Set(['json', 'help', 'all', 'nonbillable', 'billable', 'last', 'dry-run', 'open', 'skip-invoiced']);

function parseArgv(argv) {
  const args = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') {
      flags.help = true;
      continue;
    }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > -1) {
        flags[a.slice(2, eq)] = a.slice(eq + 1);
      } else {
        const name = a.slice(2);
        const next = argv[i + 1];
        if (BOOL_FLAGS.has(name) || next === undefined || next.startsWith('--')) flags[name] = true;
        else flags[name] = argv[++i];
      }
    } else {
      args.push(a);
    }
  }
  return { args, flags };
}

class CliError extends Error {
  constructor(message, code = 1) {
    super(message);
    this.code = code;
  }
}

const num = (v) => Number(v ?? 0);

// ---------------------------------------------------------------------------
// Dates

function today() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function addDays(iso, n) {
  const d = new Date(`${iso}T00:00:00`);
  d.setDate(d.getDate() + n);
  const pad = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function mondayOf(iso) {
  const d = new Date(`${iso}T00:00:00`);
  const shift = (d.getDay() + 6) % 7; // Monday = 0
  return addDays(iso, -shift);
}

function parseDate(v, what = 'date') {
  if (!v) return null;
  const s = String(v).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  if (s.toLowerCase() === 'today') return today();
  if (s.toLowerCase() === 'yesterday') return addDays(today(), -1);
  // Harvest writes dates as DD/MM/YYYY or MM/DD/YYYY depending on account settings.
  const slash = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (slash) {
    const a = Number(slash[1]);
    const b = Number(slash[2]);
    const [day, month] = a > 12 ? [a, b] : [b, a];
    return `${slash[3]}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) throw new CliError(`"${v}" is not a ${what}. Use YYYY-MM-DD.`);
  return isoDate(d);
}

// "90m", "1.5", "1:30", "2h15", "2h", "45 min" -> minutes
function parseDuration(v) {
  const s = String(v ?? '').trim().toLowerCase().replace(/\s+/g, '');
  if (!s) throw new CliError('How long was it? Use 90m, 1.5, 1:30 or 2h15.');
  let m;
  if ((m = s.match(/^(\d+):([0-5]?\d)$/))) return Number(m[1]) * 60 + Number(m[2]);
  if ((m = s.match(/^(\d+(?:\.\d+)?)h(?:ou)?r?s?(\d+)?(?:m(?:in(?:ute)?s?)?)?$/))) {
    return Math.round(Number(m[1]) * 60) + (m[2] ? Number(m[2]) : 0);
  }
  if ((m = s.match(/^(\d+(?:\.\d+)?)m(?:in(?:ute)?s?)?$/))) return Math.round(Number(m[1]));
  if ((m = s.match(/^(\d+(?:\.\d+)?)$/))) return Math.round(Number(m[1]) * 60);
  throw new CliError(`"${v}" is not a duration. Use 90m, 1.5, 1:30 or 2h15.`);
}

function parseMoney(v) {
  if (v === undefined || v === null || v === '' || v === true) return 0;
  const n = Number(String(v).replace(/[^0-9.-]/g, ''));
  if (Number.isNaN(n)) throw new CliError(`"${v}" is not an amount.`);
  return Math.round(n * 100);
}

const cents = (minutes, rate) => Math.round((num(minutes) * num(rate)) / 60);

// Harvest writes "New Zealand Dollar - NZD" in its Currency column.
function currencyCode(v, dflt = 'NZD') {
  const m = String(v ?? '').trim().match(/([A-Za-z]{3})\s*$/);
  return m ? m[1].toUpperCase() : dflt;
}

// ---------------------------------------------------------------------------
// Lookups: full id, first 8+ chars of an id, exact name, then a contains match.
// One hit wins. Several hits list the candidates and exit 1.

const RESOLVERS = {
  client: {
    from: 'clients c',
    cols: 'c.*',
    exact: 'lower(c.name) = lower($1)',
    fuzzy: 'c.name ilike $1',
    label: (r) => r.name,
    order: 'c.name',
  },
  project: {
    from: 'projects c join clients cl on cl.id = c.client_id',
    cols: 'c.*, cl.name as client_name, cl.currency, cl.default_rate_cents as client_rate_cents, cl.payment_terms_days',
    exact: 'lower(c.name) = lower($1) or lower(c.code) = lower($1)',
    fuzzy: 'c.name ilike $1 or c.code ilike $1',
    label: (r) => `${r.name} (${r.client_name}, ${r.status})`,
    order: 'c.status, c.name',
  },
  person: {
    from: 'people c',
    cols: 'c.*',
    exact: 'lower(c.full_name) = lower($1) or lower(c.email) = lower($1)',
    fuzzy: 'c.full_name ilike $1 or c.email ilike $1',
    label: (r) => `${r.full_name}${r.role ? ` (${r.role})` : ''}`,
    order: 'c.full_name',
  },
  task: {
    from: 'tasks c',
    cols: 'c.*',
    exact: 'lower(c.name) = lower($1)',
    fuzzy: 'c.name ilike $1',
    label: (r) => r.name,
    order: 'c.name',
  },
  invoice: {
    from: 'invoices c join clients cl on cl.id = c.client_id',
    cols: 'c.*, cl.name as client_name',
    exact: 'lower(c.number) = lower($1)',
    fuzzy: 'c.number ilike $1 or cl.name ilike $1 or c.subject ilike $1',
    label: (r) => `${r.number} ${r.client_name} (${r.status})`,
    order: 'c.issued_on desc',
  },
};

const ID_RE = /^[0-9a-f]{4,8}(-[0-9a-f-]*)?$/i;

async function resolve(db, kind, q, { optional = false } = {}) {
  const spec = RESOLVERS[kind];
  q = String(q ?? '').trim();
  if (!q) {
    if (optional) return null;
    throw new CliError(`Give me a ${kind} name or id.`);
  }
  const select = `select ${spec.cols} from ${spec.from}`;
  let rows = [];
  if (ID_RE.test(q)) {
    rows = await db.query(`${select} where c.id::text like $1 order by ${spec.order}`, [q.toLowerCase() + '%']);
    if (rows.length === 1) return rows[0];
  }
  if (!rows.length) rows = await db.query(`${select} where ${spec.exact} order by ${spec.order}`, [q]);
  if (rows.length === 1) return rows[0];
  if (!rows.length) rows = await db.query(`${select} where ${spec.fuzzy} order by ${spec.order}`, [`%${q}%`]);
  if (rows.length === 1) return rows[0];
  if (kind === 'project' && rows.length > 1) {
    const active = rows.filter((r) => r.status === 'active');
    if (active.length === 1) return active[0];
  }
  if (!rows.length) {
    if (optional) return null;
    const listing = { client: 'clients', project: 'projects --all', person: 'team', task: 'tasks', invoice: 'invoices --all' }[kind];
    throw new CliError(`No ${kind} matches "${q}". Run \`${listing}\` to see what exists.`);
  }
  throw new CliError(
    `"${q}" matches ${rows.length} ${kind}s. Use an id or a longer name:\n` +
      rows.map((r) => `  ${short(r.id)}  ${spec.label(r)}`).join('\n'),
  );
}

// The person logging time: --person, TIMEBILL_PERSON, or the only active person.
async function whoIs(db, flags) {
  const named = flags.person || process.env.TIMEBILL_PERSON;
  if (named) return resolve(db, 'person', named);
  const rows = await db.query('select * from people where active order by full_name');
  if (rows.length === 1) return rows[0];
  if (!rows.length) throw new CliError('No people on file. Add one: add person "<name>" --rate=150');
  throw new CliError(
    `Several people log time here. Pass --person= (or set TIMEBILL_PERSON):\n` +
      rows.map((r) => `  ${short(r.id)}  ${r.full_name}`).join('\n'),
  );
}

// project rate, then client rate, then the person's own rate.
async function rateFor(db, project, task, person) {
  let billable = project.billable;
  let rate = project.bill_rate_cents;
  if (task) {
    const [pt] = await db.query('select * from project_tasks where project_id = $1 and task_id = $2', [project.id, task.id]);
    if (pt) {
      if (!pt.billable) billable = false;
      if (pt.bill_rate_cents !== null && pt.bill_rate_cents !== undefined) rate = pt.bill_rate_cents;
    } else if (!task.billable_default) {
      billable = false;
    }
  }
  if (rate === null || rate === undefined) rate = project.client_rate_cents;
  if (!num(rate)) rate = person?.bill_rate_cents ?? 0;
  if (project.fee_type === 'internal' || !project.billable) billable = false;
  return { bill_rate_cents: num(rate), billable };
}

// ---------------------------------------------------------------------------
// Read commands

async function cmdTimesheet(db, args, flags) {
  const anchor = flags.from ? parseDate(flags.from) : flags.last ? addDays(today(), -7) : today();
  const from = flags.from ? parseDate(flags.from) : mondayOf(anchor);
  const to = flags.to ? parseDate(flags.to) : addDays(from, 6);
  const person = await resolve(db, 'person', flags.person, { optional: true });
  const params = [from, to, person?.id || null];
  const where = `t.spent_on between $1 and $2 and ($3::uuid is null or t.person_id = $3)`;

  const entries = await db.query(
    `select t.id, t.spent_on::text as spent_on, t.minutes, t.notes, t.billable, t.bill_rate_cents, t.invoice_id,
            p.full_name as person, pr.name as project, cl.name as client, tk.name as task
     from time_entries t
     join people p on p.id = t.person_id
     join projects pr on pr.id = t.project_id
     join clients cl on cl.id = pr.client_id
     left join tasks tk on tk.id = t.task_id
     where ${where}
     order by t.spent_on, p.full_name, pr.name`,
    params,
  );
  const days = await db.query(
    `select t.spent_on::text as spent_on, sum(t.minutes)::integer as minutes,
            coalesce(sum(t.minutes) filter (where t.billable), 0)::integer as billable_minutes
     from time_entries t where ${where} group by t.spent_on order by t.spent_on`,
    params,
  );
  const people = await db.query(
    `select p.full_name as person, p.weekly_capacity_minutes, sum(t.minutes)::integer as minutes,
            coalesce(sum(t.minutes) filter (where t.billable), 0)::integer as billable_minutes,
            coalesce(sum(case when t.billable then round(t.minutes::numeric * t.bill_rate_cents / 60) else 0 end), 0)::bigint as billable_cents
     from time_entries t join people p on p.id = t.person_id
     where ${where} group by p.id, p.full_name, p.weekly_capacity_minutes order by sum(t.minutes) desc`,
    params,
  );
  const projects = await db.query(
    `select pr.name as project, cl.name as client, sum(t.minutes)::integer as minutes,
            coalesce(sum(case when t.billable then round(t.minutes::numeric * t.bill_rate_cents / 60) else 0 end), 0)::bigint as billable_cents
     from time_entries t join projects pr on pr.id = t.project_id join clients cl on cl.id = pr.client_id
     where ${where} group by pr.id, pr.name, cl.name order by sum(t.minutes) desc`,
    params,
  );
  const minutes = days.reduce((a, d) => a + num(d.minutes), 0);
  const billableMinutes = days.reduce((a, d) => a + num(d.billable_minutes), 0);
  const totals = {
    minutes,
    billable_minutes: billableMinutes,
    billable_pct: minutes ? Math.round((billableMinutes / minutes) * 100) : 0,
    billable_cents: projects.reduce((a, p) => a + num(p.billable_cents), 0),
    entries: entries.length,
  };
  const text = [
    heading(`Timesheet ${from} to ${to}${person ? ` for ${person.full_name}` : ''}`),
    table(days, [
      { key: 'spent_on', label: 'Day', format: (v) => `${weekday(v)} ${v}` },
      { key: 'minutes', label: 'Hours', align: 'right', format: clock },
      { key: 'billable_minutes', label: 'Billable', align: 'right', format: clock },
    ]),
    `\n  ${clock(totals.minutes)} logged, ${clock(totals.billable_minutes)} billable (${totals.billable_pct}%), worth ${money(totals.billable_cents)}`,
    '\nBy person',
    table(people, [
      { key: 'person', label: 'Person', width: 22 },
      { key: 'minutes', label: 'Hours', align: 'right', format: clock },
      { key: 'billable_minutes', label: 'Billable', align: 'right', format: clock },
      { key: 'billable_cents', label: 'Value', align: 'right', format: (v) => money(v) },
      {
        key: 'weekly_capacity_minutes',
        label: 'Of capacity',
        align: 'right',
        format: (v, r) => (num(v) ? `${Math.round((num(r.minutes) / num(v)) * 100)}%` : ''),
      },
    ]),
    '\nBy project',
    table(projects, [
      { key: 'project', label: 'Project', width: 34 },
      { key: 'client', label: 'Client', width: 26 },
      { key: 'minutes', label: 'Hours', align: 'right', format: clock },
      { key: 'billable_cents', label: 'Value', align: 'right', format: (v) => money(v) },
    ]),
    `\nEntries (${entries.length})`,
    table(entries, [
      { key: 'id', label: 'Id', format: short },
      { key: 'spent_on', label: 'Date' },
      { key: 'person', label: 'Person', width: 16 },
      { key: 'project', label: 'Project', width: 28 },
      { key: 'task', label: 'Task', width: 18 },
      { key: 'minutes', label: 'Hours', align: 'right', format: clock },
      { key: 'billable', label: 'Bill', format: (v) => (v ? 'yes' : 'no') },
      { key: 'invoice_id', label: 'Inv', format: (v) => (v ? 'sent' : '-') },
      { key: 'notes', label: 'Notes', width: 46, format: (v) => truncate(v, 46) },
    ]),
  ].join('\n');
  return { json: { from, to, person: person?.full_name || null, totals, days, people, projects, entries }, text };
}

const REPORT_GROUPS = {
  client: { sql: 'cl.name', label: 'Client' },
  project: { sql: 'pr.name', label: 'Project' },
  task: { sql: "coalesce(tk.name, 'No task')", label: 'Task' },
  person: { sql: 'p.full_name', label: 'Person' },
};

async function cmdReport(db, args, flags) {
  const by = String(flags.by || args[0] || 'client').toLowerCase();
  const group = REPORT_GROUPS[by];
  if (!group) throw new CliError(`Group by one of: ${Object.keys(REPORT_GROUPS).join(', ')}.`);
  const to = flags.to ? parseDate(flags.to) : today();
  const from = flags.from ? parseDate(flags.from) : addDays(to, -30);
  const rows = await db.query(
    `select ${group.sql} as name,
            sum(t.minutes)::integer as minutes,
            coalesce(sum(t.minutes) filter (where t.billable), 0)::integer as billable_minutes,
            coalesce(sum(case when t.billable then round(t.minutes::numeric * t.bill_rate_cents / 60) else 0 end), 0)::bigint as billable_cents,
            coalesce(sum(round(t.minutes::numeric * t.cost_rate_cents / 60)), 0)::bigint as cost_cents,
            count(*)::integer as entries
     from time_entries t
     join people p on p.id = t.person_id
     join projects pr on pr.id = t.project_id
     join clients cl on cl.id = pr.client_id
     left join tasks tk on tk.id = t.task_id
     where t.spent_on between $1 and $2
     group by ${group.sql}
     order by sum(t.minutes) desc`,
    [from, to],
  );
  const totals = {
    minutes: rows.reduce((a, r) => a + num(r.minutes), 0),
    billable_minutes: rows.reduce((a, r) => a + num(r.billable_minutes), 0),
    billable_cents: rows.reduce((a, r) => a + num(r.billable_cents), 0),
    cost_cents: rows.reduce((a, r) => a + num(r.cost_cents), 0),
  };
  totals.margin_cents = totals.billable_cents - totals.cost_cents;
  totals.effective_rate_cents = totals.minutes ? Math.round((totals.billable_cents * 60) / totals.minutes) : 0;
  const text = [
    heading(`Time by ${by}, ${from} to ${to}`),
    table(rows, [
      { key: 'name', label: group.label, width: 34 },
      { key: 'minutes', label: 'Hours', align: 'right', format: clock },
      { key: 'billable_minutes', label: 'Billable', align: 'right', format: clock },
      { key: 'billable_cents', label: 'Value', align: 'right', format: (v) => money(v) },
      { key: 'cost_cents', label: 'Cost', align: 'right', format: (v) => money(v) },
      {
        key: 'billable_cents',
        label: 'Margin',
        align: 'right',
        format: (v, r) => money(num(v) - num(r.cost_cents)),
      },
      { key: 'entries', label: 'Entries', align: 'right' },
    ]),
    `\n  ${clock(totals.minutes)} logged, ${money(totals.billable_cents)} billable, ${money(totals.margin_cents)} margin, effective rate ${money(totals.effective_rate_cents)}/h`,
  ].join('\n');
  return { json: { by, from, to, rows, totals }, text };
}

async function cmdProjects(db, [q = ''], flags) {
  const rows = await db.query(
    `select * from v_project_health
     where ($1::boolean or status = 'active')
       and ($2::text = '' or project ilike '%' || $2::text || '%' or client ilike '%' || $2::text || '%' or coalesce(code, '') ilike '%' || $2::text || '%')
     order by client, project`,
    [Boolean(flags.all), q],
  );
  const text = [
    heading(q ? `Projects matching "${q}"` : flags.all ? 'All projects' : 'Active projects'),
    table(rows, [
      { key: 'project_id', label: 'Id', format: short },
      { key: 'project', label: 'Project', width: 32 },
      { key: 'client', label: 'Client', width: 24 },
      { key: 'fee_type', label: 'Fee' },
      { key: 'minutes', label: 'Hours', align: 'right', format: clock },
      { key: 'budget_minutes', label: 'Budget', align: 'right', format: (v) => (v ? clock(v) : '') },
      { key: 'budget_pct', label: 'Used', align: 'right', format: (v) => (v === null ? '' : `${v}%`) },
      { key: 'budget_pct', label: '', format: (v) => (v === null ? '' : bar(v)) },
      { key: 'unbilled_cents', label: 'Unbilled', align: 'right', format: (v, r) => money(v, r.currency) },
      { key: 'last_entry_on', label: 'Last entry', format: (v) => (v ? isoDate(v) : 'never') },
    ]),
    `\n  ${rows.length} project${rows.length === 1 ? '' : 's'}, ${money(rows.reduce((a, r) => a + num(r.unbilled_cents), 0))} unbilled`,
  ].join('\n');
  return { json: rows, text };
}

async function cmdProject(db, [q]) {
  const p = await resolve(db, 'project', q);
  const [health] = await db.query('select * from v_project_health where project_id = $1', [p.id]);
  const byPerson = await db.query(
    `select pe.full_name as person, sum(t.minutes)::integer as minutes,
            coalesce(sum(case when t.billable then round(t.minutes::numeric * t.bill_rate_cents / 60) else 0 end), 0)::bigint as billable_cents,
            coalesce(sum(round(t.minutes::numeric * t.cost_rate_cents / 60)), 0)::bigint as cost_cents,
            max(t.spent_on)::text as last_entry_on
     from time_entries t join people pe on pe.id = t.person_id
     where t.project_id = $1 group by pe.id, pe.full_name order by sum(t.minutes) desc`,
    [p.id],
  );
  const byTask = await db.query(
    `select coalesce(tk.name, 'No task') as task, sum(t.minutes)::integer as minutes,
            coalesce(sum(case when t.billable then round(t.minutes::numeric * t.bill_rate_cents / 60) else 0 end), 0)::bigint as billable_cents
     from time_entries t left join tasks tk on tk.id = t.task_id
     where t.project_id = $1 group by tk.name order by sum(t.minutes) desc`,
    [p.id],
  );
  const [unbilled] = await db.query('select * from v_unbilled where project_id = $1', [p.id]);
  const invoices = await db.query(
    `select s.* from v_invoice_status s
     where s.invoice_id in (select invoice_id from invoice_lines where project_id = $1)
        or exists (select 1 from invoices i where i.id = s.invoice_id and i.project_id = $1)
     order by s.issued_on desc`,
    [p.id],
  );
  const expenses = await db.query(
    `select e.id, e.spent_on::text as spent_on, e.category, e.description, e.amount_cents, e.billable, e.invoice_id
     from expenses e where e.project_id = $1 order by e.spent_on desc`,
    [p.id],
  );
  const entries = await db.query(
    `select t.id, t.spent_on::text as spent_on, t.minutes, t.notes, t.billable, t.invoice_id,
            pe.full_name as person, tk.name as task
     from time_entries t join people pe on pe.id = t.person_id left join tasks tk on tk.id = t.task_id
     where t.project_id = $1 order by t.spent_on desc limit 25`,
    [p.id],
  );
  const budgetLine = health.budget_minutes
    ? `  Budget ${clock(health.budget_minutes)}, used ${clock(health.minutes)} (${health.budget_pct}%) ${bar(health.budget_pct)}`
    : health.budget_cents
      ? `  Budget ${money(health.budget_cents, p.currency)}, billable so far ${money(health.billable_cents, p.currency)}`
      : '  No budget set';
  const text = [
    heading(`${p.name} (${p.client_name})`),
    `  ${[p.code, p.fee_type, p.status, p.billable ? 'billable' : 'non-billable'].filter(Boolean).join('   ')}`,
    budgetLine,
    `  Logged ${clock(health.minutes)}, worth ${money(health.billable_cents, p.currency)}, cost ${money(health.cost_cents, p.currency)}, margin ${money(num(health.billable_cents) - num(health.cost_cents), p.currency)}`,
    `  Unbilled ${money(health.unbilled_cents, p.currency)}${unbilled ? ` (oldest entry ${isoDate(unbilled.oldest_on)}, ${unbilled.days_old} days)` : ''}`,
    `  id ${p.id}   last entry ${health.last_entry_on ? isoDate(health.last_entry_on) : 'never'}${p.notes ? `\n  notes: ${p.notes}` : ''}`,
    '\nBy person',
    table(byPerson, [
      { key: 'person', label: 'Person', width: 22 },
      { key: 'minutes', label: 'Hours', align: 'right', format: clock },
      { key: 'billable_cents', label: 'Value', align: 'right', format: (v) => money(v, p.currency) },
      { key: 'cost_cents', label: 'Cost', align: 'right', format: (v) => money(v, p.currency) },
      { key: 'last_entry_on', label: 'Last entry' },
    ]),
    '\nBy task',
    table(byTask, [
      { key: 'task', label: 'Task', width: 24 },
      { key: 'minutes', label: 'Hours', align: 'right', format: clock },
      { key: 'billable_cents', label: 'Value', align: 'right', format: (v) => money(v, p.currency) },
    ]),
    '\nExpenses',
    table(expenses, [
      { key: 'spent_on', label: 'Date' },
      { key: 'category', label: 'Category', width: 18 },
      { key: 'description', label: 'Description', width: 40 },
      { key: 'amount_cents', label: 'Amount', align: 'right', format: (v) => money(v, p.currency) },
      { key: 'invoice_id', label: 'Invoiced', format: (v) => (v ? 'yes' : 'no') },
    ]),
    '\nInvoices',
    table(invoices, [
      { key: 'number', label: 'Number' },
      { key: 'status', label: 'Status' },
      { key: 'issued_on', label: 'Issued', format: isoDate },
      { key: 'due_on', label: 'Due', format: isoDate },
      { key: 'total_cents', label: 'Total', align: 'right', format: (v, r) => money(v, r.currency) },
      { key: 'days_overdue', label: 'Overdue', align: 'right', format: (v) => (num(v) ? `${v}d` : '') },
    ]),
    `\nRecent time (${entries.length})`,
    table(entries, [
      { key: 'id', label: 'Id', format: short },
      { key: 'spent_on', label: 'Date' },
      { key: 'person', label: 'Person', width: 16 },
      { key: 'task', label: 'Task', width: 18 },
      { key: 'minutes', label: 'Hours', align: 'right', format: clock },
      { key: 'invoice_id', label: 'Inv', format: (v) => (v ? 'yes' : '-') },
      { key: 'notes', label: 'Notes', width: 50, format: (v) => truncate(v, 50) },
    ]),
  ].join('\n');
  return { json: { project: p, health, by_person: byPerson, by_task: byTask, unbilled: unbilled || null, invoices, expenses, entries }, text };
}

async function cmdClients(db, [q = ''], flags) {
  const rows = await db.query(
    `select c.id, c.name, c.currency, c.default_rate_cents, c.payment_terms_days, c.archived,
            (select count(*) from projects p where p.client_id = c.id and p.status = 'active')::integer as active_projects,
            coalesce((select sum(u.total_cents) from v_unbilled u where u.client_id = c.id), 0)::bigint as unbilled_cents,
            coalesce((select sum(s.total_cents) from v_invoice_status s where s.client_id = c.id and s.status = 'sent'), 0)::bigint as outstanding_cents,
            coalesce((select max(s.days_overdue) from v_invoice_status s where s.client_id = c.id and s.status = 'sent'), 0)::integer as worst_overdue,
            (select max(t.spent_on) from time_entries t join projects p on p.id = t.project_id where p.client_id = c.id) as last_entry_on
     from clients c
     where ($1::boolean or not c.archived)
       and ($2::text = '' or c.name ilike '%' || $2::text || '%' or coalesce(c.contact_name, '') ilike '%' || $2::text || '%')
     order by c.name`,
    [Boolean(flags.all), q],
  );
  const text = [
    heading(q ? `Clients matching "${q}"` : 'Clients'),
    table(rows, [
      { key: 'id', label: 'Id', format: short },
      { key: 'name', label: 'Client', width: 30 },
      { key: 'default_rate_cents', label: 'Rate', align: 'right', format: (v, r) => `${money(v, r.currency)}/h` },
      { key: 'payment_terms_days', label: 'Terms', align: 'right', format: (v) => `${v}d` },
      { key: 'active_projects', label: 'Projects', align: 'right' },
      { key: 'unbilled_cents', label: 'Unbilled', align: 'right', format: (v, r) => money(v, r.currency) },
      { key: 'outstanding_cents', label: 'Owed', align: 'right', format: (v, r) => money(v, r.currency) },
      { key: 'worst_overdue', label: 'Overdue', align: 'right', format: (v) => (num(v) ? `${v}d` : '') },
      { key: 'last_entry_on', label: 'Last work', format: (v) => (v ? isoDate(v) : 'never') },
    ]),
  ].join('\n');
  return { json: rows, text };
}

async function cmdClient(db, [q]) {
  const c = await resolve(db, 'client', q);
  const projects = await db.query('select * from v_project_health where client_id = $1 order by status, project', [c.id]);
  const unbilled = await db.query('select * from v_unbilled where client_id = $1 order by days_old desc', [c.id]);
  const invoices = await db.query('select * from v_invoice_status where client_id = $1 order by issued_on desc', [c.id]);
  const [pay] = await db.query(
    `select coalesce(avg(extract(epoch from (paid_at - issued_on::timestamptz)) / 86400), 0) as avg_days_to_pay,
            count(*) filter (where status = 'paid')::integer as paid_count
     from invoices where client_id = $1 and paid_at is not null`,
    [c.id],
  );
  const stats = {
    unbilled_cents: unbilled.reduce((a, r) => a + num(r.total_cents), 0),
    outstanding_cents: invoices.filter((i) => i.status === 'sent').reduce((a, r) => a + num(r.total_cents), 0),
    overdue_cents: invoices.filter((i) => i.status === 'sent' && num(i.days_overdue) > 0).reduce((a, r) => a + num(r.total_cents), 0),
    paid_cents: invoices.filter((i) => i.status === 'paid').reduce((a, r) => a + num(r.total_cents), 0),
    avg_days_to_pay: Math.round(num(pay.avg_days_to_pay)),
    paid_invoices: num(pay.paid_count),
  };
  const text = [
    heading(c.name),
    `  ${[c.contact_name, c.email].filter(Boolean).join('   ') || 'no contact on file'}`,
    `  ${money(c.default_rate_cents, c.currency)}/h default rate, ${c.payment_terms_days} day terms, ${c.currency}`,
    `  id ${c.id}${c.notes ? `\n  notes: ${c.notes}` : ''}`,
    `\n  Unbilled ${money(stats.unbilled_cents, c.currency)}   owed ${money(stats.outstanding_cents, c.currency)}   overdue ${money(stats.overdue_cents, c.currency)}   pays in ${stats.avg_days_to_pay} days on average`,
    '\nProjects',
    table(projects, [
      { key: 'project', label: 'Project', width: 32 },
      { key: 'status', label: 'Status' },
      { key: 'fee_type', label: 'Fee' },
      { key: 'minutes', label: 'Hours', align: 'right', format: clock },
      { key: 'budget_pct', label: 'Budget', align: 'right', format: (v) => (v === null ? '' : `${v}%`) },
      { key: 'billable_cents', label: 'Value', align: 'right', format: (v) => money(v, c.currency) },
      { key: 'unbilled_cents', label: 'Unbilled', align: 'right', format: (v) => money(v, c.currency) },
    ]),
    '\nUnbilled work',
    table(unbilled, [
      { key: 'project', label: 'Project', width: 32 },
      { key: 'minutes', label: 'Hours', align: 'right', format: clock },
      { key: 'time_cents', label: 'Time', align: 'right', format: (v) => money(v, c.currency) },
      { key: 'expense_cents', label: 'Expenses', align: 'right', format: (v) => money(v, c.currency) },
      { key: 'total_cents', label: 'Total', align: 'right', format: (v) => money(v, c.currency) },
      { key: 'days_old', label: 'Oldest', align: 'right', format: (v) => `${v}d` },
    ]),
    '\nInvoices',
    table(invoices, [
      { key: 'number', label: 'Number' },
      { key: 'status', label: 'Status' },
      { key: 'subject', label: 'Subject', width: 34 },
      { key: 'issued_on', label: 'Issued', format: isoDate },
      { key: 'due_on', label: 'Due', format: isoDate },
      { key: 'total_cents', label: 'Total', align: 'right', format: (v) => money(v, c.currency) },
      { key: 'days_overdue', label: 'Overdue', align: 'right', format: (v) => (num(v) ? `${v}d` : '') },
    ]),
  ].join('\n');
  return { json: { client: c, projects, unbilled, invoices, stats }, text };
}

async function cmdTeam(db, args, flags) {
  const rows = await db.query(
    `select p.id, p.full_name, p.role, p.email, p.active, p.weekly_capacity_minutes, p.cost_rate_cents, p.bill_rate_cents,
            coalesce(sum(t.minutes) filter (where t.spent_on > current_date - 7), 0)::integer as minutes_7d,
            coalesce(sum(t.minutes) filter (where t.spent_on > current_date - 30), 0)::integer as minutes_30d,
            coalesce(sum(t.minutes) filter (where t.spent_on > current_date - 30 and t.billable), 0)::integer as billable_30d,
            coalesce(sum(case when t.billable and t.spent_on > current_date - 30 then round(t.minutes::numeric * t.bill_rate_cents / 60) else 0 end), 0)::bigint as billable_cents_30d,
            max(t.spent_on) as last_entry_on
     from people p left join time_entries t on t.person_id = p.id
     where ($1::boolean or p.active)
     group by p.id order by p.active desc, p.full_name`,
    [Boolean(flags.all)],
  );
  for (const r of rows) {
    r.billable_pct_30d = num(r.minutes_30d) ? Math.round((num(r.billable_30d) / num(r.minutes_30d)) * 100) : 0;
    r.utilisation_pct_7d = num(r.weekly_capacity_minutes) ? Math.round((num(r.minutes_7d) / num(r.weekly_capacity_minutes)) * 100) : 0;
    r.effective_rate_cents = num(r.minutes_30d) ? Math.round((num(r.billable_cents_30d) * 60) / num(r.minutes_30d)) : 0;
  }
  const text = [
    heading('Team'),
    table(rows, [
      { key: 'id', label: 'Id', format: short },
      { key: 'full_name', label: 'Person', width: 22 },
      { key: 'role', label: 'Role', width: 20 },
      { key: 'minutes_7d', label: 'Last 7d', align: 'right', format: clock },
      { key: 'utilisation_pct_7d', label: 'Of capacity', align: 'right', format: (v) => `${v}%` },
      { key: 'minutes_30d', label: 'Last 30d', align: 'right', format: clock },
      { key: 'billable_pct_30d', label: 'Billable', align: 'right', format: (v) => `${v}%` },
      { key: 'billable_cents_30d', label: 'Value 30d', align: 'right', format: (v) => money(v) },
      { key: 'effective_rate_cents', label: 'Rate/h', align: 'right', format: (v) => money(v) },
      { key: 'last_entry_on', label: 'Last entry', format: (v) => (v ? isoDate(v) : 'never') },
    ]),
  ].join('\n');
  return { json: rows, text };
}

async function cmdUnbilled(db, [q = '']) {
  const rows = await db.query(
    `select * from v_unbilled
     where $1::text = '' or project ilike '%' || $1::text || '%' or client ilike '%' || $1::text || '%'
     order by days_old desc, total_cents desc`,
    [q],
  );
  const totals = {
    minutes: rows.reduce((a, r) => a + num(r.minutes), 0),
    time_cents: rows.reduce((a, r) => a + num(r.time_cents), 0),
    expense_cents: rows.reduce((a, r) => a + num(r.expense_cents), 0),
    total_cents: rows.reduce((a, r) => a + num(r.total_cents), 0),
    projects: rows.length,
  };
  const text = [
    heading('Unbilled work'),
    table(rows, [
      { key: 'project_id', label: 'Id', format: short },
      { key: 'client', label: 'Client', width: 26 },
      { key: 'project', label: 'Project', width: 32 },
      { key: 'minutes', label: 'Hours', align: 'right', format: clock },
      { key: 'time_cents', label: 'Time', align: 'right', format: (v, r) => money(v, r.currency) },
      { key: 'expense_cents', label: 'Expenses', align: 'right', format: (v, r) => money(v, r.currency) },
      { key: 'total_cents', label: 'Total', align: 'right', format: (v, r) => money(v, r.currency) },
      { key: 'oldest_on', label: 'Oldest', format: isoDate },
      { key: 'days_old', label: 'Age', align: 'right', format: (v) => `${v}d` },
    ]),
    `\n  ${clock(totals.minutes)} across ${totals.projects} project${totals.projects === 1 ? '' : 's'}, ${money(totals.total_cents)} ready to invoice`,
  ].join('\n');
  return { json: { rows, totals }, text };
}

async function cmdInvoices(db, args, flags) {
  const status = flags.status ? String(flags.status).toLowerCase() : null;
  const rows = await db.query(
    `select * from v_invoice_status
     where ($1::text is null or status = $1::text)
       and ($2::boolean or status <> 'void')
     order by case status when 'sent' then 0 when 'draft' then 1 else 2 end, days_overdue desc, issued_on desc`,
    [status, Boolean(flags.all)],
  );
  const totals = {
    outstanding_cents: rows.filter((r) => r.status === 'sent').reduce((a, r) => a + num(r.total_cents), 0),
    overdue_cents: rows.filter((r) => r.status === 'sent' && num(r.days_overdue) > 0).reduce((a, r) => a + num(r.total_cents), 0),
    draft_cents: rows.filter((r) => r.status === 'draft').reduce((a, r) => a + num(r.total_cents), 0),
    paid_cents: rows.filter((r) => r.status === 'paid').reduce((a, r) => a + num(r.total_cents), 0),
    count: rows.length,
  };
  const text = [
    heading(status ? `Invoices (${status})` : 'Invoices'),
    table(rows, [
      { key: 'number', label: 'Number' },
      { key: 'status', label: 'Status' },
      { key: 'client', label: 'Client', width: 26 },
      { key: 'subject', label: 'Subject', width: 34 },
      { key: 'issued_on', label: 'Issued', format: isoDate },
      { key: 'due_on', label: 'Due', format: isoDate },
      { key: 'total_cents', label: 'Total', align: 'right', format: (v, r) => money(v, r.currency) },
      { key: 'days_overdue', label: 'Overdue', align: 'right', format: (v) => (num(v) ? `${v}d` : '') },
    ]),
    `\n  ${money(totals.outstanding_cents)} owed, ${money(totals.overdue_cents)} of it overdue. ${money(totals.draft_cents)} sitting in draft.`,
  ].join('\n');
  return { json: { rows, totals }, text };
}

async function cmdInvoiceShow(db, q) {
  const inv = await resolve(db, 'invoice', q);
  const [status] = await db.query('select * from v_invoice_status where invoice_id = $1', [inv.id]);
  const lines = await db.query(
    `select l.*, p.name as project from invoice_lines l left join projects p on p.id = l.project_id
     where l.invoice_id = $1 order by l.position, l.created_at`,
    [inv.id],
  );
  const [covers] = await db.query(
    `select coalesce(sum(t.minutes), 0)::integer as minutes, count(t.id)::integer as entries,
            min(t.spent_on)::text as first_on, max(t.spent_on)::text as last_on
     from time_entries t where t.invoice_id = $1`,
    [inv.id],
  );
  const [exp] = await db.query('select count(*)::integer as items, coalesce(sum(amount_cents), 0)::bigint as cents from expenses where invoice_id = $1', [inv.id]);
  const text = [
    heading(`${inv.number}  ${inv.client_name}`),
    `  ${inv.subject || 'no subject'}`,
    `  ${inv.status}   issued ${isoDate(inv.issued_on)}   due ${isoDate(inv.due_on) || 'not set'}${num(status.days_overdue) ? `   ${status.days_overdue} days overdue` : ''}`,
    `  ${money(status.total_cents, inv.currency)} across ${status.line_count} line${num(status.line_count) === 1 ? '' : 's'}`,
    `  covers ${clock(covers.minutes)} of time (${covers.entries} entries${covers.first_on ? `, ${covers.first_on} to ${covers.last_on}` : ''}) and ${exp.items} expense${num(exp.items) === 1 ? '' : 's'}`,
    `  id ${inv.id}${inv.notes ? `\n  notes: ${inv.notes}` : ''}`,
    '\nLines',
    table(lines, [
      { key: 'position', label: '#', align: 'right' },
      { key: 'kind', label: 'Kind' },
      { key: 'description', label: 'Description', width: 52 },
      { key: 'quantity', label: 'Qty', align: 'right' },
      { key: 'unit_price_cents', label: 'Rate', align: 'right', format: (v) => money(v, inv.currency) },
      { key: 'amount_cents', label: 'Amount', align: 'right', format: (v) => money(v, inv.currency) },
    ]),
    `\n  Total ${money(status.total_cents, inv.currency)}`,
  ].join('\n');
  return { json: { invoice: inv, status, lines, covers: { ...covers, expense_items: num(exp.items), expense_cents: num(exp.cents) } }, text };
}

async function cmdAttention(db) {
  const rows = await db.query(`
    select reason, ref_type, ref_id, label, client, days, amount_cents, detail
    from v_attention_due
    order by case reason
      when 'invoice_overdue' then 0
      when 'unbilled_ageing' then 1
      when 'budget_risk'     then 2
      when 'project_quiet'   then 3
      else 4 end, amount_cents desc, days desc
  `);
  const groups = [
    ['invoice_overdue', 'Invoices past due'],
    ['unbilled_ageing', 'Work done and not invoiced (30+ days)'],
    ['budget_risk', 'Projects at or past budget'],
    ['project_quiet', 'Active projects with no time in 14+ days'],
    ['timesheet_gap', 'People who have not logged time in 5+ days'],
  ];
  const parts = [heading('What needs attention')];
  for (const [reason, title] of groups) {
    const items = rows.filter((r) => r.reason === reason);
    parts.push(`\n${title}: ${items.length}`);
    parts.push(
      table(items, [
        { key: 'label', label: 'What', width: 36 },
        { key: 'client', label: 'Client', width: 26 },
        { key: 'amount_cents', label: 'Amount', align: 'right', format: (v) => (num(v) ? money(v) : '') },
        { key: 'days', label: reason === 'budget_risk' ? 'Used %' : 'Days', align: 'right' },
        { key: 'detail', label: 'Detail', width: 44 },
        { key: 'ref_id', label: 'Id', format: short },
      ]),
    );
  }
  const totals = {
    overdue_cents: rows.filter((r) => r.reason === 'invoice_overdue').reduce((a, r) => a + num(r.amount_cents), 0),
    ageing_cents: rows.filter((r) => r.reason === 'unbilled_ageing').reduce((a, r) => a + num(r.amount_cents), 0),
    items: rows.length,
  };
  if (!rows.length) parts.push('\n  Nothing is waiting on you.');
  else parts.push(`\n  ${money(totals.overdue_cents)} overdue, ${money(totals.ageing_cents)} of old work still uninvoiced.`);
  return { json: rows, text: parts.join('\n') };
}

async function cmdStats(db) {
  const [t] = await db.query(`
    select
      coalesce(sum(minutes) filter (where spent_on >= date_trunc('month', current_date)::date), 0)::integer as minutes_month,
      coalesce(sum(minutes) filter (where spent_on >= date_trunc('month', current_date)::date and billable), 0)::integer as billable_minutes_month,
      coalesce(sum(minutes) filter (where spent_on > current_date - 30), 0)::integer as minutes_30d,
      coalesce(sum(case when billable and spent_on > current_date - 30 then round(minutes::numeric * bill_rate_cents / 60) else 0 end), 0)::bigint as billable_cents_30d,
      coalesce(sum(case when spent_on > current_date - 30 then round(minutes::numeric * cost_rate_cents / 60) else 0 end), 0)::bigint as cost_cents_30d,
      count(*)::integer as entries
    from time_entries
  `);
  const [u] = await db.query('select coalesce(sum(total_cents), 0)::bigint as cents, coalesce(sum(minutes), 0)::integer as minutes from v_unbilled');
  const [i] = await db.query(`
    select
      coalesce(sum(total_cents) filter (where status = 'sent'), 0)::bigint as outstanding_cents,
      coalesce(sum(total_cents) filter (where status = 'sent' and days_overdue > 0), 0)::bigint as overdue_cents,
      coalesce(sum(total_cents) filter (where status = 'draft'), 0)::bigint as draft_cents,
      coalesce(sum(total_cents) filter (where status = 'paid' and issued_on >= date_trunc('month', current_date)::date), 0)::bigint as paid_this_month_cents,
      count(*) filter (where status = 'sent')::integer as sent_count,
      count(*) filter (where status = 'sent' and days_overdue > 0)::integer as overdue_count
    from v_invoice_status
  `);
  const [p] = await db.query(`
    select coalesce(avg(extract(epoch from (paid_at - issued_on::timestamptz)) / 86400), 0) as avg_days_to_pay
    from invoices where paid_at is not null
  `);
  const [cap] = await db.query(`select coalesce(sum(weekly_capacity_minutes), 0)::integer as capacity from people where active`);
  const stats = {
    minutes_this_month: num(t.minutes_month),
    billable_minutes_this_month: num(t.billable_minutes_month),
    billable_pct_this_month: num(t.minutes_month) ? Math.round((num(t.billable_minutes_month) / num(t.minutes_month)) * 100) : 0,
    minutes_last_30d: num(t.minutes_30d),
    billable_value_last_30d_cents: num(t.billable_cents_30d),
    cost_last_30d_cents: num(t.cost_cents_30d),
    margin_last_30d_cents: num(t.billable_cents_30d) - num(t.cost_cents_30d),
    effective_rate_cents: num(t.minutes_30d) ? Math.round((num(t.billable_cents_30d) * 60) / num(t.minutes_30d)) : 0,
    utilisation_pct_last_30d: num(cap.capacity) ? Math.round((num(t.minutes_30d) / (num(cap.capacity) * (30 / 7))) * 100) : 0,
    unbilled_cents: num(u.cents),
    unbilled_minutes: num(u.minutes),
    outstanding_cents: num(i.outstanding_cents),
    overdue_cents: num(i.overdue_cents),
    draft_cents: num(i.draft_cents),
    paid_this_month_cents: num(i.paid_this_month_cents),
    sent_invoices: num(i.sent_count),
    overdue_invoices: num(i.overdue_count),
    avg_days_to_pay: Math.round(num(p.avg_days_to_pay)),
    time_entries: num(t.entries),
  };
  const line = (k, v) => `  ${k.padEnd(30)} ${v}`;
  const text = [
    heading('Stats'),
    line('Hours this month', `${clock(stats.minutes_this_month)} (${stats.billable_pct_this_month}% billable)`),
    line('Hours last 30 days', `${clock(stats.minutes_last_30d)}, ${stats.utilisation_pct_last_30d}% of team capacity`),
    line('Billable value, 30 days', `${money(stats.billable_value_last_30d_cents)} (cost ${money(stats.cost_last_30d_cents)}, margin ${money(stats.margin_last_30d_cents)})`),
    line('Effective rate', `${money(stats.effective_rate_cents)} per hour worked`),
    line('Work not yet invoiced', `${money(stats.unbilled_cents)} (${clock(stats.unbilled_minutes)})`),
    line('Sent and unpaid', `${money(stats.outstanding_cents)} across ${stats.sent_invoices} invoice${stats.sent_invoices === 1 ? '' : 's'}`),
    line('Overdue', `${money(stats.overdue_cents)} across ${stats.overdue_invoices} invoice${stats.overdue_invoices === 1 ? '' : 's'}`),
    line('Sitting in draft', money(stats.draft_cents)),
    line('Paid this month', money(stats.paid_this_month_cents)),
    line('Average days to pay', String(stats.avg_days_to_pay)),
  ].join('\n');
  return { json: stats, text };
}

async function cmdTasks(db) {
  const rows = await db.query(`
    select t.id, t.name, t.billable_default,
           (select count(*) from project_tasks pt where pt.task_id = t.id)::integer as projects,
           coalesce((select sum(te.minutes) from time_entries te where te.task_id = t.id), 0)::integer as minutes
    from tasks t order by t.name
  `);
  const text = [
    heading('Tasks'),
    table(rows, [
      { key: 'id', label: 'Id', format: short },
      { key: 'name', label: 'Task', width: 28 },
      { key: 'billable_default', label: 'Billable', format: (v) => (v ? 'yes' : 'no') },
      { key: 'projects', label: 'Projects', align: 'right' },
      { key: 'minutes', label: 'Hours', align: 'right', format: clock },
    ]),
  ].join('\n');
  return { json: rows, text };
}

// ---------------------------------------------------------------------------
// Write commands

async function cmdLog(db, args, flags) {
  const [projectQ, durationQ, ...rest] = args;
  if (!projectQ || !durationQ) throw new CliError('Usage: log "<project>" <duration> [--task= --person= --on=YYYY-MM-DD --notes="..." --nonbillable]');
  const project = await resolve(db, 'project', projectQ);
  const minutes = parseDuration(durationQ);
  const person = await whoIs(db, flags);
  const task = await resolve(db, 'task', flags.task, { optional: true });
  const notes = flags.notes || rest.join(' ') || null;
  const spentOn = parseDate(flags.on, 'date') || today();
  const { bill_rate_cents, billable } = await rateFor(db, project, task, person);
  const isBillable = flags.nonbillable ? false : billable;
  if (task) {
    await db.query(
      `insert into project_tasks (project_id, task_id) values ($1, $2) on conflict (project_id, task_id) do nothing`,
      [project.id, task.id],
    );
  }
  const [row] = await db.query(
    `insert into time_entries (person_id, project_id, task_id, spent_on, minutes, notes, billable, bill_rate_cents, cost_rate_cents)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning *`,
    [person.id, project.id, task?.id || null, spentOn, minutes, notes, isBillable, isBillable ? bill_rate_cents : 0, person.cost_rate_cents],
  );
  const value = cents(minutes, row.bill_rate_cents);
  return {
    json: { entry: row, project: project.name, client: project.client_name, person: person.full_name, task: task?.name || null, value_cents: value },
    text: `Logged ${clock(minutes)} for ${person.full_name} on ${project.name} (${project.client_name})${task ? `, ${task.name}` : ''} on ${spentOn}. ${isBillable ? `Billable at ${money(row.bill_rate_cents, project.currency)}/h, worth ${money(value, project.currency)}` : 'Not billable'}. (${short(row.id)})`,
  };
}

async function cmdAdd(db, args, flags) {
  const [what, ...rest] = args;
  const positional = rest.join(' ').trim();

  if (what === 'client') {
    const name = flags.name || positional;
    if (!name) throw new CliError('Usage: add client "<name>" [--rate=180 --contact= --email= --terms=14 --currency=NZD]');
    const [existing] = await db.query('select * from clients where lower(name) = lower($1)', [name]);
    if (existing) throw new CliError(`"${existing.name}" already exists (${short(existing.id)}).`);
    const [row] = await db.query(
      `insert into clients (name, contact_name, email, address, currency, default_rate_cents, payment_terms_days, notes)
       values ($1, $2, $3, $4, $5, $6, $7, $8) returning *`,
      [name, flags.contact || null, flags.email || null, flags.address || null, flags.currency || 'NZD', parseMoney(flags.rate), Number(flags.terms || 14), flags.notes || null],
    );
    return { json: row, text: `Added client ${row.name} at ${money(row.default_rate_cents, row.currency)}/h, ${row.payment_terms_days} day terms (${short(row.id)})` };
  }

  if (what === 'person') {
    const name = flags.name || positional;
    if (!name) throw new CliError('Usage: add person "<full name>" [--email= --role= --rate=180 --cost=90 --capacity=37.5]');
    const [existing] = await db.query('select * from people where lower(full_name) = lower($1)', [name]);
    if (existing) throw new CliError(`"${existing.full_name}" already exists (${short(existing.id)}).`);
    const capacity = flags.capacity ? Math.round(Number(flags.capacity) * 60) : 2250;
    const [row] = await db.query(
      `insert into people (full_name, email, role, bill_rate_cents, cost_rate_cents, weekly_capacity_minutes)
       values ($1, $2, $3, $4, $5, $6) returning *`,
      [name, flags.email || null, flags.role || null, parseMoney(flags.rate), parseMoney(flags.cost), capacity],
    );
    return { json: row, text: `Added ${row.full_name}${row.role ? `, ${row.role}` : ''} (${short(row.id)})` };
  }

  if (what === 'task') {
    const name = flags.name || positional;
    if (!name) throw new CliError('Usage: add task "<name>" [--nonbillable]');
    const [existing] = await db.query('select * from tasks where lower(name) = lower($1)', [name]);
    if (existing) throw new CliError(`Task "${existing.name}" already exists (${short(existing.id)}).`);
    const [row] = await db.query('insert into tasks (name, billable_default) values ($1, $2) returning *', [name, !flags.nonbillable]);
    return { json: row, text: `Added task ${row.name}${row.billable_default ? '' : ' (not billable by default)'} (${short(row.id)})` };
  }

  if (what === 'project') {
    const name = flags.name || positional;
    if (!name) throw new CliError('Usage: add project "<name>" --client=<name> [--code= --rate=180 --budget-hours=80 --budget=15000 --fee=hourly|fixed|retainer|internal --nonbillable]');
    const client = await resolve(db, 'client', flags.client);
    const [existing] = await db.query('select * from projects where client_id = $1 and lower(name) = lower($2)', [client.id, name]);
    if (existing) throw new CliError(`${client.name} already has a project called "${existing.name}" (${short(existing.id)}).`);
    const fee = String(flags.fee || 'hourly').toLowerCase();
    if (!['hourly', 'fixed', 'retainer', 'internal'].includes(fee)) throw new CliError('--fee must be hourly, fixed, retainer or internal.');
    const budgetMinutes = flags['budget-hours'] ? Math.round(Number(flags['budget-hours']) * 60) : null;
    const [row] = await db.query(
      `insert into projects (client_id, name, code, fee_type, billable, bill_rate_cents, budget_cents, budget_minutes, starts_on, ends_on, notes)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) returning *`,
      [
        client.id, name, flags.code || null, fee, !flags.nonbillable && fee !== 'internal',
        flags.rate ? parseMoney(flags.rate) : null,
        flags.budget ? parseMoney(flags.budget) : null,
        budgetMinutes,
        parseDate(flags.starts, 'start date'),
        parseDate(flags.ends, 'end date'),
        flags.notes || null,
      ],
    );
    return {
      json: { ...row, client_name: client.name },
      text: `Added project ${row.name} for ${client.name}, ${row.fee_type}${budgetMinutes ? `, budget ${clock(budgetMinutes)}` : ''} (${short(row.id)})`,
    };
  }

  if (what === 'expense') {
    const description = flags.description || positional;
    const project = await resolve(db, 'project', flags.project);
    if (!flags.amount) throw new CliError('Usage: add expense "<description>" --project=<name> --amount=120 [--category= --on= --person= --nonbillable]');
    const person = flags.person ? await resolve(db, 'person', flags.person) : null;
    const [row] = await db.query(
      `insert into expenses (project_id, person_id, spent_on, category, description, amount_cents, billable)
       values ($1, $2, $3, $4, $5, $6, $7) returning *`,
      [project.id, person?.id || null, parseDate(flags.on) || today(), flags.category || 'Other', description || null, parseMoney(flags.amount), !flags.nonbillable],
    );
    return {
      json: { ...row, project: project.name, client: project.client_name },
      text: `Added ${money(row.amount_cents, project.currency)} expense on ${project.name}${row.billable ? ', billable' : ', not billable'} (${short(row.id)})`,
    };
  }

  throw new CliError('Usage: add client|person|project|task|expense ...');
}

async function cmdAssign(db, args, flags) {
  const [projectQ, taskQ] = args;
  if (!projectQ || !taskQ) throw new CliError('Usage: assign "<project>" "<task>" [--rate=180] [--nonbillable]');
  const project = await resolve(db, 'project', projectQ);
  const task = await resolve(db, 'task', taskQ);
  const [row] = await db.query(
    `insert into project_tasks (project_id, task_id, billable, bill_rate_cents) values ($1, $2, $3, $4)
     on conflict (project_id, task_id) do update set billable = excluded.billable, bill_rate_cents = excluded.bill_rate_cents
     returning *`,
    [project.id, task.id, !flags.nonbillable, flags.rate ? parseMoney(flags.rate) : null],
  );
  return {
    json: { ...row, project: project.name, task: task.name },
    text: `${task.name} is on ${project.name}${row.bill_rate_cents ? ` at ${money(row.bill_rate_cents, project.currency)}/h` : ''}${row.billable ? '' : ', not billable'}`,
  };
}

async function cmdArchive(db, [q]) {
  const project = await resolve(db, 'project', q);
  const [row] = await db.query(`update projects set status = 'archived' where id = $1 returning *`, [project.id]);
  const [u] = await db.query('select coalesce(sum(total_cents), 0)::bigint as cents from v_unbilled where project_id = $1', [project.id]);
  return {
    json: { ...row, client_name: project.client_name, unbilled_cents: num(u.cents) },
    text: `Archived ${row.name} (${project.client_name}).${num(u.cents) ? ` Careful: ${money(u.cents, project.currency)} is still unbilled on it.` : ''}`,
  };
}

async function cmdActivate(db, [q]) {
  const project = await resolve(db, 'project', q);
  const [row] = await db.query(`update projects set status = 'active' where id = $1 returning *`, [project.id]);
  return { json: { ...row, client_name: project.client_name }, text: `${row.name} (${project.client_name}) is active again.` };
}

async function nextInvoiceNumber(db) {
  const rows = await db.query(`select number from invoices`);
  let max = 1000;
  for (const r of rows) {
    const m = String(r.number).match(/(\d+)\s*$/);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `INV-${max + 1}`;
}

async function invoiceDraft(db, args, flags) {
  const q = args[0] || flags.client;
  let client;
  let project = null;
  if (flags.project) {
    project = await resolve(db, 'project', flags.project);
    client = await resolve(db, 'client', project.client_id);
  } else {
    if (!q) throw new CliError('Usage: invoice draft "<client>" [--project= --through=YYYY-MM-DD --number= --subject=]');
    client = await resolve(db, 'client', q);
  }
  const through = parseDate(flags.through, 'date') || today();
  const entries = await db.query(
    `select t.*, pr.name as project, coalesce(tk.name, 'Work') as task
     from time_entries t join projects pr on pr.id = t.project_id left join tasks tk on tk.id = t.task_id
     where pr.client_id = $1 and t.billable and t.invoice_id is null and t.spent_on <= $2
       and ($3::uuid is null or t.project_id = $3)
     order by pr.name, tk.name, t.spent_on`,
    [client.id, through, project?.id || null],
  );
  const expenseRows = await db.query(
    `select e.*, pr.name as project from expenses e join projects pr on pr.id = e.project_id
     where pr.client_id = $1 and e.billable and e.invoice_id is null and e.spent_on <= $2
       and ($3::uuid is null or e.project_id = $3)
     order by e.spent_on`,
    [client.id, through, project?.id || null],
  );
  if (!entries.length && !expenseRows.length) {
    throw new CliError(`Nothing to invoice for ${client.name} up to ${through}. Run \`unbilled\` to see what is where.`);
  }

  const number = flags.number || (await nextInvoiceNumber(db));
  const issuedOn = parseDate(flags.on) || today();
  const terms = Number(flags.terms || client.payment_terms_days || 14);
  const dueOn = addDays(issuedOn, terms);
  const dates = [...entries.map((e) => isoDate(e.spent_on)), ...expenseRows.map((e) => isoDate(e.spent_on))].sort();
  const subject = flags.subject || `${project ? project.name : 'Services'}, ${dates[0]} to ${dates[dates.length - 1]}`;
  const [invoice] = await db.query(
    `insert into invoices (number, client_id, project_id, subject, issued_on, due_on, period_start, period_end, currency, status)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'draft') returning *`,
    [number, client.id, project?.id || null, subject, issuedOn, dueOn, dates[0], dates[dates.length - 1], client.currency],
  );

  // One line per project + task + rate. Rates differ between people, so they split.
  const groups = new Map();
  for (const e of entries) {
    const key = `${e.project_id}|${e.task}|${num(e.bill_rate_cents)}`;
    if (!groups.has(key)) groups.set(key, { project_id: e.project_id, project: e.project, task: e.task, rate: num(e.bill_rate_cents), minutes: 0, ids: [] });
    const g = groups.get(key);
    g.minutes += num(e.minutes);
    g.ids.push(e.id);
  }
  let position = 0;
  const lines = [];
  for (const g of groups.values()) {
    const quantity = Math.round((g.minutes / 60) * 100) / 100;
    const amount = cents(g.minutes, g.rate);
    const [line] = await db.query(
      `insert into invoice_lines (invoice_id, kind, description, quantity, unit_price_cents, amount_cents, project_id, position)
       values ($1, 'time', $2, $3, $4, $5, $6, $7) returning *`,
      [invoice.id, `${g.project}: ${g.task}`, quantity, g.rate, amount, g.project_id, ++position],
    );
    lines.push(line);
    const placeholders = g.ids.map((_, idx) => `$${idx + 2}`).join(', ');
    await db.query(`update time_entries set invoice_id = $1 where id in (${placeholders})`, [invoice.id, ...g.ids]);
  }
  for (const e of expenseRows) {
    const [line] = await db.query(
      `insert into invoice_lines (invoice_id, kind, description, quantity, unit_price_cents, amount_cents, project_id, position)
       values ($1, 'expense', $2, 1, $3, $3, $4, $5) returning *`,
      [invoice.id, `${e.project}: ${e.category}${e.description ? ` - ${e.description}` : ''} (${isoDate(e.spent_on)})`, num(e.amount_cents), e.project_id, ++position],
    );
    lines.push(line);
    await db.query('update expenses set invoice_id = $1 where id = $2', [invoice.id, e.id]);
  }
  const total = lines.reduce((a, l) => a + num(l.amount_cents), 0);
  const minutes = entries.reduce((a, e) => a + num(e.minutes), 0);
  const text = [
    heading(`Draft invoice ${invoice.number} for ${client.name}`),
    `  ${subject}`,
    `  issued ${issuedOn}, due ${dueOn} (${terms} day terms)`,
    `  ${clock(minutes)} of time across ${entries.length} entries, ${expenseRows.length} expense${expenseRows.length === 1 ? '' : 's'}`,
    '',
    table(lines, [
      { key: 'position', label: '#', align: 'right' },
      { key: 'description', label: 'Description', width: 52 },
      { key: 'quantity', label: 'Qty', align: 'right' },
      { key: 'unit_price_cents', label: 'Rate', align: 'right', format: (v) => money(v, client.currency) },
      { key: 'amount_cents', label: 'Amount', align: 'right', format: (v) => money(v, client.currency) },
    ]),
    `\n  Total ${money(total, client.currency)}`,
    `\n  It is a draft and nothing has been sent. Mark it sent with: invoice send ${invoice.number}`,
  ].join('\n');
  return { json: { invoice, lines, totals: { total_cents: total, minutes, entries: entries.length, expenses: expenseRows.length } }, text };
}

async function invoiceSend(db, args, flags) {
  const inv = await resolve(db, 'invoice', args[0]);
  if (inv.status === 'void') throw new CliError(`${inv.number} is void. Draft a new one.`);
  const sentOn = parseDate(flags.on) || today();
  const [client] = await db.query('select * from clients where id = $1', [inv.client_id]);
  const dueOn = inv.due_on || addDays(sentOn, client.payment_terms_days || 14);
  const [row] = await db.query(
    `update invoices set status = 'sent', sent_at = $2::timestamptz, due_on = $3 where id = $1 returning *`,
    [inv.id, `${sentOn}T09:00:00Z`, dueOn],
  );
  return {
    json: { ...row, client_name: inv.client_name },
    text: `${row.number} is marked sent to ${inv.client_name}, due ${isoDate(row.due_on)}. Nothing was emailed: this repo has no send path.`,
  };
}

async function invoicePaid(db, args, flags) {
  const inv = await resolve(db, 'invoice', args[0]);
  const paidOn = parseDate(flags.on) || today();
  const [status] = await db.query('select * from v_invoice_status where invoice_id = $1', [inv.id]);
  const amount = flags.amount ? parseMoney(flags.amount) : num(status.total_cents);
  const [row] = await db.query(
    `update invoices set status = 'paid', paid_at = $2::timestamptz, paid_amount_cents = $3 where id = $1 returning *`,
    [inv.id, `${paidOn}T09:00:00Z`, amount],
  );
  const days = Math.round((new Date(`${paidOn}T00:00:00`) - new Date(`${isoDate(inv.issued_on)}T00:00:00`)) / 86400000);
  return {
    json: { ...row, client_name: inv.client_name, days_to_pay: days },
    text: `${row.number} paid: ${money(amount, row.currency)} from ${inv.client_name} on ${paidOn}, ${days} days after issue.`,
  };
}

async function invoiceVoid(db, args) {
  const inv = await resolve(db, 'invoice', args[0]);
  const released = await db.query(`update time_entries set invoice_id = null where invoice_id = $1 returning id`, [inv.id]);
  const releasedExpenses = await db.query(`update expenses set invoice_id = null where invoice_id = $1 returning id`, [inv.id]);
  const [row] = await db.query(`update invoices set status = 'void' where id = $1 returning *`, [inv.id]);
  return {
    json: { ...row, released_time_entries: released.length, released_expenses: releasedExpenses.length },
    text: `${row.number} is void. ${released.length} time entries and ${releasedExpenses.length} expenses are unbilled again and will show up in \`unbilled\`.`,
  };
}

async function cmdInvoice(db, args, flags) {
  const [sub, ...rest] = args;
  if (sub === 'draft') return invoiceDraft(db, rest, flags);
  if (sub === 'send') return invoiceSend(db, rest, flags);
  if (sub === 'paid') return invoicePaid(db, rest, flags);
  if (sub === 'void') return invoiceVoid(db, rest, flags);
  if (!sub) throw new CliError('Usage: invoice <number> | invoice draft|send|paid|void ...');
  return cmdInvoiceShow(db, args.join(' '));
}

// ---------------------------------------------------------------------------
// Import: Harvest CSV exports

async function cmdImport(db, args, flags) {
  const source = (args[0] || '').toLowerCase();
  if (source !== 'harvest') throw new CliError('Usage: import harvest --time=<time.csv> [--expenses=<expenses.csv>] [--invoices=<invoices.csv>]');
  if (!flags.time && !flags.expenses && !flags.invoices) {
    throw new CliError('Point me at a Harvest export: --time=time.csv (Reports > Time > Export detailed CSV).');
  }
  const report = {
    clients: { created: 0 },
    projects: { created: 0 },
    people: { created: 0 },
    tasks: { created: 0 },
    time_entries: { created: 0, updated: 0, skipped: 0 },
    expenses: { created: 0, updated: 0 },
    invoices: { created: 0, updated: 0 },
    warnings: [],
  };

  const clientCache = new Map();
  const projectCache = new Map();
  const personCache = new Map();
  const taskCache = new Map();

  async function clientFor(name, currency) {
    if (!name) return null;
    const key = name.toLowerCase();
    if (clientCache.has(key)) return clientCache.get(key);
    let [row] = await db.query('select * from clients where lower(name) = lower($1)', [name]);
    if (!row) {
      [row] = await db.query('insert into clients (name, currency) values ($1, $2) returning *', [name, currencyCode(currency)]);
      report.clients.created++;
    }
    clientCache.set(key, row);
    return row;
  }
  async function projectFor(client, name, code) {
    if (!client || !name) return null;
    const key = `${client.id}|${name.toLowerCase()}`;
    if (projectCache.has(key)) return projectCache.get(key);
    let [row] = await db.query('select * from projects where client_id = $1 and lower(name) = lower($2)', [client.id, name]);
    if (!row) {
      [row] = await db.query('insert into projects (client_id, name, code) values ($1, $2, $3) returning *', [client.id, name, code || null]);
      report.projects.created++;
    }
    projectCache.set(key, row);
    return row;
  }
  async function personFor(name, costRate, billRate) {
    if (!name) return null;
    const key = name.toLowerCase();
    if (personCache.has(key)) return personCache.get(key);
    let [row] = await db.query('select * from people where lower(full_name) = lower($1)', [name]);
    if (!row) {
      [row] = await db.query('insert into people (full_name, cost_rate_cents, bill_rate_cents) values ($1, $2, $3) returning *', [name, costRate || 0, billRate || 0]);
      report.people.created++;
    }
    personCache.set(key, row);
    return row;
  }
  async function taskFor(name) {
    if (!name) return null;
    const key = name.toLowerCase();
    if (taskCache.has(key)) return taskCache.get(key);
    let [row] = await db.query('select * from tasks where lower(name) = lower($1)', [name]);
    if (!row) {
      [row] = await db.query('insert into tasks (name) values ($1) returning *', [name]);
      report.tasks.created++;
    }
    taskCache.set(key, row);
    return row;
  }

  // Invoices first, so time entries can point at them.
  const invoiceByNumber = new Map();
  if (flags.invoices) {
    const rows = parseCsv(readFileSync(path.resolve(String(flags.invoices)), 'utf8'));
    for (const r of rows) {
      const number = pick(r, 'Invoice ID', 'Number', 'ID', 'Invoice Number');
      const clientName = pick(r, 'Client', 'Client Name');
      if (!number || !clientName) {
        report.warnings.push('invoice row with no number or client, skipped');
        continue;
      }
      const client = await clientFor(clientName, pick(r, 'Currency'));
      const issuedOn = parseDate(pick(r, 'Issue Date', 'Issued At', 'Date')) || today();
      const dueOn = parseDate(pick(r, 'Due Date', 'Due At'));
      const paidOn = parseDate(pick(r, 'Paid Date', 'Paid At'));
      const stateRaw = pick(r, 'Status', 'State').toLowerCase();
      const status = paidOn || stateRaw === 'paid' ? 'paid' : stateRaw === 'draft' ? 'draft' : stateRaw === 'closed' ? 'void' : 'sent';
      const amount = parseMoney(pick(r, 'Amount', 'Total'));
      const ref = `hv-invoice-${number}`;
      const [existing] = await db.query('select * from invoices where external_ref = $1 or number = $2', [ref, `INV-${number}`]);
      let invoice = existing;
      if (existing) {
        [invoice] = await db.query(
          `update invoices set client_id = $2, subject = $3, issued_on = $4, due_on = $5, status = $6,
             paid_at = $7::timestamptz, paid_amount_cents = $8 where id = $1 returning *`,
          [existing.id, client.id, pick(r, 'Subject', 'Purchase Order') || null, issuedOn, dueOn, status, paidOn ? `${paidOn}T09:00:00Z` : null, status === 'paid' ? amount : null],
        );
        report.invoices.updated++;
      } else {
        [invoice] = await db.query(
          `insert into invoices (number, client_id, subject, issued_on, due_on, currency, status, sent_at, paid_at, paid_amount_cents, external_ref)
           values ($1, $2, $3, $4, $5, $6, $7, $8::timestamptz, $9::timestamptz, $10, $11) returning *`,
          [
            `INV-${number}`, client.id, pick(r, 'Subject', 'Purchase Order') || null, issuedOn, dueOn, currencyCode(pick(r, 'Currency'), client.currency), status,
            status === 'draft' ? null : `${issuedOn}T09:00:00Z`, paidOn ? `${paidOn}T09:00:00Z` : null, status === 'paid' ? amount : null, ref,
          ],
        );
        report.invoices.created++;
      }
      if (amount) {
        const [line] = await db.query('select id from invoice_lines where invoice_id = $1', [invoice.id]);
        if (!line) {
          await db.query(
            `insert into invoice_lines (invoice_id, kind, description, quantity, unit_price_cents, amount_cents, position)
             values ($1, 'fixed', $2, 1, $3, $3, 1)`,
            [invoice.id, pick(r, 'Subject', 'Purchase Order') || `Harvest invoice ${number}`, amount],
          );
        }
      }
      invoiceByNumber.set(String(number), invoice);
    }
  }

  let alreadyInvoiced = 0;
  if (flags.time) {
    const rows = parseCsv(readFileSync(path.resolve(String(flags.time)), 'utf8'));
    for (const r of rows) {
      const clientName = pick(r, 'Client', 'Client Name');
      const projectName = pick(r, 'Project', 'Project Name');
      const rawHours = pick(r, 'Hours', 'Rounded Hours', 'Hours Rounded');
      if (!clientName || !projectName || !rawHours) {
        report.time_entries.skipped++;
        continue;
      }
      const minutes = Math.round(Number(String(rawHours).replace(/[^0-9.]/g, '')) * 60);
      if (!minutes) {
        report.time_entries.skipped++;
        continue;
      }
      const currency = currencyCode(pick(r, 'Currency'));
      const client = await clientFor(clientName, currency);
      const project = await projectFor(client, projectName, pick(r, 'Project Code', 'Code'));
      const first = pick(r, 'First Name', 'First name');
      const last = pick(r, 'Last Name', 'Last name');
      const fullName = pick(r, 'Person', 'Name') || [first, last].filter(Boolean).join(' ');
      const billRate = parseMoney(pick(r, 'Billable Rate', 'Bill Rate'));
      const costRate = parseMoney(pick(r, 'Cost Rate'));
      const person = await personFor(fullName || 'Unknown', costRate, billRate);
      const task = await taskFor(pick(r, 'Task', 'Task Name'));
      const billable = yesNo(pick(r, 'Billable', 'Billable?'), true);
      const invoiced = yesNo(pick(r, 'Invoiced', 'Invoiced?'), false);
      if (invoiced && flags['skip-invoiced']) {
        report.time_entries.skipped++;
        continue;
      }
      const spentOn = parseDate(pick(r, 'Date', 'Spent Date', 'Spent At')) || today();
      const notes = pick(r, 'Notes', 'Note') || null;
      const invoiceNumber = pick(r, 'Invoice ID', 'Invoice Number');
      const invoice = invoiceNumber ? invoiceByNumber.get(String(invoiceNumber)) : null;
      // Harvest has no stable per-entry id in the CSV, so the natural key is the row itself.
      const ref = `hv-time-${spentOn}-${person.id}-${project.id}-${task?.id || 'none'}-${minutes}-${(notes || '').slice(0, 40)}`;
      const [existing] = await db.query('select * from time_entries where external_ref = $1', [ref]);
      if (existing) {
        await db.query(
          `update time_entries set minutes = $2, billable = $3, bill_rate_cents = $4, cost_rate_cents = $5, invoice_id = coalesce($6, invoice_id) where id = $1`,
          [existing.id, minutes, billable, billRate, costRate, invoice?.id || null],
        );
        report.time_entries.updated++;
        continue;
      }
      await db.query(
        `insert into time_entries (person_id, project_id, task_id, spent_on, minutes, notes, billable, bill_rate_cents, cost_rate_cents, invoice_id, external_ref)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [person.id, project.id, task?.id || null, spentOn, minutes, notes, billable, billRate, costRate, invoice?.id || null, ref],
      );
      if (invoiced && !invoice) alreadyInvoiced++;
      report.time_entries.created++;
      if (task) {
        await db.query('insert into project_tasks (project_id, task_id) values ($1, $2) on conflict (project_id, task_id) do nothing', [project.id, task.id]);
      }
      if (billRate && !project.bill_rate_cents) {
        await db.query('update projects set bill_rate_cents = $2 where id = $1 and bill_rate_cents is null', [project.id, billRate]);
        project.bill_rate_cents = billRate;
      }
    }
  }

  if (flags.expenses) {
    const rows = parseCsv(readFileSync(path.resolve(String(flags.expenses)), 'utf8'));
    for (const r of rows) {
      const clientName = pick(r, 'Client', 'Client Name');
      const projectName = pick(r, 'Project', 'Project Name');
      const amount = parseMoney(pick(r, 'Amount', 'Total Cost', 'Cost'));
      if (!clientName || !projectName || !amount) continue;
      const client = await clientFor(clientName, pick(r, 'Currency'));
      const project = await projectFor(client, projectName, pick(r, 'Project Code', 'Code'));
      const spentOn = parseDate(pick(r, 'Date', 'Spent Date', 'Spent At')) || today();
      const category = pick(r, 'Category', 'Expense Category') || 'Other';
      const notes = pick(r, 'Notes', 'Note') || null;
      const ref = `hv-expense-${spentOn}-${project.id}-${category}-${amount}`;
      const [existing] = await db.query('select id from expenses where external_ref = $1', [ref]);
      if (existing) {
        await db.query('update expenses set amount_cents = $2, description = $3 where id = $1', [existing.id, amount, notes]);
        report.expenses.updated++;
        continue;
      }
      const person = await personFor(pick(r, 'Person', 'Name') || [pick(r, 'First Name'), pick(r, 'Last Name')].filter(Boolean).join(' '), 0, 0);
      await db.query(
        `insert into expenses (project_id, person_id, spent_on, category, description, amount_cents, billable, external_ref)
         values ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [project.id, person?.id || null, spentOn, category, notes, amount, yesNo(pick(r, 'Billable', 'Billable?'), true), ref],
      );
      report.expenses.created++;
    }
  }

  if (alreadyInvoiced) {
    report.already_invoiced = alreadyInvoiced;
    report.warnings.push(
      `${alreadyInvoiced} entries are marked invoiced in Harvest but the time export does not carry an invoice number. ` +
        'They will show as unbilled here. Re-run with --skip-invoiced to leave them out, or filter them out in Harvest before exporting.',
    );
  }
  const text = [
    heading('Harvest import'),
    `  Clients      ${report.clients.created} created`,
    `  Projects     ${report.projects.created} created`,
    `  People       ${report.people.created} created`,
    `  Tasks        ${report.tasks.created} created`,
    `  Time entries ${report.time_entries.created} created, ${report.time_entries.updated} updated, ${report.time_entries.skipped} skipped`,
    `  Expenses     ${report.expenses.created} created, ${report.expenses.updated} updated`,
    `  Invoices     ${report.invoices.created} created, ${report.invoices.updated} updated`,
    ...report.warnings.slice(0, 10).map((w) => `  warning: ${w}`),
    report.warnings.length > 10 ? `  warning: and ${report.warnings.length - 10} more` : '',
    '\n  Re-running the same files is safe. Rates and budgets need a look: run `projects` and set what Harvest did not export.',
  ]
    .filter(Boolean)
    .join('\n');
  return { json: report, text };
}

async function cmdExport(db, args, flags) {
  const out = { exported_at: new Date().toISOString() };
  for (const t of ['clients', 'people', 'tasks', 'projects', 'project_tasks', 'invoices', 'invoice_lines', 'time_entries', 'expenses']) {
    out[t] = await db.query(`select * from ${t} order by created_at`);
  }
  const json = JSON.stringify(out, null, 2);
  if (flags.out) {
    const file = path.resolve(String(flags.out));
    writeFileSync(file, json);
    const counts = Object.fromEntries(Object.entries(out).filter(([k]) => k !== 'exported_at').map(([k, v]) => [k, v.length]));
    return { json: { written: file, counts }, text: `Wrote ${file}` };
  }
  return { json: out, text: json };
}

// ---------------------------------------------------------------------------

const HELP = `time-billing-for-claude-code

  timesheet [--person= --from= --to= --last]   hours by day, person and project (this week by default)
  report --by=client|project|task|person       time report for a date range (--from= --to=)
  projects [q] [--all]                         every project with budget used and unbilled value
  project <name|id>                            one project: budget, people, tasks, expenses, invoices, recent time
  clients [q] [--all]                          every client with unbilled, owed and overdue
  client <name|id>                             one client: projects, unbilled work, invoices, how fast they pay
  team [--all]                                 hours, billable share and utilisation per person
  tasks                                        the task list and where the hours went
  unbilled [q]                                 billable work that is not on an invoice yet
  invoices [--status=draft|sent|paid] [--all]  invoice list with what is overdue
  invoice <number|id>                          one invoice with its lines and what it covers
  attention                                    overdue invoices, ageing work, budget risk, quiet projects
  stats                                        utilisation, effective rate, unbilled, owed, days to pay

  log "<project>" <duration> [--task= --person= --on=YYYY-MM-DD --notes="..." --nonbillable]
  add client "<name>" [--rate=180 --contact= --email= --terms=14 --currency=NZD]
  add person "<full name>" [--role= --email= --rate=180 --cost=90 --capacity=37.5]
  add project "<name>" --client=<name> [--code= --rate= --budget-hours=80 --fee=hourly|fixed|retainer|internal]
  add task "<name>" [--nonbillable]
  add expense "<description>" --project=<name> --amount=120 [--category= --on= --person= --nonbillable]
  assign "<project>" "<task>" [--rate=180] [--nonbillable]
  archive <project> | activate <project>

  invoice draft "<client>" [--project= --through=YYYY-MM-DD --number= --subject= --terms=]
  invoice send <number> [--on=]                mark sent (nothing is emailed from here)
  invoice paid <number> [--on= --amount=]      mark paid
  invoice void <number>                        void it and release its time back to unbilled

  import harvest --time=<csv> [--expenses=<csv>] [--invoices=<csv>] [--skip-invoiced]
  export [--out=file.json]

Durations: 90m, 1.5, 1:30, 2h15. Money in whole dollars: --rate=180 means $180.
Any command takes --json for machine-readable output.
Ids can be shortened to their first 8 characters. Names match case-insensitively.
`;

const COMMANDS = {
  timesheet: cmdTimesheet,
  report: cmdReport,
  projects: cmdProjects,
  project: cmdProject,
  clients: cmdClients,
  client: cmdClient,
  team: cmdTeam,
  tasks: cmdTasks,
  unbilled: cmdUnbilled,
  invoices: cmdInvoices,
  invoice: cmdInvoice,
  attention: cmdAttention,
  stats: cmdStats,
  log: cmdLog,
  add: cmdAdd,
  assign: cmdAssign,
  archive: cmdArchive,
  activate: cmdActivate,
  import: cmdImport,
  export: cmdExport,
};

async function main() {
  const { args, flags } = parseArgv(process.argv.slice(2));
  const [command, ...rest] = args;
  if (!command || command === 'help' || flags.help) {
    process.stdout.write(HELP);
    return 0;
  }
  const fn = COMMANDS[command];
  if (!fn) {
    process.stderr.write(`Unknown command "${command}".\n\n${HELP}`);
    return 1;
  }
  const db = await getDb();
  try {
    const result = await fn(db, rest, flags);
    if (flags.json) process.stdout.write(JSON.stringify(result.json, null, 2) + '\n');
    else process.stdout.write(result.text.replace(/^\n/, '') + '\n');
    return 0;
  } catch (e) {
    if (e instanceof CliError) {
      process.stderr.write(`${e.message}\n`);
      return e.code;
    }
    if (/relation .* does not exist/.test(e.message)) {
      process.stderr.write('The database has no tables yet. Run: npm run migrate\n');
      return 1;
    }
    throw e;
  } finally {
    await db.close();
  }
}

process.exitCode = await main();
