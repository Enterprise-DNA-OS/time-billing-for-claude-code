-- time-billing-for-claude-code: core schema.
-- Runs unchanged on PGlite (embedded) and on Postgres / Supabase.
-- Money is stored in cents. Time is stored in whole minutes.

create or replace function set_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end
$$;

-- Clients ------------------------------------------------------------------

create table if not exists clients (
  id                 uuid primary key default gen_random_uuid(),
  name               text not null,
  contact_name       text,
  email              text,
  address            text,
  currency           text not null default 'NZD',
  default_rate_cents bigint not null default 0,
  payment_terms_days integer not null default 14,
  notes              text,
  archived           boolean not null default false,
  external_ref       text unique,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create unique index if not exists clients_name_lower_idx on clients (lower(name));

-- People (whoever logs time) ------------------------------------------------

create table if not exists people (
  id                      uuid primary key default gen_random_uuid(),
  full_name               text not null,
  email                   text,
  role                    text,
  cost_rate_cents         bigint not null default 0,
  bill_rate_cents         bigint not null default 0,
  weekly_capacity_minutes integer not null default 2250,
  active                  boolean not null default true,
  external_ref            text unique,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);
create unique index if not exists people_name_lower_idx on people (lower(full_name));

-- Tasks (the kind of work, shared across projects) --------------------------

create table if not exists tasks (
  id               uuid primary key default gen_random_uuid(),
  name             text not null,
  billable_default boolean not null default true,
  external_ref     text unique,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create unique index if not exists tasks_name_lower_idx on tasks (lower(name));

-- Projects ------------------------------------------------------------------

create table if not exists projects (
  id              uuid primary key default gen_random_uuid(),
  client_id       uuid not null references clients(id) on delete cascade,
  name            text not null,
  code            text,
  status          text not null default 'active' check (status in ('active', 'archived')),
  fee_type        text not null default 'hourly' check (fee_type in ('hourly', 'fixed', 'retainer', 'internal')),
  billable        boolean not null default true,
  bill_rate_cents bigint,
  budget_cents    bigint,
  budget_minutes  integer,
  starts_on       date,
  ends_on         date,
  notes           text,
  external_ref    text unique,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create unique index if not exists projects_client_name_idx on projects (client_id, lower(name));
create index if not exists projects_status_idx on projects (status);

-- Which tasks a project uses, and at what rate ------------------------------

create table if not exists project_tasks (
  project_id      uuid not null references projects(id) on delete cascade,
  task_id         uuid not null references tasks(id) on delete cascade,
  billable        boolean not null default true,
  bill_rate_cents bigint,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  primary key (project_id, task_id)
);

-- Invoices ------------------------------------------------------------------

create table if not exists invoices (
  id                uuid primary key default gen_random_uuid(),
  number            text not null unique,
  client_id         uuid not null references clients(id) on delete cascade,
  project_id        uuid references projects(id) on delete set null,
  subject           text,
  issued_on         date not null default current_date,
  due_on            date,
  period_start      date,
  period_end        date,
  currency          text not null default 'NZD',
  status            text not null default 'draft' check (status in ('draft', 'sent', 'paid', 'void')),
  sent_at           timestamptz,
  paid_at           timestamptz,
  paid_amount_cents bigint,
  notes             text,
  external_ref      text unique,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index if not exists invoices_client_idx on invoices (client_id);
create index if not exists invoices_status_idx on invoices (status);

create table if not exists invoice_lines (
  id               uuid primary key default gen_random_uuid(),
  invoice_id       uuid not null references invoices(id) on delete cascade,
  kind             text not null default 'time' check (kind in ('time', 'expense', 'fixed', 'discount')),
  description      text not null,
  quantity         numeric(12, 2) not null default 1,
  unit_price_cents bigint not null default 0,
  amount_cents     bigint not null default 0,
  project_id       uuid references projects(id) on delete set null,
  position         integer not null default 0,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index if not exists invoice_lines_invoice_idx on invoice_lines (invoice_id, position);

-- Time entries ---------------------------------------------------------------

create table if not exists time_entries (
  id              uuid primary key default gen_random_uuid(),
  person_id       uuid not null references people(id) on delete cascade,
  project_id      uuid not null references projects(id) on delete cascade,
  task_id         uuid references tasks(id) on delete set null,
  spent_on        date not null default current_date,
  minutes         integer not null check (minutes > 0),
  notes           text,
  billable        boolean not null default true,
  bill_rate_cents bigint not null default 0,
  cost_rate_cents bigint not null default 0,
  invoice_id      uuid references invoices(id) on delete set null,
  external_ref    text unique,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists time_entries_project_idx on time_entries (project_id, spent_on desc);
create index if not exists time_entries_person_idx on time_entries (person_id, spent_on desc);
create index if not exists time_entries_unbilled_idx on time_entries (project_id) where billable and invoice_id is null;

-- Expenses --------------------------------------------------------------------

create table if not exists expenses (
  id           uuid primary key default gen_random_uuid(),
  project_id   uuid not null references projects(id) on delete cascade,
  person_id    uuid references people(id) on delete set null,
  spent_on     date not null default current_date,
  category     text not null default 'Other',
  description  text,
  amount_cents bigint not null default 0,
  billable     boolean not null default true,
  invoice_id   uuid references invoices(id) on delete set null,
  external_ref text unique,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists expenses_project_idx on expenses (project_id, spent_on desc);

-- updated_at triggers ----------------------------------------------------------

drop trigger if exists clients_updated_at on clients;
create trigger clients_updated_at before update on clients for each row execute function set_updated_at();
drop trigger if exists people_updated_at on people;
create trigger people_updated_at before update on people for each row execute function set_updated_at();
drop trigger if exists tasks_updated_at on tasks;
create trigger tasks_updated_at before update on tasks for each row execute function set_updated_at();
drop trigger if exists projects_updated_at on projects;
create trigger projects_updated_at before update on projects for each row execute function set_updated_at();
drop trigger if exists project_tasks_updated_at on project_tasks;
create trigger project_tasks_updated_at before update on project_tasks for each row execute function set_updated_at();
drop trigger if exists invoices_updated_at on invoices;
create trigger invoices_updated_at before update on invoices for each row execute function set_updated_at();
drop trigger if exists invoice_lines_updated_at on invoice_lines;
create trigger invoice_lines_updated_at before update on invoice_lines for each row execute function set_updated_at();
drop trigger if exists time_entries_updated_at on time_entries;
create trigger time_entries_updated_at before update on time_entries for each row execute function set_updated_at();
drop trigger if exists expenses_updated_at on expenses;
create trigger expenses_updated_at before update on expenses for each row execute function set_updated_at();

-- Starter tasks ------------------------------------------------------------------

insert into tasks (id, name, billable_default) values
  ('10000001-0000-4000-8000-000000000001', 'Discovery',          true),
  ('10000002-0000-4000-8000-000000000002', 'Design',             true),
  ('10000003-0000-4000-8000-000000000003', 'Development',        true),
  ('10000004-0000-4000-8000-000000000004', 'Project management', true),
  ('10000005-0000-4000-8000-000000000005', 'Testing',            true),
  ('10000006-0000-4000-8000-000000000006', 'Support',            true),
  ('10000007-0000-4000-8000-000000000007', 'Internal',           false)
on conflict do nothing;

-- Views ---------------------------------------------------------------------------

-- One row per project: hours logged, what it is worth, what is still unbilled,
-- what it cost us, and how much of the budget is gone.
create or replace view v_project_health as
select
  p.id                                                                     as project_id,
  p.name                                                                   as project,
  p.code,
  c.id                                                                     as client_id,
  c.name                                                                   as client,
  c.currency,
  p.status,
  p.fee_type,
  p.billable,
  p.budget_minutes,
  p.budget_cents,
  coalesce(sum(t.minutes), 0)::integer                                     as minutes,
  coalesce(sum(t.minutes) filter (where t.billable), 0)::integer           as billable_minutes,
  coalesce(sum(case when t.billable then round(t.minutes::numeric * t.bill_rate_cents / 60) else 0 end), 0)::bigint as billable_cents,
  coalesce(sum(case when t.billable and t.invoice_id is null then round(t.minutes::numeric * t.bill_rate_cents / 60) else 0 end), 0)::bigint as unbilled_cents,
  coalesce(sum(round(t.minutes::numeric * t.cost_rate_cents / 60)), 0)::bigint as cost_cents,
  max(t.spent_on)                                                          as last_entry_on,
  case
    when max(t.spent_on) is null then null
    else (current_date - max(t.spent_on))::integer
  end                                                                      as days_since_entry,
  case
    when p.budget_minutes is null or p.budget_minutes = 0 then null
    else round(coalesce(sum(t.minutes), 0)::numeric * 100 / p.budget_minutes)::integer
  end                                                                      as budget_pct
from projects p
join clients c on c.id = p.client_id
left join time_entries t on t.project_id = p.id
group by p.id, p.name, p.code, c.id, c.name, c.currency, p.status, p.fee_type, p.billable, p.budget_minutes, p.budget_cents;

-- Work done and not yet on an invoice, by project. This is the money on the floor.
create or replace view v_unbilled as
with t as (
  select project_id,
         sum(minutes)::integer                                        as minutes,
         sum(round(minutes::numeric * bill_rate_cents / 60))::bigint   as cents,
         min(spent_on)                                                 as oldest_on,
         max(spent_on)                                                 as newest_on
  from time_entries
  where billable and invoice_id is null
  group by project_id
),
e as (
  select project_id,
         sum(amount_cents)::bigint as cents,
         count(*)::integer         as items,
         min(spent_on)             as oldest_on
  from expenses
  where billable and invoice_id is null
  group by project_id
)
select
  p.id                                                     as project_id,
  p.name                                                   as project,
  c.id                                                     as client_id,
  c.name                                                   as client,
  c.currency,
  p.fee_type,
  p.status,
  coalesce(t.minutes, 0)                                   as minutes,
  coalesce(t.cents, 0)                                     as time_cents,
  coalesce(e.cents, 0)                                     as expense_cents,
  coalesce(e.items, 0)                                     as expense_items,
  coalesce(t.cents, 0) + coalesce(e.cents, 0)              as total_cents,
  least(t.oldest_on, e.oldest_on)                          as oldest_on,
  t.newest_on,
  (current_date - least(t.oldest_on, e.oldest_on))::integer as days_old
from projects p
join clients c on c.id = p.client_id
left join t on t.project_id = p.id
left join e on e.project_id = p.id
where coalesce(t.cents, 0) + coalesce(e.cents, 0) > 0;

-- Every invoice with its total, its age and how far past due it is.
create or replace view v_invoice_status as
select
  i.id                                as invoice_id,
  i.number,
  i.status,
  c.id                                as client_id,
  c.name                              as client,
  i.subject,
  i.issued_on,
  i.due_on,
  i.currency,
  coalesce(l.total_cents, 0)          as total_cents,
  coalesce(l.line_count, 0)           as line_count,
  i.paid_amount_cents,
  i.sent_at,
  i.paid_at,
  (current_date - i.issued_on)::integer as age_days,
  case
    when i.status in ('paid', 'void') or i.due_on is null then 0
    else greatest((current_date - i.due_on)::integer, 0)
  end                                 as days_overdue
from invoices i
join clients c on c.id = i.client_id
left join (
  select invoice_id, sum(amount_cents)::bigint as total_cents, count(*)::integer as line_count
  from invoice_lines group by invoice_id
) l on l.invoice_id = i.id;

-- Everything that wants a decision this week, in one list.
--   invoice_overdue   sent invoice past its due date
--   unbilled_ageing   billable work sitting uninvoiced for 30+ days
--   budget_risk       active project at 90% of its hours budget or past it
--   project_quiet     active billable project with no time logged for 14+ days
--   timesheet_gap     active person who has not logged time for 5+ days
create or replace view v_attention_due as
select
  'invoice_overdue'::text as reason,
  'invoice'::text         as ref_type,
  s.invoice_id            as ref_id,
  s.number                as label,
  s.client,
  s.days_overdue          as days,
  s.total_cents           as amount_cents,
  ('due ' || s.due_on::text)::text as detail
from v_invoice_status s
where s.status = 'sent' and s.days_overdue > 0

union all

select
  'unbilled_ageing',
  'project',
  u.project_id,
  u.project,
  u.client,
  u.days_old,
  u.total_cents,
  (round(u.minutes::numeric / 60, 1)::text || 'h uninvoiced since ' || u.oldest_on::text)
from v_unbilled u
where u.days_old >= 30

union all

select
  'budget_risk',
  'project',
  h.project_id,
  h.project,
  h.client,
  h.budget_pct,
  h.unbilled_cents,
  (h.budget_pct::text || '% of a ' || round(h.budget_minutes::numeric / 60)::text || 'h budget used')
from v_project_health h
where h.status = 'active' and h.budget_pct is not null and h.budget_pct >= 90

union all

select
  'project_quiet',
  'project',
  h.project_id,
  h.project,
  h.client,
  coalesce(h.days_since_entry, 999),
  h.unbilled_cents,
  case when h.last_entry_on is null then 'no time logged yet' else 'last entry ' || h.last_entry_on::text end
from v_project_health h
where h.status = 'active' and h.billable and (h.last_entry_on is null or h.last_entry_on < current_date - 14)

union all

select
  'timesheet_gap',
  'person',
  p.id,
  p.full_name,
  null::text,
  case when max(t.spent_on) is null then 999 else (current_date - max(t.spent_on))::integer end,
  0::bigint,
  case when max(t.spent_on) is null then 'no time logged yet' else 'last entry ' || max(t.spent_on)::text end
from people p
left join time_entries t on t.person_id = p.id
where p.active
group by p.id, p.full_name
having max(t.spent_on) is null or max(t.spent_on) < current_date - 5;
