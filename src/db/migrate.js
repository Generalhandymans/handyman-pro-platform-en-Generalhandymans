// Migration runner (PostgreSQL only). Applies src/db/migrations/*.sql in name
// order, once each, tracked in schema_migrations. SQLite keeps its in-code
// "CREATE IF NOT EXISTS / ALTER" migrations in src/db.js.
//
// If you applied 001_initial.sql by hand BEFORE this runner existed, mark it as
// done first:  INSERT INTO schema_migrations (name) VALUES ('001_initial.sql');
'use strict';
const fs = require('fs');
const path = require('path');
const db = require('../db');

async function migrate() {
  if (!db._isPg) return { applied: [] };
  await db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name TEXT PRIMARY KEY, applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP)`);
  const dir = path.join(__dirname, 'migrations');
  const applied = [];
  for (const f of fs.readdirSync(dir).filter(x => x.endsWith('.sql')).sort()) {
    const done = await db.prepare('SELECT name FROM schema_migrations WHERE name = ?').get(f);
    if (done) continue;
    await db.transaction(async (t) => {
      await t.exec(fs.readFileSync(path.join(dir, f), 'utf8'));
      // Explicit RETURNING: the pg adapter appends "RETURNING id" to INSERTs without one,
      // and this table has no id column.
      await t.prepare('INSERT INTO schema_migrations (name) VALUES (?) RETURNING name').run(f);
    });
    applied.push(f);
    console.log('[migrate] applied', f);
  }
  return { applied };
}

module.exports = migrate;
if (require.main === module) {
  migrate().then(() => db.close && db.close()).catch((e) => { console.error(e); process.exit(1); });
}
