#!/usr/bin/env node
// Loads supabase/seed.sql: a demo studio with clients, projects, people, time, expenses and invoices.
// Every row has a stable id and inserts with ON CONFLICT DO NOTHING, so re-running is harmless.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { getDb, REPO_ROOT } from './lib/db.mjs';

export async function seed(db) {
  const sql = readFileSync(path.join(REPO_ROOT, 'supabase', 'seed.sql'), 'utf8');
  await db.exec(sql);
  const [c] = await db.query(`
    select (select count(*) from clients)      as clients,
           (select count(*) from projects)     as projects,
           (select count(*) from people)       as people,
           (select count(*) from time_entries) as time_entries,
           (select count(*) from expenses)     as expenses,
           (select count(*) from invoices)     as invoices
  `);
  return Object.fromEntries(Object.entries(c).map(([k, v]) => [k, Number(v)]));
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  const db = await getDb();
  try {
    const counts = await seed(db);
    console.log(
      `seed: ${counts.clients} clients, ${counts.projects} projects, ${counts.people} people, ` +
        `${counts.time_entries} time entries, ${counts.expenses} expenses, ${counts.invoices} invoices`,
    );
  } finally {
    await db.close();
  }
}
