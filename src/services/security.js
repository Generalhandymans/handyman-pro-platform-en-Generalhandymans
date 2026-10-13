'use strict';

const crypto = require('crypto');
const db = require('../db');

function ipPrefix(req) {
  const raw = String(req.ip || req.socket?.remoteAddress || '');
  if (raw.includes('.')) return raw.split('.').slice(0,3).join('.') + '.0/24';
  if (raw.includes(':')) return raw.split(':').slice(0,4).join(':') + '::/64';
  return raw.slice(0,80);
}

async function securityEvent(req, eventType, severity='info', detail='', userId=null) {
  try {
    await db.prepare(
      `INSERT INTO security_events(user_id,event_type,severity,ip_prefix,user_agent,detail)
       VALUES(?,?,?,?,?,?)`
    ).run(
      userId || req.user?.id || null, eventType, severity, ipPrefix(req),
      String(req.headers['user-agent'] || '').slice(0,500),
      String(detail || '').slice(0,2000)
    );
  } catch (_) {}
}

function requestId(req,res,next) {
  const incoming=String(req.headers['x-request-id']||'').trim();
  req.requestId = /^[a-zA-Z0-9._:-]{8,100}$/.test(incoming) ? incoming : crypto.randomUUID();
  res.setHeader('X-Request-Id',req.requestId);
  next();
}

function requireProductionSecrets() {
  if (process.env.NODE_ENV !== 'production') return;
  const required=['JWT_SECRET'];
  const missing=required.filter(k=>!process.env[k] || String(process.env[k]).length<32);
  if(missing.length) throw new Error(`Production security configuration missing/weak: ${missing.join(', ')}`);
}

module.exports = { ipPrefix, securityEvent, requestId, requireProductionSecrets };
