'use strict';

const db = require('../db');
const mailer = require('./mailer');

async function checkDb() {
  const started = Date.now();
  try {
    const row = await db.prepare('SELECT 1 AS ok').get();
    return { ok: !!row, latency_ms: Date.now() - started };
  } catch (e) {
    return { ok: false, latency_ms: Date.now() - started, error: String(e.message).slice(0,160) };
  }
}

async function readiness() {
  const dbState = await checkDb();
  const checks = {
    database: dbState,
    jwt_secret: { ok: !!process.env.JWT_SECRET && String(process.env.JWT_SECRET).length >= 32 },
    production_database: {
      ok: process.env.NODE_ENV !== 'production' || !!process.env.DATABASE_URL,
      detail: process.env.DATABASE_URL ? 'postgres' : 'sqlite/local'
    },
    mail: {
      ok: process.env.NODE_ENV !== 'production' || mailer.activeProvider() !== 'console',
      provider: mailer.activeProvider()
    },
    stripe: {
      ok: !!process.env.STRIPE_SECRET_KEY && !!process.env.STRIPE_WEBHOOK_SECRET,
      optional: true
    },
    object_storage: {
      ok: !!process.env.S3_BUCKET,
      optional: true
    },
    ai: {
      ok: !!process.env.OPENAI_API_KEY,
      optional: true
    }
  };
  const requiredOk = checks.database.ok && checks.jwt_secret.ok && checks.production_database.ok;
  return { ok: requiredOk, checks };
}

module.exports = { checkDb, readiness };
