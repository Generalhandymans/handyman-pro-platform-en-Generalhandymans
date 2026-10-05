'use strict';

const REQUIRED_IN_PROD = [
  'DATABASE_URL',
  'JWT_SECRET',
  'PUBLIC_URL',
];

function bool(name, fallback = false) {
  const v = process.env[name];
  if (v == null || v === '') return fallback;
  return /^(1|true|yes|on)$/i.test(v);
}

function validateEnv() {
  const isProd = process.env.NODE_ENV === 'production';
  const missing = isProd ? REQUIRED_IN_PROD.filter(k => !process.env[k]) : [];

  if (missing.length) {
    throw new Error(`Missing production environment variables: ${missing.join(', ')}`);
  }

  if (isProd && process.env.JWT_SECRET && process.env.JWT_SECRET.length < 48) {
    throw new Error('JWT_SECRET must be at least 48 characters in production.');
  }

  if (isProd && process.env.PUBLIC_URL && !/^https:\/\//i.test(process.env.PUBLIC_URL)) {
    throw new Error('PUBLIC_URL must use HTTPS in production.');
  }

  return {
    nodeEnv: process.env.NODE_ENV || 'development',
    port: Number(process.env.PORT || 3000),
    publicUrl: process.env.PUBLIC_URL || 'http://localhost:3000',
    trustProxy: Number(process.env.TRUST_PROXY || 0),
    db: {
      url: process.env.DATABASE_URL || '',
      ssl: bool('DB_SSL', isProd),
    },
    cookie: {
      secure: bool('COOKIE_SECURE', isProd),
      domain: process.env.COOKIE_DOMAIN || undefined,
    },
    ai: {
      enabled: bool('AI_ENABLED', false),
      provider: process.env.AI_PROVIDER || 'openai',
      model: process.env.AI_MODEL || '',
    },
  };
}

module.exports = { validateEnv };
