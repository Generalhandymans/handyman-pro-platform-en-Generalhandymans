#!/usr/bin/env node
// Helpman — SQLite → PostgreSQL data migration.
// Usage: DATABASE_URL=postgresql://... node src/db/migrate-to-postgres.js /path/to/handyman.db
//
// - Target DB must already have the schema (src/db/migrations/001_initial.sql).
// - Copies tables in FK-safe order, preserving IDs.
// - Resets BIGSERIAL sequences to MAX(id)+1 afterwards.
// - Dry-run with DRY_RUN=1 (counts only, no writes).
'use strict';

const fs = require('fs');
const path = require('path');

const SQLITE_PATH = process.argv[2] || path.join(__dirname, '..', '..', 'data', 'handyman.db');
const DATABASE_URL = process.env.DATABASE_URL;
const DRY_RUN = process.env.DRY_RUN === '1';

if (!DATABASE_URL) {
  console.error('DATABASE_URL is required.');
  process.exit(1);
}
if (!fs.existsSync(SQLITE_PATH)) {
  console.error('SQLite file not found:', SQLITE_PATH);
  process.exit(1);
}

// FK-safe order: parents before children.
const TABLES = [
  'users',
  'contractors',
  'job_requests',
  'estimates',
  'quotes',
  'projects',
  'photos',
  'milestones',
  'payments',
  'email_templates',
  'campaigns',
  'email_outbox',
  'email_log',
  'reviews',
  'referrals',
  'followup_tasks',
  'interactions',
  'message_threads',
  'messages',
  'admin_audit',
  'terms_acceptances',
];

async function main() {
  const Database = require('better-sqlite3');
  const { Client } = require('pg');
  const lite = new Database(SQLITE_PATH, { readonly: true });
  const pg = new Client({ connectionString: DATABASE_URL });
  await pg.connect();

  try {
    await pg.query('BEGIN');
    let total = 0;
    for (const table of TABLES) {
      const cols = lite.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
      if (!cols.length) { console.log(`(skip) ${table}: not in SQLite`); continue; }
      const rows = lite.prepare(`SELECT * FROM ${table}`).all();
      // Only copy columns that exist in the target table.
      const targetCols = (await pg.query(
        `SELECT column_name FROM information_schema.columns WHERE table_name = $1`, [table]
      )).rows.map(r => r.column_name);
      const useCols = cols.filter(c => targetCols.includes(c));
      const skipped = cols.filter(c => !targetCols.includes(c));
      if (skipped.length) console.log(`(note) ${table}: skipping columns not in PG: ${skipped.join(', ')}`);

      if (!DRY_RUN && rows.length) {
        const colList = useCols.map(c => `"${c}"`).join(', ');
        // Chunked inserts to stay under parameter limits.
        for (let i = 0; i < rows.length; i += 500) {
          const slice = rows.slice(i, i + 500);
          const vals = [];
          const ph = slice.map((row, r) => {
            useCols.forEach(c => vals.push(row[c]));
            return `(${useCols.map((_, j) => `$${r * useCols.length + j + 1}`).join(', ')})`;
          }).join(', ');
          await pg.query(`INSERT INTO "${table}" (${colList}) VALUES ${ph}`, vals);
        }
      }
      // Reset the sequence past the max id.
      if (!DRY_RUN) {
        await pg.query(
          `SELECT setval(pg_get_serial_sequence($1, 'id'), COALESCE((SELECT MAX(id) FROM "${table}"), 0) + 1, false)`,
          [table]
        );
      }
      total += rows.length;
      console.log(`${DRY_RUN ? '[dry-run] ' : ''}${table}: ${rows.length} rows`);
    }
    if (DRY_RUN) {
      await pg.query('ROLLBACK');
      console.log('Dry run complete — no changes made.');
    } else {
      await pg.query('COMMIT');
      console.log(`Migration complete: ${total} rows across ${TABLES.length} tables.`);
    }
  } catch (e) {
    await pg.query('ROLLBACK');
    throw e;
  } finally {
    await pg.end();
    lite.close();
  }
}

main().catch(e => { console.error('Migration failed:', e.message); process.exit(1); });
