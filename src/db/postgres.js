'use strict';

const { Pool } = require('pg');
const { validateEnv } = require('../config/env');

const cfg = validateEnv();

const pool = new Pool({
  connectionString: cfg.db.url,
  ssl: cfg.db.ssl ? { rejectUnauthorized: false } : false,
  max: Number(process.env.DB_POOL_MAX || 15),
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 8_000,
});

pool.on('error', (err) => {
  console.error('[postgres] idle client error', err);
});

async function query(text, params = []) {
  return pool.query(text, params);
}

async function one(text, params = []) {
  const r = await pool.query(text, params);
  return r.rows[0] || null;
}

async function many(text, params = []) {
  const r = await pool.query(text, params);
  return r.rows;
}

async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const value = await fn(client);
    await client.query('COMMIT');
    return value;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function health() {
  const r = await one('SELECT NOW() AS now');
  return { ok: true, now: r.now };
}

module.exports = { pool, query, one, many, tx, health };
