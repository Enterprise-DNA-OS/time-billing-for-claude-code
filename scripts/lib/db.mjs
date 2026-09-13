// One database adapter for every Enterprise DNA rebuild.
//
//   DATABASE_URL set  -> node-postgres Pool (your Postgres, Supabase, Neon, RDS, anything)
//   DATABASE_URL unset -> PGlite, a real Postgres embedded in Node, persisted at ./.data/<name>
//
// Both paths expose the same tiny surface so every script and every slash
// command runs unchanged on a laptop with nothing installed and on a shared
// team database.
//
//   const db = await getDb();
//   const rows = await db.query('select * from companies where name ilike $1', ['%acme%']);
//   await db.close();

import path from 'node:path';
import fs from 'node:fs';

const DATA_DIR = process.env.CRM_DATA_DIR || process.env.DATA_DIR || path.resolve(process.cwd(), '.data', 'db');

export async function getDb() {
  if (process.env.DATABASE_URL) {
    const { default: pg } = await import('pg');
    const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
    return {
      mode: 'postgres',
      async query(sql, params = []) { const r = await pool.query(sql, params); return r.rows; },
      async exec(sql) { await pool.query(sql); },
      async close() { await pool.end(); },
    };
  }
  const { PGlite } = await import('@electric-sql/pglite');
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const lite = new PGlite(DATA_DIR);
  await lite.waitReady;
  return {
    mode: 'embedded',
    dataDir: DATA_DIR,
    async query(sql, params = []) { const r = await lite.query(sql, params); return r.rows; },
    async exec(sql) { await lite.exec(sql); },
    async close() { await lite.close(); },
  };
}
