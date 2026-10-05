// PostgreSQL adapter with a better-sqlite3-compatible interface.
//
// The app was written against better-sqlite3's synchronous API:
//   db.prepare(sql).get(...params)  -> row | undefined
//   db.prepare(sql).all(...params)  -> rows[]
//   db.prepare(sql).run(...params)  -> { lastInsertRowid, changes }
//   db.exec(sql)
//   db.transaction(fn) -> fn
//
// This module exposes the same shapes, but async (all methods return
// promises). `?` placeholders are translated to $1, $2, ... INSERTs get
// `RETURNING id` appended so lastInsertRowid keeps working.
//
// Usage: const db = require('./db'); // db.js picks sqlite or pg by DATABASE_URL
'use strict';

const { Pool, types } = require('pg');

// PostgreSQL returns BIGINT as strings by default; the app compares ids with
// === against numbers, so parse them as integers (safe: ids fit in 53 bits).
types.setTypeParser(20, (v) => (v === null ? null : parseInt(v, 10)));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
  max: Number(process.env.PG_POOL_MAX || 10),
});

pool.on('error', (err) => {
  console.error('[pg] pool error:', err.message);
});

function toPgPlaceholders(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => '$' + (++i));
}

function makeStatement(client, sql) {
  const pgSql = toPgPlaceholders(sql);
  const isInsert = /^\s*INSERT\s+/i.test(sql);
  const runSql = isInsert && !/RETURNING\s+/i.test(sql) ? pgSql + ' RETURNING id' : pgSql;
  return {
    get: async (...params) => {
      const r = await client.query(pgSql, params);
      return r.rows[0]; // undefined when empty, like better-sqlite3
    },
    all: async (...params) => {
      const r = await client.query(pgSql, params);
      return r.rows;
    },
    run: async (...params) => {
      const r = await client.query(runSql, params);
      return {
        lastInsertRowid: r.rows[0] ? Number(r.rows[0].id) : undefined,
        changes: typeof r.rowCount === 'number' ? r.rowCount : 0,
      };
    },
  };
}

const db = {
  _pool: pool,
  _isPg: true,

  prepare(sql) {
    return makeStatement(pool, sql);
  },

  async exec(sql) {
    await pool.query(sql);
  },

  // New async pattern (both backends):
  //   const result = await db.transaction(async (t) => {
  //     await t.prepare('INSERT ...').run(...);
  //   });
  // On PostgreSQL this is a real transaction. Callbacks receive the
  // transaction-bound client as their first argument.
  transaction(fn) {
    return (async () => {
      const client = await pool.connect();
      const txDb = {
        _isPg: true,
        prepare: (sql) => makeStatement(client, sql),
        exec: (sql) => client.query(sql),
      };
      try {
        await client.query('BEGIN');
        const result = await fn(txDb);
        await client.query('COMMIT');
        return result;
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }
    })();
  },

  async close() {
    await pool.end();
  },
};

module.exports = db;
