#!/usr/bin/env node
// Applies supabase/migrations/*.sql in filename order, once each, tracked in
// schema_migrations. Safe to run every time. Works on Postgres and embedded.
import fs from 'node:fs';
import path from 'node:path';
import { getDb } from './lib/db.mjs';

const dir = path.resolve(process.cwd(), 'supabase', 'migrations');
const db = await getDb();
await db.exec(`create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())`);
const done = new Set((await db.query('select name from schema_migrations')).map((r) => r.name));
const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort() : [];
let applied = 0;
for (const f of files) {
  if (done.has(f)) continue;
  await db.exec(fs.readFileSync(path.join(dir, f), 'utf8'));
  await db.query('insert into schema_migrations (name) values ($1)', [f]);
  console.log(`applied ${f}`);
  applied++;
}
console.log(applied ? `${applied} migration(s) applied (${db.mode})` : `schema up to date (${db.mode})`);
await db.close();
