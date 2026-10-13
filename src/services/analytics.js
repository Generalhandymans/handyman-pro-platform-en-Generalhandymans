'use strict';

function acquisitionPayload(req, extra={}) {
  const q = req.query || {};
  const b = req.body || {};
  const source = b.source || q.utm_source || q.source || 'direct';
  return {
    source: String(source).slice(0,80),
    medium: String(q.utm_medium || b.utm_medium || '').slice(0,80) || null,
    campaign: String(q.utm_campaign || b.utm_campaign || '').slice(0,160) || null,
    content: String(q.utm_content || b.utm_content || '').slice(0,160) || null,
    term: String(q.utm_term || b.utm_term || '').slice(0,160) || null,
    landing_path: String(req.headers.referer || '').slice(0,500) || null,
    ...extra,
  };
}

module.exports = { acquisitionPayload };
